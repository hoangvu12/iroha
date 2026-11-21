package testkit

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

type Logos struct {
	URL string

	mu       sync.Mutex
	favicons map[string][]byte
	makers   map[string][]byte
	status   int
	hits     []string
}

var (
	PNG = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82")
	SVG = []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>`)
)

// models.dev answers 200 with a generic mark for a maker it does not know.
var GenericMark = []byte(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle r="1" cx="1" cy="1"/></svg>`)

func NewLogos(t testing.TB) *Logos {
	l := &Logos{favicons: map[string][]byte{}, makers: map[string][]byte{}}
	srv := httptest.NewServer(http.HandlerFunc(l.serve))
	t.Cleanup(srv.Close)
	l.URL = srv.URL
	return l
}

func (l *Logos) FaviconURL() string { return l.URL + "/favicons?domain={domain}&sz=64" }
func (l *Logos) MakerURL() string   { return l.URL + "/logos/{maker}.svg" }

func (l *Logos) serve(w http.ResponseWriter, r *http.Request) {
	l.mu.Lock()
	l.hits = append(l.hits, r.URL.RequestURI())
	status := l.status
	var body []byte
	switch {
	case r.URL.Path == "/favicons":
		body = l.favicons[r.URL.Query().Get("domain")]
	case strings.HasPrefix(r.URL.Path, "/logos/"):
		body = l.makers[strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/logos/"), ".svg")]
		if body == nil {
			body = GenericMark
		}
	}
	l.mu.Unlock()
	if status != 0 {
		w.WriteHeader(status)
		return
	}
	if body == nil {
		http.NotFound(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/logos/") {
		w.Header().Set("Content-Type", "image/svg+xml")
	} else {
		w.Header().Set("Content-Type", "image/png")
	}
	w.Write(body)
}

func (l *Logos) SetFavicon(domain string, img []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.favicons[domain] = img
}

func (l *Logos) SetMaker(maker string, img []byte) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.makers[maker] = img
}

func (l *Logos) Fail(status int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.status = status
}

func (l *Logos) Hits() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.hits...)
}
