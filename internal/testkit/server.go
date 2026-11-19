// Package testkit runs Iroha in-process for tests: a real server on a
// temporary SQLite file with a fake clock, HTTP clients for admins and
// Callers, and programmable fake upstream Providers per Shape.
//
//	srv := testkit.Start(t)
//	srv.Admin.Get("/api/logs?kind=startup").OK().JSON(&page)
//	srv.Clock.Advance(time.Hour)
//
// Tests drive Iroha only through HTTP; see docs/agents/architecture.md.
package testkit

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/config"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/server"
)

// Epoch is the default start of the fake clock.
var Epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

// Options tune Start. The zero value is right for most tests.
type Options struct {
	DataDir  string      // default: a fresh t.TempDir()
	Clock    *clock.Fake // default: a new Fake at Epoch
	Version  string      // default "test"
	LogLevel slog.Level  // default info, as in production
	// HTTPClient makes Iroha's outbound calls; default a plain client.
	HTTPClient *http.Client
}

// Server is a running in-process Iroha.
type Server struct {
	t    testing.TB
	opts Options

	// URL is the base URL, e.g. http://127.0.0.1:51234. It changes on Restart.
	URL     string
	DataDir string
	Clock   *clock.Fake
	App     *server.Server
	// AdminToken is the bootstrap Admin Token secret from the first start.
	AdminToken string
	// Admin sends requests with AdminToken; Anon sends no credentials.
	Admin *Client
	Anon  *Client

	console  *syncBuffer
	serveErr chan error
	running  bool
	// transport carries every test client request, so Stop can close its
	// idle connections; otherwise a spare connection the transport dialled
	// but never used holds Shutdown for 5 s.
	transport *http.Transport
	http      *http.Client
}

// Start runs Iroha and stops it when the test ends.
func Start(t testing.TB, opts ...Options) *Server {
	t.Helper()
	var o Options
	if len(opts) > 0 {
		o = opts[0]
	}
	if o.DataDir == "" {
		o.DataDir = t.TempDir()
	}
	if o.Clock == nil {
		o.Clock = clock.NewFake(Epoch)
	}
	if o.Version == "" {
		o.Version = "test"
	}
	s := &Server{t: t, opts: o, DataDir: o.DataDir, Clock: o.Clock}
	s.transport = http.DefaultTransport.(*http.Transport).Clone()
	s.http = &http.Client{Transport: s.transport}
	s.Admin = &Client{t: t, srv: s}
	s.Anon = &Client{t: t, srv: s}
	s.start()
	if tok := s.App.BootstrapToken(); tok.Secret != "" {
		s.AdminToken = tok.Secret
	}
	s.Admin.Token = s.AdminToken
	t.Cleanup(s.Stop)
	return s
}

func (s *Server) start() {
	s.t.Helper()
	s.console = &syncBuffer{}
	app, err := server.New(context.Background(), server.Options{
		Config: config.Config{
			DataDir: s.DataDir, Addr: "127.0.0.1:0", LogLevel: s.opts.LogLevel,
			LogFormat: "json", DrainTimeout: 5 * time.Second,
		},
		Version:    s.opts.Version,
		Clock:      s.Clock,
		Console:    s.console,
		HTTPClient: s.opts.HTTPClient,
	})
	if err != nil {
		s.t.Fatalf("start Iroha: %v", err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		s.t.Fatalf("listen: %v", err)
	}
	s.App = app
	s.URL = "http://" + ln.Addr().String()
	s.serveErr = make(chan error, 1)
	go func() { s.serveErr <- app.Serve(ln) }()
	s.running = true
	s.waitReady()
}

func (s *Server) waitReady() {
	s.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := s.http.Get(s.URL + "/readyz")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(5 * time.Millisecond)
	}
	s.t.Fatalf("Iroha did not become ready within 10s; console:\n%s", s.console.String())
}

// Stop shuts Iroha down, draining in-flight requests for up to 5 s (real
// time). It is called automatically when the test ends.
func (s *Server) Stop() {
	s.StopWithin(5 * time.Second)
}

// StopWithin shuts Iroha down, draining for at most d.
func (s *Server) StopWithin(d time.Duration) {
	if !s.running {
		return
	}
	s.running = false
	s.transport.CloseIdleConnections()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	if err := s.App.Shutdown(ctx, "test stop"); err != nil {
		s.t.Errorf("shutdown: %v", err)
	}
	if err := <-s.serveErr; err != nil {
		s.t.Errorf("serve: %v", err)
	}
}

// Restart stops Iroha and starts it again on the same data directory and
// clock, as a deploy would. URL changes; clients follow it.
func (s *Server) Restart() {
	s.t.Helper()
	s.Stop()
	s.start()
}

// Console is everything this run of Iroha printed (JSON log lines and the
// bootstrap token notice).
func (s *Server) Console() string { return s.console.String() }

// Logs reads GET /api/logs?<query> as the bootstrap Admin Token and returns
// the events, newest first. Example: srv.Logs("kind=startup&level=info").
func (s *Server) Logs(query string) []logs.Event {
	s.t.Helper()
	var page logs.Page
	s.Admin.Get("/api/logs?" + query).Expect(http.StatusOK).JSON(&page)
	return page.Events
}

// Client returns a client sending "Authorization: Bearer token" (none when
// token is empty).
func (s *Server) Client(token string) *Client {
	return &Client{t: s.t, srv: s, Token: token}
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

// Lines splits text into non-empty lines.
func Lines(text string) []string {
	var out []string
	for _, l := range strings.Split(text, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}
