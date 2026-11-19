package gateway

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/pools"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/shape"
)

// exchange is one Request in flight: what the Caller sent, what it has been
// answered, and the record being built.
type exchange struct {
	g     *Gateway
	w     http.ResponseWriter
	r     *http.Request
	ctx   context.Context
	start time.Time
	rec   requests.Request
	begun bool // the Request is recorded (the Caller is known)
	// capture collects the prompt and response when the Gateway Key has
	// capture on; it wraps r.Body and w, so nothing else needs to know.
	capture *requests.Capture
	// pool is the Model Pool the Caller named, if any: its budget override
	// applies across its members (budget.go).
	pool *pools.Routing
	// idempotencyKey is minted per Request when the Caller sent no
	// Idempotency-Key, and sent on every Attempt (attempt), so a Provider
	// that honours it never bills a replayed Attempt twice. Empty when the
	// Caller's own value is forwarded.
	idempotencyKey string
	// test is set on a test send (testrun.go): its recorded Caller and pins.
	test *testRun

	// mu guards what follows and every write to w, since a stream's keeper
	// (stream.go) writes alongside the relay.
	mu        sync.Mutex
	wrote     bool // the status line went to the Caller
	streaming bool // what the Caller gets is an event stream
	committed bool // Iroha sent 200 before the answer: stream headers (stream.go) or JSON (pad.go)
	ended     bool // the answer is complete; nothing more is written
	lastWrite time.Time
	// A non-stream Request's padder (pad.go): answering while an upstream
	// 2xx answer is being read, padded once Iroha committed 200 + JSON.
	answering bool
	padded    bool
	pad       *padder
}

func (g *Gateway) newExchange(w http.ResponseWriter, r *http.Request, sh shape.Shape) *exchange {
	now := g.clock.Now()
	x := &exchange{g: g, w: w, r: r, ctx: r.Context(), start: now,
		rec: requests.Request{ID: ids.New("req"), StartedAt: now.UTC(), Route: r.URL.Path, ShapeIn: sh}}
	if r.Header.Get(idempotencyHeader) == "" {
		x.idempotencyKey = ids.UUID()
	}
	w.Header().Set("X-Request-Id", x.rec.ID)
	return x
}

// begin records the Request once the Caller is known, and starts capturing
// it when the Caller's Gateway Key asks for that. Test sends are always
// captured (the chat's tool check reads the answer; the Owner's own tests
// carry nobody else's conversation).
func (x *exchange) begin(c gatewaykeys.Caller) {
	x.rec.Caller = requests.Caller{Kind: requests.CallerGatewayKey, GatewayKeyID: c.KeyID, Name: c.Name}
	capture := c.Capture
	if x.test != nil {
		x.rec.Caller, capture = x.test.caller, true
	}
	if capture {
		x.capture = requests.NewCapture(x.start)
		x.r.Body = x.capture.Body(x.r)
		x.w = x.capture.Writer(x.w)
	}
	if err := x.g.rec.Begin(x.ctx, &x.rec); err != nil {
		x.g.log.Error("recording a Request failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
		return
	}
	x.begun = true
}

// finish completes the record and logs the Request.
func (x *exchange) finish() {
	now := x.g.clock.Now()
	at := now.UTC()
	x.rec.FinishedAt = &at
	x.rec.DurationMs = ms(now.Sub(x.start))
	if x.rec.Status == 0 && x.isCommitted() {
		x.rec.Status = http.StatusOK
	}
	if x.rec.Status == 0 {
		x.rec.Status = http.StatusOK
	}
	if x.begun {
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

// fail answers the Caller with e in its Shape and records why. On a stream
// already under way the status stays what the Caller got and e goes out as
// the stream's last event.
func (x *exchange) fail(e *api.Error) {
	x.rec.Error = &requests.Failure{Code: e.Code, Message: e.Message}
	if status := x.writeError(e); status != 0 {
		x.rec.Status = status
	} else if x.rec.Status == 0 {
		x.rec.Status = http.StatusOK // committed by Iroha
	}
}

// refuseUnrecorded answers a Caller that could not be identified; there is
// no Caller to attribute a Request to, so nothing is recorded.
func (x *exchange) refuseUnrecorded(e *api.Error) {
	x.writeError(e)
}

// writeError writes e in the Caller's Shape (errorEnvelope), extended with
// Iroha's hint and the Request ID; on a stream under way, the Shape's error
// event (stream.go); after a non-stream commit (pad.go), the envelope as
// the body. It returns the HTTP status sent, 0 when the status
// line had already gone out.
func (x *exchange) writeError(e *api.Error) int {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.ended {
		return 0
	}
	x.ended = true
	if x.streaming {
		_ = x.sendLocked(specOf(x.rec.ShapeIn).stream.errorEvent(e, x.rec.ID))
		return 0
	}
	if x.padded { // committed 200 + JSON: the error is the body
		_, _ = x.w.Write(append(compactJSON(errorEnvelope(x.rec.ShapeIn, e, x.rec.ID)), '\n'))
		return 0
	}
	if x.wrote {
		return 0
	}
	x.wrote = true
	x.w.Header().Set("Content-Type", "application/json")
	x.w.WriteHeader(e.Status)
	_, _ = x.w.Write(append(compactJSON(errorEnvelope(x.rec.ShapeIn, e, x.rec.ID)), '\n'))
	return e.Status
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
