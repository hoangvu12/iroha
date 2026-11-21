package testkit

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"slices"
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

var Epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

type Options struct {
	DataDir    string
	Clock      *clock.Fake
	Version    string
	LogLevel   slog.Level
	HTTPClient *http.Client
	Jobs       []jobs.Job
	ModelsDev  string
	Logos      *Logos
}

type Server struct {
	t    testing.TB
	opts Options

	URL        string
	DataDir    string
	Clock      *clock.Fake
	App        *server.Server
	AdminToken string
	Admin      *Client
	Anon       *Client

	console  *syncBuffer
	serveErr chan error
	running  bool
	// Stop closes the transport's idle connections: net/http's Shutdown
	// waits up to 5 s for a dialled but unused connection (golang/go#22682).
	transport *http.Transport
	http      *http.Client
}

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

func (s *Server) Stop() {
	s.StopWithin(5 * time.Second)
}

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

func (s *Server) Restart() {
	s.t.Helper()
	s.Stop()
	s.start()
}

func (s *Server) Console() string { return s.console.String() }

func (s *Server) Logs(query string) []logs.Event {
	s.t.Helper()
	var page logs.Page
	s.Admin.Get("/api/logs?" + query).Expect(http.StatusOK).JSON(&page)
	return page.Events
}

func (s *Server) SettleJobs() []jobs.JobView {
	s.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var list jobs.JobList
		s.Admin.Get("/api/jobs").Expect(http.StatusOK).JSON(&list)
		if !slices.ContainsFunc(list.Jobs, func(j jobs.JobView) bool { return j.Running }) {
			return list.Jobs
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("background jobs did not settle within 10s: %+v", list.Jobs)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

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

const OwnerPassword = "test-owner-password"

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

func (s *Server) Client(token string) *Client {
	return &Client{t: s.t, srv: s, Token: token}
}

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

func Lines(text string) []string {
	var out []string
	for _, l := range strings.Split(text, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	return out
}
