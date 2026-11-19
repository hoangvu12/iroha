package server_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/config"
	"github.com/hoangvu12/iroha/internal/server"
)

// These tests drive server.Run, the path a SIGTERM takes in production:
// main cancels Run's context on SIGTERM, and Run drains for at most
// --drain-timeout. The systemd unit's TimeoutStopSec is checked against that
// limit in deploy/unit_test.go.

// slowRoute answers "first" at once, then "done" when release is closed.
// It reports each arrival on entered.
func slowRoute(entered chan<- struct{}, release <-chan struct{}) api.Route {
	return api.Route{
		Method: http.MethodGet, Path: "/test/slow", Auth: api.AuthPublic, Hidden: true,
		Raw: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, "first\n")
			w.(http.Flusher).Flush()
			entered <- struct{}{}
			select {
			case <-release:
				_, _ = io.WriteString(w, "done\n")
			case <-r.Context().Done():
			}
		}),
	}
}

type running struct {
	t       *testing.T
	url     string
	console *lockedBuffer
	stop    context.CancelFunc // what SIGTERM does
	done    chan error         // Run's result
}

func runServer(t *testing.T, drain time.Duration, routes ...api.Route) *running {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	r := &running{t: t, console: &lockedBuffer{}, stop: cancel, done: make(chan error, 1)}
	go func() {
		r.done <- server.Run(ctx, server.Options{
			Config: config.Config{
				DataDir: t.TempDir(), Addr: "127.0.0.1:0", LogLevel: slog.LevelInfo,
				LogFormat: "json", DrainTimeout: drain,
			},
			Version: "test",
			Console: r.console,
			Routes:  routes,
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-r.done:
		case <-time.After(30 * time.Second):
			t.Error("Run did not return")
		}
	})
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if ev := r.event("startup"); ev != nil {
			r.url = "http://" + ev["addr"].(string)
			return r
		}
		select {
		case err := <-r.done:
			t.Fatalf("Run returned before starting: %v\n%s", err, r.console.String())
		case <-time.After(5 * time.Millisecond):
		}
	}
	t.Fatalf("no startup event within 10s:\n%s", r.console.String())
	return nil
}

// event is the last console log line of the given kind.
func (r *running) event(kind string) map[string]any {
	var last map[string]any
	for _, line := range strings.Split(r.console.String(), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil && m["kind"] == kind {
			last = m
		}
	}
	return last
}

func (r *running) waitDone(within time.Duration) error {
	r.t.Helper()
	select {
	case err := <-r.done:
		r.done <- err // keep it for Cleanup
		return err
	case <-time.After(within):
		r.t.Fatalf("Run did not return within %v", within)
		return nil
	}
}

// startSlow sends GET /test/slow on its own connection and returns its
// body reader once the handler is running.
func (r *running) startSlow(entered <-chan struct{}) (*http.Response, *bufio.Reader) {
	r.t.Helper()
	client := &http.Client{Transport: &http.Transport{DisableKeepAlives: true}}
	resp, err := client.Get(r.url + "/test/slow")
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { resp.Body.Close() })
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		r.t.Fatal("slow handler never ran")
	}
	body := bufio.NewReader(resp.Body)
	if line, _ := body.ReadString('\n'); line != "first\n" {
		r.t.Fatalf("first line %q", line)
	}
	return resp, body
}

func TestShutdownLetsInFlightRequestsFinishWithinTheDrainLimit(t *testing.T) {
	entered, release := make(chan struct{}, 1), make(chan struct{})
	srv := runServer(t, 10*time.Second, slowRoute(entered, release))
	resp, body := srv.startSlow(entered)

	srv.stop() // SIGTERM

	// New connections are refused while the in-flight request drains.
	deadline := time.Now().Add(5 * time.Second)
	for {
		r, err := http.Get(srv.url + "/readyz")
		if err != nil {
			break
		}
		r.Body.Close()
		if time.Now().After(deadline) {
			t.Fatal("still accepting new requests after shutdown began")
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case err := <-srv.done:
		t.Fatalf("Run returned (%v) while a request was still in flight", err)
	case <-time.After(300 * time.Millisecond):
	}

	close(release)
	rest, err := io.ReadAll(body)
	if err != nil || string(rest) != "done\n" || resp.StatusCode != 200 {
		t.Fatalf("in-flight request was cut: status %d, rest %q, err %v", resp.StatusCode, rest, err)
	}
	if err := srv.waitDone(5 * time.Second); err != nil {
		t.Fatalf("Run: %v", err)
	}
	sd := srv.event("shutdown")
	if sd == nil || sd["drained"] != true || sd["level"] != "INFO" {
		t.Fatalf("shutdown event = %v", sd)
	}
}

func TestShutdownCutsRequestsThatOutliveTheDrainLimit(t *testing.T) {
	const drain = 400 * time.Millisecond
	entered, release := make(chan struct{}, 1), make(chan struct{}) // never released
	srv := runServer(t, drain, slowRoute(entered, release))
	_, body := srv.startSlow(entered)

	begin := time.Now()
	srv.stop() // SIGTERM
	if err := srv.waitDone(10 * time.Second); err != nil {
		t.Fatalf("Run: %v", err)
	}
	took := time.Since(begin)
	if took < drain || took > drain+3*time.Second {
		t.Fatalf("Run returned after %v, want about the drain limit %v", took, drain)
	}
	if rest, _ := io.ReadAll(body); strings.Contains(string(rest), "done") {
		t.Fatalf("request outlived the drain limit: %q", rest)
	}
	sd := srv.event("shutdown")
	if sd == nil || sd["drained"] != false || sd["level"] != "WARN" {
		t.Fatalf("shutdown event = %v, want a warning with drained false", sd)
	}
}

type lockedBuffer struct {
	mu sync.Mutex
	b  strings.Builder
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}
