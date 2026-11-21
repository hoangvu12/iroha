package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hoangvu12/iroha/internal/admintokens"
	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/config"
	"github.com/hoangvu12/iroha/internal/failurerules"
	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/jobs"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/modelrefresh"
	"github.com/hoangvu12/iroha/internal/models"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/retention"
	"github.com/hoangvu12/iroha/internal/session"
	"github.com/hoangvu12/iroha/internal/store"
	"github.com/hoangvu12/iroha/internal/webui"
)

type Options struct {
	Config     config.Config
	Version    string
	Clock      clock.Clock
	Console    io.Writer
	HTTPClient *http.Client
	Routes     []api.Route
	Jobs       []jobs.Job
}

type Server struct {
	opts    Options
	clock   clock.Clock
	db      *store.DB
	logs    *logs.Log
	log     *slog.Logger
	router  *api.Router
	tokens  *admintokens.Store
	owner   *session.Store
	audit   *audit.Trail
	jobs    *jobs.Runner
	httpc   *http.Client
	gw      *gateway.Gateway
	rules   *failurerules.Store
	started time.Time

	recorder *requests.Recorder

	modelStore *models.Store
	refresh    *modelrefresh.Scheduler

	migrations store.MigrationResult
	bootstrap  admintokens.Token

	httpSrv   *http.Server
	ready     atomic.Bool
	closeOnce sync.Once
	closeErr  error
}

func New(ctx context.Context, o Options) (*Server, error) {
	if o.Clock == nil {
		o.Clock = clock.Real{}
	}
	if o.Console == nil {
		o.Console = os.Stdout
	}
	if o.HTTPClient == nil {
		o.HTTPClient = &http.Client{}
	}
	if o.Version == "" {
		o.Version = "dev"
	}
	if err := os.MkdirAll(o.Config.DataDir, 0o700); err != nil {
		return nil, fmt.Errorf("data directory: %w", err)
	}
	db, err := store.Open(ctx, o.Config.DBPath(), o.Clock)
	if err != nil {
		return nil, err
	}
	mig, err := db.Migrate(ctx)
	if err != nil {
		db.Close()
		return nil, err
	}
	s := &Server{opts: o, clock: o.Clock, db: db, httpc: o.HTTPClient}
	s.logs = logs.New(logs.Options{DB: db, Clock: o.Clock, Console: o.Console, Format: o.Config.LogFormat, Level: o.Config.LogLevel})
	s.log = s.logs.Logger()
	for _, name := range mig.Applied {
		s.log.Info("migration applied", logs.Kind(logs.KindMigration), "name", name)
	}
	for _, name := range mig.Changed {
		s.log.Warn("an applied migration was edited; edits to shipped migrations are not re-run, add a new migration instead",
			logs.Kind(logs.KindMigration), "name", name)
	}
	s.migrations = mig

	if s.recorder, err = requests.OpenRecorder(ctx, db, s.log); err != nil {
		s.closeStores()
		return nil, err
	}

	s.tokens = admintokens.New(db)
	tok, created, err := s.tokens.Bootstrap(ctx)
	if err != nil {
		s.closeStores()
		return nil, fmt.Errorf("bootstrap Admin Token: %w", err)
	}
	if created {
		s.bootstrap = tok
		fmt.Fprintf(o.Console, "\nIroha created the Admin Token %q. It is printed only this once:\n\n    %s\n\nSend it as \"Authorization: Bearer <token>\". GET /skill.md explains the admin API.\n\n", tok.Name, tok.Secret)
		s.log.Info("bootstrap Admin Token created", logs.Kind(admintokens.KindBootstrap), "name", tok.Name)
	}

	s.audit = audit.New(db, s.log)
	s.rules = failurerules.New(db, s.log)
	s.owner = session.New(db, s.log)
	s.jobs = jobs.NewRunner(db, s.log)
	s.jobs.Add(retention.Job(db))
	s.refresh = modelrefresh.New(db, s.models())
	s.jobs.Add(s.refresh.Job())
	for _, j := range o.Jobs {
		s.jobs.Add(j)
	}
	s.router = api.NewRouter(s.log, s.tokens.Authenticator(), s.owner.Authenticator())
	s.router.Add(s.routes()...)
	s.router.Add(o.Routes...)
	s.router.Fallback(webui.Handler())
	s.router.AddDocs(o.Version, logs.SkillSection)
	return s, nil
}

func (s *Server) Handler() http.Handler { return s.router }

func (s *Server) Routes() []api.Route { return s.router.Routes() }

func (s *Server) DB() *store.DB { return s.db }

func (s *Server) Logger() *slog.Logger { return s.log }

func (s *Server) BootstrapToken() admintokens.Token { return s.bootstrap }

const abortGrace = 2 * time.Second

func (s *Server) Serve(ln net.Listener) error {
	s.httpSrv = s.newHTTPServer()
	s.started = s.clock.Now()
	if err := s.jobs.Start(context.Background()); err != nil {
		return err
	}
	s.log.Info("Iroha started", logs.Kind(logs.KindStartup),
		"version", s.opts.Version, "addr", ln.Addr().String(), "data_dir", s.opts.Config.DataDir,
		"migrations_applied", s.migrations.Applied, "migrations_total", s.migrations.Total, "go", runtime.Version())
	s.ready.Store(true)
	err := s.httpSrv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) newHTTPServer() *http.Server {
	return &http.Server{
		Handler:           s.router,
		ReadHeaderTimeout: 30 * time.Second,
		ErrorLog:          slog.NewLogLogger(s.log.Handler(), slog.LevelWarn),
	}
}

func (s *Server) Shutdown(ctx context.Context, reason string) error {
	s.closeOnce.Do(func() {
		s.ready.Store(false)
		begin := s.clock.Now()
		drainErr, ended := s.drainHTTP(ctx)
		s.jobs.Stop()
		attrs := []any{logs.Kind(logs.KindShutdown), "reason", reason,
			"drain_ms", s.clock.Now().Sub(begin).Milliseconds(), "drained", drainErr == nil}
		if ended > 0 {
			attrs = append(attrs, "requests_ended", ended)
		}
		if !s.started.IsZero() {
			attrs = append(attrs, "uptime_ms", s.clock.Now().Sub(s.started).Milliseconds())
		}
		if drainErr != nil {
			s.log.Warn("Iroha stopped before in-flight requests finished", append(attrs, "err", drainErr.Error())...)
		} else {
			s.log.Info("Iroha stopped", attrs...)
		}
		s.closeErr = s.closeStores()
	})
	return s.closeErr
}

func (s *Server) drainHTTP(ctx context.Context) (drainErr error, requestsEnded int) {
	if s.httpSrv == nil {
		return nil, 0
	}
	if drainErr = s.httpSrv.Shutdown(ctx); drainErr == nil {
		return nil, 0
	}
	if s.gw != nil {
		actx, cancel := clock.WithTimeout(context.Background(), s.clock, abortGrace)
		requestsEnded = s.gw.Abort(actx)
		cancel()
	}
	_ = s.httpSrv.Close()
	return drainErr, requestsEnded
}

func (s *Server) closeStores() error {
	s.logs.Close()
	return s.db.Close()
}

func Run(ctx context.Context, o Options) error {
	s, err := New(ctx, o)
	if err != nil {
		return err
	}
	ln, err := net.Listen("tcp", o.Config.Addr)
	if err != nil {
		_ = s.Shutdown(context.Background(), "listen failed")
		return err
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- s.Serve(ln) }()
	reason := "signal"
	select {
	case <-ctx.Done():
	case err := <-serveErr:
		reason = "serve failed"
		_ = s.Shutdown(context.Background(), reason)
		return err
	}
	dctx, cancel := clock.WithTimeout(context.Background(), s.clock, o.Config.DrainTimeout)
	defer cancel()
	return s.Shutdown(dctx, reason)
}
