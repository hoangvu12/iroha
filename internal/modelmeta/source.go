package modelmeta

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/hosts"
	"github.com/hoangvu12/iroha/internal/logs"
)

var KindModelsDev = logs.NewKind("models_dev", "Iroha read the models.dev catalog (for model metadata), or could not: file, host, outcome (ok, not_modified, failed), models, error.")

const (
	CacheTTL     = 15 * time.Minute // a loaded catalog is used this long before it is read again
	RetryAfter   = time.Minute      // after a failed read, the next waits this long
	FetchTimeout = 10 * time.Second // per URL
	maxFile      = 64 << 20
)

const (
	fileProviders = "api.json"
	fileMakers    = "models.json"
)

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
	files    map[string]*catalogFile
}

type catalogFile struct {
	base, etag   string
	byBrand      map[string]*index
	byMakerModel *index
	byModelPart  *index
}

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
	return &Source{o: o, files: map[string]*catalogFile{}}
}

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
	prev := map[string]*catalogFile{}
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

func (s *Source) load(ctx context.Context, prev map[string]*catalogFile) (map[string]*catalogFile, *Catalog, error) {
	files := map[string]*catalogFile{}
	var errs []string
	for _, name := range []string{fileProviders, fileMakers} {
		f, err := s.read(ctx, name, prev[name])
		if err != nil {
			errs = append(errs, err.Error())
			f = prev[name]
		}
		if f != nil {
			files[name] = f
		}
	}
	if len(errs) == 2 {
		return files, nil, fmt.Errorf("models.dev could not be read: %s", strings.Join(errs, "; "))
	}
	cat := emptyCatalog()
	if f := files[fileProviders]; f != nil {
		cat.byBrand = f.byBrand
	}
	if f := files[fileMakers]; f != nil {
		cat.byMakerModel, cat.byModelPart = f.byMakerModel, f.byModelPart
	}
	return files, cat, nil
}

func (s *Source) read(ctx context.Context, name string, prev *catalogFile) (*catalogFile, error) {
	var last error
	for _, base := range s.o.Bases {
		u := strings.TrimRight(base, "/") + "/" + name
		host := hosts.Of(u)
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
	return nil, last
}

func (s *Source) get(ctx context.Context, u, base, name string, prev *catalogFile) (*catalogFile, bool, error) {
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
	f := &catalogFile{base: base, etag: resp.Header.Get("ETag")}
	switch name {
	case fileProviders:
		f.byBrand, err = parseProviders(body)
	default:
		f.byMakerModel, f.byModelPart, err = parseMakers(body)
	}
	if err != nil {
		return nil, false, fmt.Errorf("not a models.dev catalog: %w", err)
	}
	return f, false, nil
}
