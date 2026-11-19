// Package logos resolves the logos the UI shows: a Provider's from its logo
// domain (a site's favicon), a Model Pool's from its model's maker (the
// maker's mark on models.dev, else the favicon of the maker's site). Iroha
// fetches and caches them and serves them from its own URLs, so the browser
// never loads a third-party image. Where the images come from is two URL
// templates (config --logo-favicons, --logo-makers), so tests point them at
// a fake.
package logos

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/logs"
)

// KindLogo is the log event of a logo fetch that failed.
var KindLogo = logs.NewKind("logo", "Iroha could not fetch a logo (Provider favicon or model maker mark): key, url, error. The UI shows a lettered tile instead.")

// Cache timings and limits.
const (
	HitTTL       = 24 * time.Hour   // a fetched logo is served this long before it is fetched again
	MissTTL      = time.Minute      // a failed lookup is not retried for this long
	FetchTimeout = 10 * time.Second // per URL
	maxImage     = 512 << 10
	maxEntries   = 512
)

// Options are a Service's dependencies.
type Options struct {
	// FaviconURL is the URL template a domain's favicon is read from,
	// with {domain} in it; "" never reads favicons.
	FaviconURL string
	// MakerURL is the URL template a model maker's mark is read from, with
	// {maker} in it (models.dev: https://models.dev/logos/{maker}.svg); ""
	// never reads them. A maker without a mark there falls back to the
	// favicon of its site (Makers).
	MakerURL   string
	HTTPClient *http.Client
	Clock      clock.Clock
	Log        *slog.Logger
	// Dir keeps fetched logos across restarts; "" keeps them in memory only.
	Dir string
}

// Image is one logo.
type Image struct {
	Type string
	Body []byte
}

// Service fetches and caches logos. One fetch per key at a time; others
// asking meanwhile wait for it.
type Service struct {
	o Options

	mu       sync.Mutex
	entries  map[string]*entry
	inflight map[string]chan struct{}
	generic  *string // hash of the maker source's placeholder for unknown makers ("" when it has none)
}

type entry struct {
	img     *Image // nil: a miss
	expires time.Time
}

// New returns a Service.
func New(o Options) *Service {
	if o.HTTPClient == nil {
		o.HTTPClient = &http.Client{}
	}
	if o.Clock == nil {
		o.Clock = clock.Real{}
	}
	if o.Log == nil {
		o.Log = slog.New(slog.DiscardHandler)
	}
	return &Service{o: o, entries: map[string]*entry{}, inflight: map[string]chan struct{}{}}
}

// Domain returns the logo of a site (its favicon); nil when there is none.
// domain must be normalised (NormalizeDomain).
func (s *Service) Domain(ctx context.Context, domain string) (*Image, error) {
	if domain == "" || s.o.FaviconURL == "" {
		return nil, nil
	}
	return s.cached(ctx, "domain-"+domain, func(ctx context.Context) (*Image, error) {
		return s.fetch(ctx, strings.ReplaceAll(s.o.FaviconURL, "{domain}", url.QueryEscape(domain)))
	})
}

// Maker returns the logo of a model maker (anthropic, zhipuai...): its mark
// from the maker source, else the favicon of its site; nil when neither.
func (s *Service) Maker(ctx context.Context, maker string) (*Image, error) {
	maker = strings.ToLower(strings.TrimSpace(maker))
	if !makerPattern.MatchString(maker) {
		return nil, nil
	}
	img, err := s.cached(ctx, "maker-"+maker, func(ctx context.Context) (*Image, error) {
		if s.o.MakerURL == "" {
			return nil, nil
		}
		img, err := s.fetch(ctx, strings.ReplaceAll(s.o.MakerURL, "{maker}", url.PathEscape(maker)))
		if err != nil || img == nil {
			return nil, err
		}
		if generic, err := s.genericHash(ctx); err == nil && generic != "" && hash(img.Body) == generic {
			return nil, nil // the source's placeholder for makers it does not know
		}
		return img, nil
	})
	if img != nil || err != nil {
		return img, err
	}
	if d := Makers[maker]; d != "" {
		return s.Domain(ctx, d)
	}
	return nil, nil
}

// unknownMaker is a maker no source knows, read once to learn what the maker
// source answers for one (models.dev sends a generic mark with 200).
const unknownMaker = "iroha-unknown-maker"

func (s *Service) genericHash(ctx context.Context) (string, error) {
	s.mu.Lock()
	if s.generic != nil {
		g := *s.generic
		s.mu.Unlock()
		return g, nil
	}
	s.mu.Unlock()
	img, err := s.cached(ctx, "maker-"+unknownMaker, func(ctx context.Context) (*Image, error) {
		return s.fetch(ctx, strings.ReplaceAll(s.o.MakerURL, "{maker}", unknownMaker))
	})
	if err != nil {
		return "", err
	}
	g := ""
	if img != nil {
		g = hash(img.Body)
	}
	s.mu.Lock()
	s.generic = &g
	s.mu.Unlock()
	return g, nil
}

func hash(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// cached answers key from memory, then disk, then load, one load per key at
// a time. A load error is logged and cached as a miss.
func (s *Service) cached(ctx context.Context, key string, load func(context.Context) (*Image, error)) (*Image, error) {
	for {
		s.mu.Lock()
		now := s.o.Clock.Now()
		if e, ok := s.entries[key]; ok && now.Before(e.expires) {
			s.mu.Unlock()
			return e.img, nil
		}
		if ch, ok := s.inflight[key]; ok {
			s.mu.Unlock()
			select {
			case <-ch:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		ch := make(chan struct{})
		s.inflight[key] = ch
		s.mu.Unlock()

		img, expires := s.resolve(ctx, key, load)
		s.mu.Lock()
		delete(s.inflight, key)
		close(ch)
		if len(s.entries) >= maxEntries {
			s.evict()
		}
		s.entries[key] = &entry{img: img, expires: expires}
		s.mu.Unlock()
		return img, nil
	}
}

// resolve reads key from disk when fresh, else loads it; a failed load
// keeps a stale disk copy.
func (s *Service) resolve(ctx context.Context, key string, load func(context.Context) (*Image, error)) (*Image, time.Time) {
	now := s.o.Clock.Now()
	disk, fetched := s.readDisk(key)
	if disk != nil && now.Before(fetched.Add(HitTTL)) {
		return disk, fetched.Add(HitTTL)
	}
	img, err := load(ctx)
	if err != nil {
		s.o.Log.Warn("logo fetch failed", logs.Kind(KindLogo), "key", key, "error", err.Error())
	}
	if img == nil {
		if disk != nil {
			return disk, now.Add(MissTTL)
		}
		return nil, now.Add(MissTTL)
	}
	s.writeDisk(key, img, now)
	return img, now.Add(HitTTL)
}

// evict drops expired entries, or every entry when none has expired.
func (s *Service) evict() {
	now := s.o.Clock.Now()
	for k, e := range s.entries {
		if !now.Before(e.expires) {
			delete(s.entries, k)
		}
	}
	if len(s.entries) >= maxEntries {
		clear(s.entries)
	}
}

// fetch reads one image; nil when the source has none (non-2xx, not an image).
func (s *Service) fetch(ctx context.Context, u string) (*Image, error) {
	ctx, cancel := clock.WithTimeout(ctx, s.o.Clock, FetchTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "image/*")
	resp, err := s.o.HTTPClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", host(u), err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return nil, nil
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxImage+1))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", host(u), err)
	}
	if len(body) == 0 || len(body) > maxImage {
		return nil, nil
	}
	typ := imageType(resp.Header.Get("Content-Type"), body)
	if typ == "" {
		return nil, nil
	}
	return &Image{Type: typ, Body: body}, nil
}

func host(u string) string {
	if p, err := url.Parse(u); err == nil {
		return p.Host
	}
	return "logo source"
}

// imageType is the type to serve body as; "" when it is not an image the UI
// can show.
func imageType(header string, body []byte) string {
	if bytes.Contains(bytes.ToLower(body[:min(len(body), 512)]), []byte("<svg")) {
		return "image/svg+xml"
	}
	switch t := http.DetectContentType(body); t {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon", "image/bmp":
		return t
	}
	if strings.HasPrefix(strings.ToLower(header), "image/x-icon") || strings.HasPrefix(strings.ToLower(header), "image/vnd.microsoft.icon") {
		return "image/x-icon"
	}
	return ""
}

// Disk cache: <Dir>/<key>.img and <key>.json ({"type", "fetched_at"}).

type meta struct {
	Type      string `json:"type"`
	FetchedAt int64  `json:"fetched_at"`
}

var unsafeChars = regexp.MustCompile(`[^a-z0-9.-]`)

func (s *Service) path(key string) string {
	return filepath.Join(s.o.Dir, unsafeChars.ReplaceAllString(key, "_"))
}

func (s *Service) readDisk(key string) (*Image, time.Time) {
	if s.o.Dir == "" {
		return nil, time.Time{}
	}
	p := s.path(key)
	mb, err := os.ReadFile(p + ".json")
	if err != nil {
		return nil, time.Time{}
	}
	var m meta
	if json.Unmarshal(mb, &m) != nil || m.Type == "" {
		return nil, time.Time{}
	}
	body, err := os.ReadFile(p + ".img")
	if err != nil || len(body) == 0 {
		return nil, time.Time{}
	}
	return &Image{Type: m.Type, Body: body}, time.UnixMilli(m.FetchedAt)
}

func (s *Service) writeDisk(key string, img *Image, at time.Time) {
	if s.o.Dir == "" {
		return
	}
	if err := os.MkdirAll(s.o.Dir, 0o700); err != nil {
		s.o.Log.Warn("logo cache not writable", logs.Kind(KindLogo), "key", key, "error", err.Error())
		return
	}
	p := s.path(key)
	mb, _ := json.Marshal(meta{Type: img.Type, FetchedAt: at.UnixMilli()})
	if err := os.WriteFile(p+".img", img.Body, 0o600); err != nil {
		return
	}
	_ = os.WriteFile(p+".json", mb, 0o600)
}

// Makers maps model makers to their site, whose favicon stands in when the
// maker source has no mark for them.
var Makers = map[string]string{
	"anthropic":  "anthropic.com",
	"openai":     "openai.com",
	"google":     "gemini.google.com",
	"meta":       "meta.com",
	"alibaba":    "qwen.ai",
	"deepseek":   "deepseek.com",
	"zhipuai":    "z.ai",
	"zai":        "z.ai",
	"moonshotai": "moonshot.ai",
	"mistral":    "mistral.ai",
	"xai":        "x.ai",
	"minimax":    "minimax.io",
	"cohere":     "cohere.com",
	"baidu":      "baidu.com",
	"tencent":    "tencent.com",
	"bytedance":  "bytedance.com",
	"microsoft":  "microsoft.com",
	"nvidia":     "nvidia.com",
	"stepfun":    "stepfun.com",
	"01-ai":      "01.ai",
	"xiaomi":     "mi.com",
}

var makerPattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)

// CheckMaker reports whether maker can name a model maker.
func CheckMaker(maker string) bool { return len(maker) <= 64 && makerPattern.MatchString(maker) }

var labelPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)

// ErrBadDomain is returned by NormalizeDomain for input that is not a domain.
var ErrBadDomain = errors.New("not a domain")

// NormalizeDomain reads a domain from what the Owner typed: a bare host or
// a URL ("https://www.Example.com/path" -> "www.example.com"). It refuses IP
// addresses, single labels and anything with a port or credentials left in.
func NormalizeDomain(s string) (string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.IndexAny(s, "/?#"); i >= 0 {
		s = s[:i]
	}
	if strings.Contains(s, "@") {
		return "", ErrBadDomain
	}
	if h, _, err := net.SplitHostPort(s); err == nil {
		s = h
	}
	s = strings.TrimSuffix(s, ".")
	if s == "" || len(s) > 253 || net.ParseIP(s) != nil {
		return "", ErrBadDomain
	}
	labels := strings.Split(s, ".")
	if len(labels) < 2 {
		return "", ErrBadDomain
	}
	for _, l := range labels {
		if !labelPattern.MatchString(l) {
			return "", ErrBadDomain
		}
	}
	return s, nil
}

// secondLevel are second-level labels under which registrations sit one
// level deeper (example.co.uk, example.com.cn).
var secondLevel = map[string]bool{"co": true, "com": true, "net": true, "org": true, "gov": true, "edu": true, "ac": true}

// SiteOf guesses the site behind an Endpoint URL, for a Provider whose
// Owner set no logo domain: the registrable part of its host
// (api.openai.com -> openai.com, dashscope-intl.aliyuncs.com -> aliyuncs.com).
// "" for IP addresses, localhost and anything unreadable.
func SiteOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	d, err := NormalizeDomain(u.Hostname())
	if err != nil {
		return ""
	}
	labels := strings.Split(d, ".")
	n := 2
	if len(labels) >= 3 && len(labels[len(labels)-1]) == 2 && secondLevel[labels[len(labels)-2]] {
		n = 3
	}
	if len(labels) > n {
		labels = labels[len(labels)-n:]
	}
	return strings.Join(labels, ".")
}
