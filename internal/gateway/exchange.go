package gateway

import (
	"context"
	"net/http"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/pools"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/shape"
)

type exchange struct {
	g        *Gateway
	out      *callerOutput
	r        *http.Request
	ctx      context.Context
	start    time.Time
	rec      requests.Request
	recorded bool
	capture  *requests.Capture
	pool     *pools.Routing
	// A Provider honouring Idempotency-Key processes a repeated request once.
	idempotencyKey string
	test           *testRun
	conv           conversation
	planned        planner.Request
}

func (g *Gateway) newExchange(w http.ResponseWriter, r *http.Request, sh shape.Shape) *exchange {
	now := g.clock.Now()
	x := &exchange{g: g, r: r, ctx: r.Context(), start: now,
		rec: requests.Request{ID: ids.New("req"), StartedAt: now.UTC(), Route: r.URL.Path, ShapeIn: sh}}
	x.out = newCallerOutput(w, g.clock, sh, x.rec.ID)
	x.idempotencyKey = r.Header.Get(idempotencyHeader)
	if x.idempotencyKey == "" {
		x.idempotencyKey = ids.UUID()
	}
	w.Header().Set("X-Request-Id", x.rec.ID)
	return x
}

func (x *exchange) begin(c gatewaykeys.Caller) {
	x.rec.Caller = requests.Caller{Kind: requests.CallerGatewayKey, GatewayKeyID: c.KeyID, Name: c.Name}
	capture := c.Capture
	if x.test != nil {
		x.rec.Caller, capture = x.test.caller, true
	}
	if capture {
		x.out.wrap(func(w http.ResponseWriter) http.ResponseWriter {
			var teed http.ResponseWriter
			x.capture, x.r.Body, teed = requests.NewCapture(w, x.r, x.start)
			return teed
		})
	}
	if err := x.g.rec.Begin(x.ctx, &x.rec); err != nil {
		x.g.log.Error("recording a Request failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
		return
	}
	x.recorded = true
}

func (x *exchange) finish() {
	now := x.g.clock.Now()
	at := now.UTC()
	x.rec.FinishedAt = &at
	x.rec.DurationMs = ms(now.Sub(x.start))
	if x.rec.Status == 0 && x.out.isCommitted() {
		x.rec.Status = http.StatusOK
	}
	if x.rec.Status == 0 {
		x.rec.Status = http.StatusOK
	}
	if x.recorded {
		if err := x.g.rec.Finish(x.ctx, &x.rec); err != nil {
			x.g.log.Error("recording a Request failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
		}
		if x.capture != nil {
			if err := x.g.rec.SaveCapture(x.ctx, x.rec.ID, x.rec.ShapeIn, x.capture); err != nil {
				x.g.log.Error("storing a capture failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
			}
		}
	}
	attrs := []any{logs.Kind(KindRequest), logs.Request(x.rec.ID), "caller", x.rec.Caller.Name, "route", x.rec.Route,
		"model", x.rec.Model, "status", x.rec.Status, "attempts", x.rec.AttemptCount, "duration_ms", *x.rec.DurationMs}
	if x.rec.Provider != "" {
		attrs = append(attrs, logs.Provider(x.rec.Provider))
	}
	if x.rec.Error != nil {
		attrs = append(attrs, "error_code", x.rec.Error.Code)
	}
	x.g.log.Info("request finished", attrs...)
}

func (x *exchange) fail(e *api.Error) {
	x.rec.Error = &requests.Failure{Code: e.Code, Message: e.Message}
	if x.out.writeError(e) {
		x.rec.Status = e.Status
	} else if x.rec.Status == 0 {
		x.rec.Status = http.StatusOK
	}
}

func (x *exchange) refuseUnrecorded(e *api.Error) {
	x.out.writeError(e)
}

func errorType(status int) string {
	switch {
	case status == http.StatusUnauthorized:
		return "authentication_error"
	case status == http.StatusForbidden:
		return "permission_error"
	case status == http.StatusNotFound:
		return "not_found_error"
	case status == http.StatusTooManyRequests:
		return "rate_limit_error"
	case status >= 500:
		return "server_error"
	}
	return "invalid_request_error"
}

func ms(d time.Duration) *int64 {
	v := d.Milliseconds()
	if v < 0 {
		v = 0
	}
	return &v
}
