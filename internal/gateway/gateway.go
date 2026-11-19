// Package gateway serves the inference routes Callers use. One Request runs
// through four seams, each owned elsewhere:
//
//  1. Caller auth and scope: gatewaykeys.Store.Authenticate and Caller.Allows*.
//  2. Candidate planning: planner.Plan over providers.Store.Routing.
//  3. Attempt execution against an Endpoint: attempt.go (outbound request,
//     passthrough relay of the answer, buffered or streamed).
//  4. Recording: requests.Recorder (Request and Attempts) and log events.
//
// Attempts run inside the Request budget (budget.go): failed Attempts are
// classified by the Failure Rules, which change Key States and decide
// whether to try the next candidate.
package gateway

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/shape"
)

// Log event kinds of the Gateway.
var (
	KindRequest = logs.NewKind("request", "A Request finished: caller, route, Provider, model, status, Attempt count and duration.")
	KindAttempt = logs.NewKind("attempt", "An Attempt finished: Provider, Endpoint, Upstream Key name, wire model, upstream status or error, duration.")
)

// Options are the Gateway's dependencies.
type Options struct {
	Clock      clock.Clock
	Log        *slog.Logger
	HTTPClient *http.Client
	Providers  *providers.Store
	Keys       *gatewaykeys.Store
	Recorder   *requests.Recorder
	KeyStates  *keystate.Store
	// Rules gives the Failure Rules in force for the next Attempt; nil
	// means the built-in rules. Ticket 06 passes the live set with the
	// Owner's rules merged in.
	Rules func() *rules.Set
}

// Gateway serves inference.
type Gateway struct {
	clock     clock.Clock
	log       *slog.Logger
	http      *http.Client
	providers *providers.Store
	keys      *gatewaykeys.Store
	rec       *requests.Recorder
	states    *keystate.Store
	rules     func() *rules.Set
	rotation  *planner.Counter
}

// New returns a Gateway. Upstream redirects are never followed, so an
// Upstream Key never leaves the configured origin.
func New(o Options) *Gateway {
	hc := *o.HTTPClient
	hc.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	rs := o.Rules
	if rs == nil {
		rs = func() *rules.Set { return rules.Default }
	}
	return &Gateway{clock: o.Clock, log: o.Log, http: &hc, providers: o.Providers, keys: o.Keys, rec: o.Recorder,
		states: o.KeyStates, rules: rs, rotation: planner.NewCounter()}
}

// ChatCompletionRequest documents the body of the Chat Completions routes.
// Iroha reads only model, stream and stream_options; everything else is
// forwarded as sent.
type ChatCompletionRequest struct {
	Model    string           `json:"model" doc:"The model, as the Provider names it (or as an Endpoint rename maps it)."`
	Messages []map[string]any `json:"messages"`
	Stream   bool             `json:"stream,omitempty" doc:"true: the answer streams as server-sent events, chunk by chunk."`
}

const chatDescription = "OpenAI Chat Completions passthrough. Authenticate with \"Authorization: Bearer <Gateway Key>\", or the key in an x-api-key or api-key header; " +
	"Caller credentials are never forwarded. The body reaches the Provider unchanged except the model (Endpoint renames) and, on streams, " +
	"stream_options.include_usage (so token usage is recorded; the extra usage chunk is not shown to Callers who did not ask for it). " +
	"The answer passes through with its status, its model field set to the model you asked for, and an x-request-id header naming the Request in GET /api/requests/{request}. " +
	"A Provider that does not exist, is disabled or archived, or is outside the Gateway Key's scope gets the same 403 provider_not_allowed."

// Routes returns the inference routes.
func (g *Gateway) Routes() []api.Route {
	return []api.Route{{
		Method: http.MethodPost, Path: "/providers/{handle}/v1/chat/completions", Tag: "Gateway", Auth: api.AuthCaller,
		Summary:     "Send an OpenAI Chat Completions request to one Provider",
		Description: chatDescription,
		Request:     ChatCompletionRequest{}, Response: map[string]any{},
		Raw: http.HandlerFunc(g.serveProviderChat),
	}}
}

// serveProviderChat is POST /providers/{handle}/v1/chat/completions.
func (g *Gateway) serveProviderChat(w http.ResponseWriter, r *http.Request) {
	x := g.newExchange(w, r, shape.OpenAIChat)
	caller, aerr := g.keys.Authenticate(r)
	if aerr != nil {
		x.refuseUnrecorded(aerr)
		return
	}
	x.begin(caller)
	defer x.finish()

	body, cr, err := readChatBody(r)
	if err != nil {
		x.fail(err)
		return
	}
	x.rec.Model, x.rec.Stream = cr.model, cr.stream

	p, err := x.provider(caller, r.PathValue("handle"), cr.model)
	if err != nil {
		x.fail(err)
		return
	}
	now := g.clock.Now()
	plan := planner.Plan(planner.Request{Shape: x.rec.ShapeIn, Model: cr.model, Now: now}, []planner.Provider{p}, g.rotation)
	if len(plan.Candidates) == 0 {
		e := noCandidate(p.Handle, plan.Empty)
		if plan.Empty.Code == planner.Cooling {
			x.w.Header().Set("Retry-After", strconv.Itoa(retryAfter(plan.Empty.Until, now)))
		}
		x.fail(e)
		return
	}
	x.serve(plan.Candidates, body, cr)
}

// retryAfter is whole seconds from now until t, at least 1.
func retryAfter(t, now time.Time) int {
	s := int(math.Ceil(t.Sub(now).Seconds()))
	return max(s, 1)
}

// provider resolves the Provider a provider-scoped route names, refusing
// unknown, disabled, archived and out-of-scope Providers alike.
func (x *exchange) provider(caller gatewaykeys.Caller, handle, model string) (planner.Provider, *api.Error) {
	rt, ok, err := x.g.providers.Routing(x.ctx, handle)
	if err != nil {
		return planner.Provider{}, api.AsError(err)
	}
	if !ok || !rt.Enabled || rt.Archived || !caller.AllowsProvider(rt.ID) {
		return planner.Provider{}, api.Errorf(http.StatusForbidden, "provider_not_allowed",
			"Check the handle in the URL; ask the Owner to add this Provider to your Gateway Key if you need it.",
			"This Gateway Key may not use a Provider named %q, or there is none.", handle)
	}
	x.rec.ProviderID, x.rec.Provider = rt.ID, rt.Handle
	if !caller.AllowsModel(rt.ID, model) {
		return planner.Provider{}, api.Errorf(http.StatusForbidden, "model_not_allowed",
			"Use a model your Gateway Key allows on this Provider, or ask the Owner to add it.",
			"This Gateway Key may not use the model %q on %s.", model, handle)
	}
	return rt.Provider, nil
}

// noCandidate is the error of an empty plan: keys_cooling (servable again
// at a known time) or no_candidate (nothing can serve it until the Owner
// changes something).
func noCandidate(handle string, e *planner.Empty) *api.Error {
	if e.Code == planner.Cooling {
		until := e.Until.UTC().Format(time.RFC3339)
		return api.Errorf(http.StatusServiceUnavailable, "keys_cooling", "Retry after "+until+" (see Retry-After); GET /api/providers/"+handle+"/summary (Admin Token) lists the coolings.",
			"%s", e.Message).WithDetails(map[string]string{"reason": e.Code, "until": until})
	}
	hint := "Ask the Owner to add an Upstream Key to " + handle + " (POST /api/providers/" + handle + "/keys)."
	switch e.Code {
	case planner.NoEndpoint:
		hint = "Ask the Owner to add an Endpoint speaking this Shape to " + handle + " (POST /api/providers/" + handle + "/endpoints)."
	case planner.NoUsableKey:
		hint = "Ask the Owner to enable a key, test an invalid one, or replace its secret (GET /api/providers/" + handle + "/keys shows each key's state and reason)."
	}
	return api.Errorf(http.StatusServiceUnavailable, "no_candidate", hint, "%s", e.Message).WithDetails(map[string]string{"reason": e.Code})
}

// maxCallerBody caps a Caller's request body.
const maxCallerBody = 64 << 20

// chatRequest is what Iroha reads of a Chat Completions body.
type chatRequest struct {
	model        string // trimmed
	bodyModel    string // as written in the body
	stream       bool
	includeUsage bool // the Caller asked for stream_options.include_usage
}

func readChatBody(r *http.Request) ([]byte, chatRequest, *api.Error) {
	var cr chatRequest
	body, err := io.ReadAll(io.LimitReader(r.Body, maxCallerBody+1))
	if err != nil {
		return nil, cr, api.BadRequest("Send the whole JSON body.", "The request body could not be read: %v", err)
	}
	if len(body) > maxCallerBody {
		return nil, cr, api.Errorf(http.StatusRequestEntityTooLarge, "request_too_large", "Send a body of at most 64 MiB.", "The request body is larger than 64 MiB.")
	}
	hint := "Send an OpenAI Chat Completions JSON object with model and messages."
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 {
		return nil, cr, api.BadRequest(hint, "The request body is empty.")
	}
	var head struct {
		Model         json.RawMessage `json:"model"`
		Stream        json.RawMessage `json:"stream"`
		StreamOptions json.RawMessage `json:"stream_options"`
	}
	if trimmed[0] != '{' || json.Unmarshal(trimmed, &head) != nil {
		return nil, cr, api.BadRequest(hint, "The request body is not a JSON object.")
	}
	if len(head.Model) > 0 && string(head.Model) != "null" {
		if json.Unmarshal(head.Model, &cr.bodyModel) != nil {
			return nil, cr, api.BadRequest(hint, "model must be a string.")
		}
	}
	cr.model = strings.TrimSpace(cr.bodyModel)
	if cr.model == "" {
		return nil, cr, api.Errorf(http.StatusBadRequest, "model_required", hint, "The request names no model.")
	}
	cr.stream = string(head.Stream) == "true"
	var opts struct {
		IncludeUsage bool `json:"include_usage"`
	}
	if len(head.StreamOptions) > 0 && json.Unmarshal(head.StreamOptions, &opts) == nil {
		cr.includeUsage = opts.IncludeUsage
	}
	return body, cr, nil
}
