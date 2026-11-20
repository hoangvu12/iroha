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
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/config"
	"github.com/hoangvu12/iroha/internal/jobs"
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
	// Jobs are background jobs added to the built-in ones.
	Jobs []jobs.Job
	// ModelsDev is the base URL models.dev metadata is read from, usually
	// a NewModelsDev fake's URL. Default: none, models.dev is never read.
	ModelsDev string
	// Logos is where logos are fetched from, usually a NewLogos fake.
	// Default: none, logos are never fetched.
	Logos *Logos
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
	var modelsDev []string
	if s.opts.ModelsDev != "" {
		modelsDev = []string{s.opts.ModelsDev}
	}
	cfg := config.Config{
		DataDir: s.DataDir, Addr: "127.0.0.1:0", LogLevel: s.opts.LogLevel,
		LogFormat: "json", DrainTimeout: 5 * time.Second, ModelsDev: modelsDev,
	}
	if l := s.opts.Logos; l != nil {
		cfg.LogoFavicons, cfg.LogoMakers = l.FaviconURL(), l.MakerURL()
	}
	app, err := server.New(context.Background(), server.Options{
		Config:     cfg,
		Version:    s.opts.Version,
		Clock:      s.Clock,
		Console:    s.console,
		HTTPClient: s.opts.HTTPClient,
		Jobs:       s.opts.Jobs,
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

// SettleJobs waits (real time, up to 10 s) until no background job is
// running and every job's next run is after the fake clock's now: call it
// after Advance to let the runs that time triggered finish. It returns the
// jobs as GET /api/jobs then reports them.
func (s *Server) SettleJobs() []jobs.JobView {
	s.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	read := func() (jobs.JobList, bool) {
		var list jobs.JobList
		s.Admin.Get("/api/jobs").Expect(http.StatusOK).JSON(&list)
		for _, j := range list.Jobs {
			if j.Running || j.NextRunAt == nil || !j.NextRunAt.After(s.Clock.Now()) {
				return list, false
			}
		}
		return list, true
	}
	for {
		list, settled := read()
		if settled {
			// Read again a moment later: a goroutine woken by the last
			// timer may not have marked its job running yet.
			time.Sleep(10 * time.Millisecond)
			again, still := read()
			if still && reflect.DeepEqual(list, again) {
				return list.Jobs
			}
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("background jobs did not settle within 10s: %+v", list.Jobs)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// RunJob runs a background job now through POST /api/jobs/{job}/run and
// returns the run. Pass query "dry_run=true" for a dry run.
func (s *Server) RunJob(name string, query ...string) jobs.Run {
	s.t.Helper()
	path := "/api/jobs/" + name + "/run"
	if len(query) > 0 {
		path += "?" + query[0]
	}
	var run jobs.Run
	s.Admin.Post(path, nil).Expect(http.StatusOK).JSON(&run)
	return run
}

// NewAdminToken creates an Admin Token named name through the admin API
// (as the bootstrap token) and returns a client that sends it. Its Token
// field is the secret.
func (s *Server) NewAdminToken(name string) *Client {
	s.t.Helper()
	var out struct {
		AdminToken struct {
			Secret string `json:"secret"`
		} `json:"admin_token"`
	}
	s.Admin.Post("/api/admin-tokens", map[string]any{"name": name}).OK().JSON(&out)
	if out.AdminToken.Secret == "" {
		s.t.Fatalf("creating Admin Token %q returned no secret", name)
	}
	return s.Client(out.AdminToken.Secret)
}

// OwnerPassword is the password OwnerSession sets.
const OwnerPassword = "test-owner-password"

// OwnerSession signs in as the Owner, as the UI does, and returns a client
// that sends the session cookie. It first sets the Owner password to
// OwnerPassword (as the bootstrap Admin Token) when none is set. Changes it
// makes are recorded with the actor "Owner".
func (s *Server) OwnerSession() *Client {
	s.t.Helper()
	var st struct {
		PasswordSet bool `json:"password_set"`
	}
	s.Anon.Get("/api/session").Expect(http.StatusOK).JSON(&st)
	if !st.PasswordSet {
		s.Admin.Put("/api/owner-password", map[string]any{"password": OwnerPassword}).OK()
	}
	resp := s.Anon.Post("/api/session", map[string]any{"password": OwnerPassword}).Expect(http.StatusCreated)
	ck := resp.Cookie("iroha_session")
	if ck == nil {
		s.t.Fatalf("sign-in set no iroha_session cookie; headers %v", resp.Header)
	}
	return (&Client{t: s.t, srv: s}).WithCookie(ck)
}

// Client returns a client sending "Authorization: Bearer token" (none when
// token is empty).
func (s *Server) Client(token string) *Client {
	return &Client{t: s.t, srv: s, Token: token}
}

// NoConversationIDs sets send_prompt_cache_key off on every Endpoint of
// Provider handle, so its passthrough Requests get no prompt_cache_key
// (prompt caching 04). For tests of the Failure Rules: a 400 is then judged
// alone, without the free retry that drops Iroha's addition.
func (s *Server) NoConversationIDs(handle string) {
	s.t.Helper()
	var list struct {
		Endpoints []struct{ Name string }
	}
	s.Admin.Get("/api/providers/" + handle + "/endpoints").OK().JSON(&list)
	for _, e := range list.Endpoints {
		s.Admin.Patch("/api/providers/"+handle+"/endpoints/"+e.Name, map[string]any{"send_prompt_cache_key": "off"}).Expect(200)
	}
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
