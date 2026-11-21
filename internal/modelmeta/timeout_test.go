package modelmeta_test

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/modelmeta"
)

func TestAHungModelsDevBaseIsGivenUpAfterTheFetchTimeout(t *testing.T) {
	arrived := make(chan string, 4)
	hung := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		arrived <- r.URL.Path
		<-r.Context().Done()
	}))
	defer hung.Close()
	site := newFakeSite(t)
	clk := clock.NewFake(time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	var logged bytes.Buffer
	src := modelmeta.NewSource(modelmeta.SourceOptions{Bases: []string{hung.URL, site.URL}, Clock: clk,
		Log: slog.New(slog.NewJSONHandler(&logged, nil))})

	type result struct {
		cat *modelmeta.Catalog
		err error
	}
	done := make(chan result, 1)
	go func() {
		c, err := src.Catalog(context.Background())
		done <- result{c, err}
	}()
	for _, file := range []string{"/api.json", "/models.json"} {
		if got := <-arrived; got != file {
			t.Fatalf("hung base asked for %s, want %s", got, file)
		}
		clk.Advance(modelmeta.FetchTimeout - time.Millisecond)
		select {
		case <-done:
			t.Fatalf("%s: gave up before the fetch timeout", file)
		default:
		}
		clk.Advance(time.Millisecond)
	}
	r := <-done
	if r.err != nil || r.cat == nil || r.cat.Size() == 0 {
		t.Fatalf("catalog = %v, %v", r.cat, r.err)
	}
	if site.hits.Load() != 2 {
		t.Fatalf("next base hits = %d, want 2", site.hits.Load())
	}
	if n := strings.Count(logged.String(), "no answer within 10s"); n != 2 {
		t.Fatalf("timeouts logged = %d:\n%s", n, logged.String())
	}
}
