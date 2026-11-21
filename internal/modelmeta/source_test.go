package modelmeta_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/modelmeta"
)

type fakeSite struct {
	*httptest.Server
	status atomic.Int32
	hits   atomic.Int32
	hold   chan struct{}
	mu     sync.Mutex
	paths  []string
	inm    []string
}

func newFakeSite(t *testing.T) *fakeSite {
	f := &fakeSite{}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		f.mu.Lock()
		f.paths = append(f.paths, r.URL.Path)
		f.inm = append(f.inm, r.Header.Get("If-None-Match"))
		hold := f.hold
		f.mu.Unlock()
		if hold != nil {
			<-hold
		}
		if s := f.status.Load(); s != 0 {
			w.WriteHeader(int(s))
			return
		}
		if r.Header.Get("If-None-Match") == `"v1"` {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		w.Header().Set("ETag", `"v1"`)
		switch r.URL.Path {
		case "/api.json":
			w.Write([]byte(providersJSON))
		case "/models.json":
			w.Write([]byte(makersJSON))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func TestSourceCachesSharesOneReadAndFallsBackToTheMirror(t *testing.T) {
	site := newFakeSite(t)
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(503) }))
	defer down.Close()
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	src := modelmeta.NewSource(modelmeta.SourceOptions{Bases: []string{down.URL, site.URL}, Clock: clk})

	site.hold = make(chan struct{})
	var wg sync.WaitGroup
	cats := make([]*modelmeta.Catalog, 5)
	for i := range cats {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := src.Catalog(context.Background())
			if err != nil {
				t.Error(err)
			}
			cats[i] = c
		}()
	}
	for site.hits.Load() < 1 {
		time.Sleep(time.Millisecond)
	}
	site.mu.Lock()
	close(site.hold)
	site.hold = nil
	site.mu.Unlock()
	wg.Wait()
	if site.hits.Load() != 2 {
		t.Fatalf("site hits = %d, want 2", site.hits.Load())
	}
	for _, c := range cats {
		if c != cats[0] || c.Size() == 0 {
			t.Fatalf("callers got different or empty catalogs")
		}
	}
	if got := js(cats[0].Lookup("zai-coding-plan", "glm-4.6")); got == `{}` {
		t.Fatal("catalog from the mirror lacks api.json")
	}

	clk.Advance(modelmeta.CacheTTL - time.Second)
	if c, err := src.Catalog(context.Background()); err != nil || c != cats[0] || site.hits.Load() != 2 {
		t.Fatalf("cached read: %v, hits %d", err, site.hits.Load())
	}

	clk.Advance(2 * time.Second)
	if c, err := src.Catalog(context.Background()); err != nil || c.Size() != cats[0].Size() || site.hits.Load() != 4 {
		t.Fatalf("revalidation: %v, hits %d", err, site.hits.Load())
	}
	site.mu.Lock()
	inm := site.inm[2:]
	site.mu.Unlock()
	if inm[0] != `"v1"` || inm[1] != `"v1"` {
		t.Fatalf("If-None-Match sent = %q", inm)
	}
}

func TestSourceOutageKeepsThePreviousCatalogAndWaitsBeforeRetrying(t *testing.T) {
	site := newFakeSite(t)
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	src := modelmeta.NewSource(modelmeta.SourceOptions{Bases: []string{site.URL}, Clock: clk})

	site.status.Store(503)
	if c, err := src.Catalog(context.Background()); c != nil || err == nil {
		t.Fatalf("outage before any read = %v, %v", c, err)
	}
	hits := site.hits.Load()
	if _, err := src.Catalog(context.Background()); err == nil || site.hits.Load() != hits {
		t.Fatalf("retried at once: hits %d -> %d", hits, site.hits.Load())
	}
	clk.Advance(modelmeta.RetryAfter)
	site.status.Store(0)
	first, err := src.Catalog(context.Background())
	if err != nil || first == nil {
		t.Fatalf("read after the outage: %v", err)
	}

	clk.Advance(modelmeta.CacheTTL)
	site.status.Store(500)
	if c, err := src.Catalog(context.Background()); c != first || err == nil {
		t.Fatalf("stale catalog during an outage = %v, %v", c, err)
	}
}

func TestSourceOffReadsNothing(t *testing.T) {
	src := modelmeta.NewSource(modelmeta.SourceOptions{})
	if c, err := src.Catalog(context.Background()); c != nil || err != nil || src.Enabled() {
		t.Fatalf("off source = %v, %v", c, err)
	}
}
