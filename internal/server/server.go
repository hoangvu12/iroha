// Package server assembles Iroha: it opens the store, starts logging,
// builds the route table from every module and runs the HTTP server with a
// graceful drain. Keep it thin: features live in their own packages and
// only get one line in routes.go.
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
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/session"
	"github.com/hoangvu12/iroha/internal/store"
	"github.com/hoangvu12/iroha/internal/webui"
)

// Options are everything the server takes from outside. Tests replace the
// clock, console and HTTP client.
type Options struct {
	Config  config.Config
	Version string
	Clock   clock.Clock // default clock.Real{}
	Console io.Writer   // logs and the bootstrap token; default os.Stdout
	// HTTPClient makes every outbound call (Attempts, discovery, tests).
	// Default: a client with no overall timeout; budgets use contexts.
	HTTPClient *http.Client
	// Routes are added after the built-in route table. Tests use it for
	// routes production has no need of, such as a deliberately slow one.
	Routes []api.Route
}

// Server is one running Iroha.
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
	httpc   *http.Client
	started time.Time

	migrations store.MigrationResult
	bootstrap  admintokens.Token // set only on the first start

	httpSrv   *http.Server
	ready     atomic.Bool
	closeOnce sync.Once
	closeErr  error
}

// New opens the data directory, migrates the database, issues the
// bootstrap Admin Token on first start and builds the route table.
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
	s.owner = session.New(db, s.log)
	s.router = api.NewRouter(s.log, s.tokens.Authenticator(), s.owner.Authenticator())
	s.router.Add(s.routes()...)
	s.router.Add(o.Routes...)
	s.router.Fallback(webui.Handler())
	s.router.AddDocs(o.Version, logs.SkillSection)
	return s, nil
}

// Handler is the HTTP handler of the whole server.
func (s *Server) Handler() http.Handler { return s.router }

// Routes is the route table, as served and documented.
func (s *Server) Routes() []api.Route { return s.router.Routes() }

// DB is the open store (tests use it only where no API exists yet).
func (s *Server) DB() *store.DB { return s.db }

// Logger is the server's logger.
func (s *Server) Logger() *slog.Logger { return s.log }

// BootstrapToken is the Admin Token created by this start, or the zero
// Token when this was not the first start.
func (s *Server) BootstrapToken() admintokens.Token { return s.bootstrap }

// Serve answers HTTP on ln until Shutdown. It returns nil after a Shutdown.
func (s *Server) Serve(ln net.Listener) error {
	s.httpSrv = &http.Server{
		Handler:           s.router,
		ReadHeaderTimeout: 30 * time.Second,
		// No ReadTimeout or WriteTimeout: long streams must not be cut.
		ErrorLog: slog.NewLogLogger(s.log.Handler(), slog.LevelWarn),
	}
	s.started = s.clock.Now()
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

// Shutdown stops accepting requests, waits for in-flight ones until ctx
// ends, logs the shutdown and closes the store. Safe to call more than once.
func (s *Server) Shutdown(ctx context.Context, reason string) error {
	s.closeOnce.Do(func() {
		s.ready.Store(false)
		begin := s.clock.Now()
		var drainErr error
		if s.httpSrv != nil {
			drainErr = s.httpSrv.Shutdown(ctx)
			if drainErr != nil {
				_ = s.httpSrv.Close()
			}
		}
		attrs := []any{logs.Kind(logs.KindShutdown), "reason", reason,
			"drain_ms", s.clock.Now().Sub(begin).Milliseconds(), "drained", drainErr == nil}
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

func (s *Server) closeStores() error {
	s.logs.Close()
	return s.db.Close()
}

// Run listens on the configured address and serves until ctx is done, then
// drains for at most the configured drain timeout.
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
	dctx, cancel := context.WithTimeout(context.Background(), o.Config.DrainTimeout)
	defer cancel()
	return s.Shutdown(dctx, reason)
}
