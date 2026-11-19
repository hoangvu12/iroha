package server

import (
	"context"
	"net/http"
	"slices"
	"time"

	"github.com/hoangvu12/iroha/internal/admintokens"
	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/requests"
)

// routes is the route table: one line per module. Each module package
// exports a Routes(...) []api.Route taking exactly the dependencies it
// needs (store, logger, clock, HTTP client). /skill.md and
// /api/openapi.json are added by the router itself.
func (s *Server) routes() []api.Route {
	return slices.Concat(
		s.coreRoutes(),
		logs.Routes(s.logs),
		audit.Routes(s.audit),
		admintokens.Routes(s.audit, s.db),
		providers.Routes(s.audit, s.db, s.log),
		gatewaykeys.Routes(s.audit, s.db),
		requests.Routes(s.db),
		gateway.New(gateway.Options{Clock: s.clock, Log: s.log, HTTPClient: s.httpc, Providers: providers.New(s.db), Keys: gatewaykeys.New(s.db), Recorder: requests.NewRecorder(s.db)}).Routes(),
	)
}

// Health is the body of /healthz and /readyz.
type Health struct {
	Status  string `json:"status" enum:"ok,ready"`
	Version string `json:"version"`
}

func (s *Server) coreRoutes() []api.Route {
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/healthz", Tag: "Meta", Auth: api.AuthPublic,
			Summary:  "Liveness: answers 200 while the process is running",
			Response: Health{},
			Handle: func(c *api.Call) (any, error) {
				return Health{Status: "ok", Version: s.opts.Version}, nil
			},
		},
		{
			Method: http.MethodGet, Path: "/readyz", Tag: "Meta", Auth: api.AuthPublic,
			Summary:     "Readiness: answers 200 when Iroha can serve, 503 while starting or draining",
			Description: "The deploy script and monitoring use this. It also checks the database.",
			Response:    Health{},
			Handle: func(c *api.Call) (any, error) {
				if !s.ready.Load() {
					return nil, api.Errorf(http.StatusServiceUnavailable, "not_ready", "Iroha is starting or shutting down; retry in a few seconds.", "Iroha is not ready.")
				}
				ctx, cancel := context.WithTimeout(c.R.Context(), 2*time.Second)
				defer cancel()
				if err := s.db.PingContext(ctx); err != nil {
					s.log.Error("readiness check failed", logs.Kind(logs.KindGeneric), "err", err.Error())
					return nil, api.Errorf(http.StatusServiceUnavailable, "not_ready", "The database is not answering; read GET /api/logs?level=error.", "Iroha's database is not answering.")
				}
				return Health{Status: "ready", Version: s.opts.Version}, nil
			},
		},
		{
			Method: http.MethodGet, Path: "/api/whoami", Tag: "Meta",
			Summary:  "Show which Admin Token or session is calling",
			Response: api.Actor{},
			Handle: func(c *api.Call) (any, error) {
				return c.Actor, nil
			},
		},
	}
}
