package modelmeta

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/logs"
)

// KindModelsDev is the log event of a models.dev catalog read.
var KindModelsDev = logs.NewKind("models_dev", "Iroha read the models.dev catalog (for model metadata), or could not: file, host, outcome (ok, not_modified, failed), models, error.")

// Source timings and limits.
const (
	CacheTTL     = 15 * time.Minute // a loaded catalog is used this long before it is read again
	RetryAfter   = time.Minute      // after a failed read, the next waits this long
	FetchTimeout = 10 * time.Second // per URL
	maxFile      = 64 << 20
)

// The two models.dev files.
const (
	fileProviders = "api.json"
	fileMakers    = "models.json"
)

// SourceOptions are a Source's dependencies.
type SourceOptions struct {
	// Bases are base URLs serving api.json and models.json, tried in order
	// per file. None: models.dev is never read (Catalog returns nil).
	Bases      []string
	HTTPClient *http.Client
	Clock      clock.Clock
	Log        *slog.Logger
}

// Source reads models.dev and keeps the catalog in memory: one read at a
// time (concurrent callers wait for it), reused for CacheTTL, re-read with
// If-None-Match. A failed read keeps the previous catalog and is not
// retried for RetryAfter.
type Source struct {
	o SourceOptions

	mu       sync.Mutex
	cat      *Catalog
	loadedAt time.Time
	failedAt time.Time
	lastErr  error
	loading  chan struct{}
	files    map[string]*file
}

// file is the last good read of one models.dev file, parsed.
type file struct {
	base, etag    string
	brands        map[string]*index // api.json
	makers, plain *index            // models.json
}

// NewSource returns a Source.
func NewSource(o SourceOptions) *Source {
	if o.HTTPClient == nil {
		o.HTTPClient = &http.Client{}
	}
	if o.Clock == nil {
		o.Clock = clock.Real{}
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	return &Source{o: o, files: map[string]*file{}}
}

// Enabled reports whether models.dev is read at all.
func (s *Source) Enabled() bool { return s != nil && len(s.o.Bases) > 0 }

// Catalog returns the catalog, reading models.dev when the cached one is
// older than CacheTTL. On failure it returns the previous catalog (nil when
// none was ever read) with the error. nil, nil when the Source is off.
func (s *Source) Catalog(ctx context.Context) (*Catalog, error) {
	if !s.Enabled() {
		return nil, nil
	}
	s.mu.Lock()
	for {
		now := s.o.Clock.Now()
		if s.cat != nil && now.Sub(s.loadedAt) < CacheTTL {
			cat := s.cat
			s.mu.Unlock()
			return cat, nil
		}
		if !s.failedAt.IsZero() && now.Sub(s.failedAt) < RetryAfter {
			cat, err := s.cat, s.lastErr
			s.mu.Unlock()
			return cat, err
		}
		if s.loading == nil {
			break
		}
		ch := s.loading
		s.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			s.mu.Lock()
			cat := s.cat
			s.mu.Unlock()
			return cat, ctx.Err()
		}
		s.mu.Lock()
	}
	ch := make(chan struct{})
	s.loading = ch
	prev := map[string]*file{}
	for k, v := range s.files {
		prev[k] = v
	}
	s.mu.Unlock()

	files, cat, err := s.load(context.WithoutCancel(ctx), prev)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.loading = nil
	close(ch)
	s.files = files
	now := s.o.Clock.Now()
	if err != nil {
		s.failedAt, s.lastErr = now, err
		return s.cat, err
	}
	s.cat, s.loadedAt, s.failedAt, s.lastErr = cat, now, time.Time{}, nil
	return cat, nil
}

// load reads both files (each from the first base that answers) and builds
// the catalog. A file that cannot be read now keeps its previous read. It
// fails when neither file could be read now (the caller keeps the previous
// catalog).
func (s *Source) load(ctx context.Context, prev map[string]*file) (map[string]*file, *Catalog, error) {
	files := map[string]*file{}
	var errs []string
	for _, name := range []string{fileProviders, fileMakers} {
		f, err := s.read(ctx, name, prev[name])
		if err != nil {
			errs = append(errs, err.Error())
		}
		if f != nil {
			files[name] = f
		}
	}
	if len(errs) == 2 {
		return files, nil, fmt.Errorf("models.dev could not be read: %s", strings.Join(errs, "; "))
	}
	cat := &Catalog{brands: map[string]*index{}, makers: newIndex(), plain: newIndex()}
	if f := files[fileProviders]; f != nil {
		cat.brands = f.brands
	}
	if f := files[fileMakers]; f != nil {
		cat.makers, cat.plain = f.makers, f.plain
	}
	return files, cat, nil
}

// read reads one file from the first base that answers with a usable body
// (or 304 for the body it has). On failure it returns prev with the error.
func (s *Source) read(ctx context.Context, name string, prev *file) (*file, error) {
	var last error
	for _, base := range s.o.Bases {
		u := strings.TrimRight(base, "/") + "/" + name
		host := hostOf(u)
		f, notModified, err := s.get(ctx, u, base, name, prev)
		if err != nil {
			last = fmt.Errorf("%s from %s: %w", name, host, err)
			s.o.Log.Warn("models.dev file could not be read", logs.Kind(KindModelsDev), "file", name, "host", host, "outcome", "failed", "error", err.Error())
			continue
		}
		outcome := "ok"
		if notModified {
			outcome = "not_modified"
		}
		s.o.Log.Info("models.dev file read", logs.Kind(KindModelsDev), "file", name, "host", host, "outcome", outcome)
		return f, nil
	}
	return prev, last
}

func (s *Source) get(ctx context.Context, u, base, name string, prev *file) (*file, bool, error) {
	ctx, cancel := clock.WithTimeout(ctx, s.o.Clock, FetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Accept", "application/json")
	if prev != nil && prev.base == base && prev.etag != "" {
		req.Header.Set("If-None-Match", prev.etag)
	}
	resp, err := s.o.HTTPClient.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, fmt.Errorf("no answer within %s", FetchTimeout)
		}
		return nil, false, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotModified && prev != nil && prev.base == base {
		return prev, true, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, false, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFile+1))
	if err != nil {
		return nil, false, err
	}
	if len(body) > maxFile {
		return nil, false, fmt.Errorf("larger than %d MiB", maxFile>>20)
	}
	// A body that does not parse falls through to the next base.
	f := &file{base: base, etag: resp.Header.Get("ETag")}
	switch name {
	case fileProviders:
		f.brands, err = parseProviders(body)
	default:
		f.makers, f.plain, err = parseMakers(body)
	}
	if err != nil {
		return nil, false, fmt.Errorf("not a models.dev catalog: %w", err)
	}
	return f, false, nil
}

func hostOf(u string) string {
	p, err := url.Parse(u)
	if err != nil {
		return ""
	}
	return p.Host
}
