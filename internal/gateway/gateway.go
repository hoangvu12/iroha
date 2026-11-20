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
	"github.com/hoangvu12/iroha/internal/models"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/pools"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
	"github.com/hoangvu12/iroha/internal/translate"
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
	// Models applies the Provider's model list before planning: hidden and
	// (on strict Providers) unlisted models are refused, carriers marked.
	Models *models.Store
	// Pools looks up the Model Pool a global route's model names.
	Pools *pools.Store
	// Rules gives the Failure Rules in force for the next Attempt; nil
	// means the built-in rules. The server passes failurerules.Store.Set:
	// the built-ins merged with the Owner's rules, reloaded on every change.
	Rules func() *rules.Set
	// DB reads runtime settings (affinity.experiment); nil: their defaults.
	DB *store.DB
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
	models    *models.Store
	pools     *pools.Store
	rules     func() *rules.Set
	rotation  *planner.Counter
	db        *store.DB
	live      inflight // Requests being served (shutdown.go)
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
		states: o.KeyStates, models: o.Models, pools: o.Pools, rules: rs, rotation: planner.NewCounter(), db: o.DB}
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
	"A Provider that does not exist, is disabled or archived, or is outside the Gateway Key's scope gets the same 403 provider_not_allowed. " +
	"A stream with no upstream byte after 10 s is committed (200, keep-alive comments every 15 s of silence); failures after that arrive as a final data: {\"error\": ...} event."

// MessagesRequest documents the body of the Anthropic Messages routes.
// Iroha reads only model and stream; on passthrough everything else is
// forwarded as sent.
type MessagesRequest struct {
	Model     string           `json:"model" doc:"The model, as the Provider names it (or as an Endpoint rename maps it)."`
	MaxTokens int              `json:"max_tokens"`
	Messages  []map[string]any `json:"messages"`
	Stream    bool             `json:"stream,omitempty" doc:"true: the answer streams as Anthropic server-sent events."`
}

const translationNote = "When the Provider has no usable Endpoint speaking this Shape but has one speaking another Shape Iroha translates to, " +
	"the request and answer (streams, tools, images, reasoning, usage) are translated; GET /api/requests/{request} shows shape_in and shape_out. "

const messagesDescription = "Anthropic Messages. Authenticate with \"x-api-key: <Gateway Key>\" (the Anthropic SDK and Claude Code default) or \"Authorization: Bearer <Gateway Key>\"; " +
	"Caller credentials are never forwarded. On an Endpoint speaking Anthropic Messages the body passes through unchanged except the model, " +
	"with anthropic-version " + shape.AnthropicVersion + " added when you send none; the answer passes through with its model field set to the model you asked for. " +
	translationNote +
	"Errors use the Anthropic envelope {\"type\":\"error\",\"error\":{\"type\",\"message\",\"code\",\"hint\",\"request_id\"}}. " +
	"A stream with no upstream byte after 10 s is committed (200, ping events every 15 s of silence); failures after that arrive as a final error event."

// Routes returns the inference routes: each Shape's provider-scoped route,
// and its global variant (global.go) on the line below it.
func (g *Gateway) Routes() []api.Route {
	chat := api.Route{
		Method: http.MethodPost, Path: "/providers/{handle}/v1/chat/completions", Tag: "Gateway", Auth: api.AuthCaller,
		Summary:     "Send an OpenAI Chat Completions request to one Provider",
		Description: chatDescription + " " + translationNote,
		Request:     ChatCompletionRequest{}, Response: map[string]any{},
		Raw: g.serveProvider(shape.OpenAIChat),
	}
	messages := api.Route{
		Method: http.MethodPost, Path: "/providers/{handle}/v1/messages", Tag: "Gateway", Auth: api.AuthCaller,
		Summary:     "Send an Anthropic Messages request to one Provider",
		Description: messagesDescription,
		Request:     MessagesRequest{}, Response: map[string]any{},
		Raw: g.serveProvider(shape.AnthropicMessages),
	}
	responses := api.Route{
		Method: http.MethodPost, Path: "/providers/{handle}/v1/responses", Tag: "Gateway", Auth: api.AuthCaller,
		Summary:     "Send an OpenAI Responses request to one Provider",
		Description: responsesDescription,
		Request:     ResponsesRequest{}, Response: map[string]any{},
		Raw: g.serveProvider(shape.OpenAIResponses),
	}
	gemini := g.geminiRoute()
	return []api.Route{
		chat, g.globalRoute(shape.OpenAIChat, chat),
		messages, g.globalRoute(shape.AnthropicMessages, messages),
		responses, g.globalRoute(shape.OpenAIResponses, responses),
		gemini, g.globalRoute(shape.Gemini, gemini),
	}
}

// serveProvider serves a provider-scoped route whose Caller speaks sh.
func (g *Gateway) serveProvider(sh shape.Shape) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) { g.serveScoped(w, r, sh) }
}

// serveScoped serves a provider-scoped route whose Caller speaks sh.
func (g *Gateway) serveScoped(w http.ResponseWriter, r *http.Request, sh shape.Shape) {
	g.serve(w, r, sh, (*exchange).scoped)
}

// route is where a Request goes: the Providers to plan over, in order, each
// ready for planning (models.Store.Prepare applied) and asked for its own
// model (planner.Provider.ModelFor). A Pool (pool.go) gives one Provider per
// member it can plan, and notes every member for the route preview.
type route struct {
	providers []planner.Provider
	model     string // planner.Request.Model: the model on a single Provider; "" for a Pool
	pool      *pools.Routing
	members   []memberNote
}

// resolver finds where a Request goes from the model the Caller named.
// scoped (provider-scoped routes) and global (global.go) are the two. On an
// error the route may still say what was found (the route preview shows a
// Pool's members even when none can serve).
type resolver func(x *exchange, caller gatewaykeys.Caller, model string) (route, *api.Error)

// scoped resolves the model of a provider-scoped route: the Provider is the
// one the path names, the model is the name as sent.
func (x *exchange) scoped(caller gatewaykeys.Caller, model string) (route, *api.Error) {
	return x.single(caller, x.r.PathValue("handle"), model, "Check the handle in the URL")
}

// single is the route to model on the Provider named handle, scope-checked
// and prepared. check says where the Caller wrote the handle, for the hint.
func (x *exchange) single(caller gatewaykeys.Caller, handle, model, check string) (route, *api.Error) {
	p, err := x.provider(caller, handle, model, check)
	if err != nil {
		return route{}, err
	}
	if err := x.g.models.Prepare(x.ctx, &p, model); err != nil {
		return route{}, api.AsError(err)
	}
	return route{providers: []planner.Provider{p}, model: model}, nil
}

// serve serves one inference Request whose Caller speaks sh, resolving its
// model with resolve.
func (g *Gateway) serve(w http.ResponseWriter, r *http.Request, sh shape.Shape, resolve resolver) {
	x := g.newExchange(w, r, sh)
	defer g.track(x)()
	caller, aerr := g.keys.Authenticate(r)
	if aerr != nil {
		x.refuseUnrecorded(aerr)
		return
	}
	g.run(x, caller, resolve)
}

// run serves the Request of x for caller once it is known: Gateway Key
// traffic (serve) and test sends (testrun.go) alike.
func (g *Gateway) run(x *exchange, caller gatewaykeys.Caller, resolve resolver) {
	r, sh := x.r, x.rec.ShapeIn
	x.begin(caller)
	defer x.finish()

	body, cr, err := readBody(r, sh)
	if err != nil {
		x.fail(err)
		return
	}
	x.rec.Model, x.rec.Stream = cr.model, cr.stream

	// cr.model stays the name the Caller sent: answers echo it and the
	// Request records it. model is that name on the Provider.
	rt, err := resolve(x, caller, cr.model)
	if err != nil {
		x.fail(err)
		return
	}
	now := g.clock.Now()
	if x.test != nil {
		if err := x.test.pin(&rt, now); err != nil {
			x.fail(err)
			return
		}
	}
	for i := range rt.providers {
		g.expireGaps(x, &rt.providers[i], now)
	}
	x.conv = g.conversationOf(x.ctx, r.Header, body, x.rec.Caller, rt)
	x.noteAffinity()
	req := planRequest(sh, rt, now)
	req.Affinity = x.conv.planned()
	plan := planner.Plan(req, rt.providers, g.rotation)
	if len(plan.Candidates) == 0 {
		e := rt.noCandidate(plan.Empty)
		if plan.Empty.Code == planner.Cooling {
			x.w.Header().Set("Retry-After", strconv.Itoa(retryAfter(plan.Empty.Until, now)))
		}
		x.fail(e)
		return
	}
	if cr.stream {
		defer x.keepAlive()() // stream.go: commit early, keep-alives, error events
	} else {
		defer x.stopPadding() // pad.go: a late non-stream answer is padded
	}
	x.serve(plan.Candidates, body, cr)
}

// planRequest is what planning knows of a Request in Shape sh along rt.
func planRequest(sh shape.Shape, rt route, now time.Time) planner.Request {
	return planner.Request{Shape: sh, Model: rt.model, Now: now, Translate: translate.Targets(sh)}
}

// noCandidate is the error of an empty plan along rt.
func (rt route) noCandidate(e *planner.Empty) *api.Error {
	handle := e.Provider
	if handle == "" && len(rt.providers) > 0 {
		handle = rt.providers[0].Handle
	}
	if rt.pool != nil {
		c := *e
		c.Message = "No member of Model Pool " + rt.pool.Name + " can serve it now: " + e.Message
		e = &c
	}
	return noCandidate(handle, e)
}

// retryAfter is whole seconds from now until t, at least 1.
func retryAfter(t, now time.Time) int {
	s := int(math.Ceil(t.Sub(now).Seconds()))
	return max(s, 1)
}

// provider resolves the Provider a provider-scoped route names, refusing
// unknown, disabled, archived and out-of-scope Providers alike. check says
// where the Caller wrote the handle, for the hint.
func (x *exchange) provider(caller gatewaykeys.Caller, handle, model, check string) (planner.Provider, *api.Error) {
	rt, ok, err := x.g.providers.Routing(x.ctx, handle)
	if err != nil {
		return planner.Provider{}, api.AsError(err)
	}
	if !ok || !rt.Enabled || rt.Archived || !caller.AllowsProvider(rt.ID) {
		return planner.Provider{}, api.Errorf(http.StatusForbidden, "provider_not_allowed",
			check+"; ask the Owner to add this Provider to your Gateway Key if you need it.",
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
			"%s", e.Message).WithDetails(map[string]string{"reason": string(e.Code), "until": until})
	}
	if e.Code == planner.ModelGap {
		until := e.Until.UTC().Format(time.RFC3339)
		return api.Errorf(http.StatusNotFound, "model_unavailable", "Use another model; the Provider refused it to every usable key. The gaps expire by "+until+", or the Owner clears them (GET /api/providers/"+handle+"/model-gaps).",
			"%s", e.Message).WithDetails(map[string]string{"reason": string(e.Code), "until": until})
	}
	hint := "Ask the Owner to add an Upstream Key to " + handle + " (POST /api/providers/" + handle + "/keys), or, when its Endpoints need no key, " +
		"a keyless key ({\"name\": \"keyless\"}, or auth_style none on the Endpoint)."
	switch e.Code {
	case planner.NoEndpoint:
		hint = "Ask the Owner to add an Endpoint speaking this Shape to " + handle + " (POST /api/providers/" + handle + "/endpoints)."
	case planner.NoUsableKey:
		hint = "Ask the Owner to enable a key, test an invalid one, or replace its secret (GET /api/providers/" + handle + "/keys shows each key's state and reason)."
	}
	return api.Errorf(http.StatusServiceUnavailable, "no_candidate", hint, "%s", e.Message).WithDetails(map[string]string{"reason": string(e.Code)})
}

// maxCallerBody caps a Caller's request body.
const maxCallerBody = 64 << 20

// callerRequest is what Iroha reads of a Caller's body, whatever its Shape.
type callerRequest struct {
	shape        shape.Shape // the Caller's Shape
	model        string      // trimmed
	bodyModel    string      // as written in the body
	stream       bool
	includeUsage bool // OpenAI Chat: the Caller asked for stream_options.include_usage
}

// readBody reads a Caller's body written in sh. Every Shape whose body
// names the model shares these rules: a JSON object, a non-blank string
// model, stream only when it is exactly true. Gemini names both in the URL
// (gemini.go).
func readBody(r *http.Request, sh shape.Shape) ([]byte, callerRequest, *api.Error) {
	cr := callerRequest{shape: sh}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxCallerBody+1))
	if err != nil {
		return nil, cr, api.BadRequest("Send the whole JSON body.", "The request body could not be read: %v", err)
	}
	if len(body) > maxCallerBody {
		return nil, cr, api.Errorf(http.StatusRequestEntityTooLarge, "request_too_large", "Send a body of at most 64 MiB.", "The request body is larger than 64 MiB.")
	}
	hint := specOf(sh).bodyHint
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
	if sh == shape.Gemini {
		return body, cr, readGeminiTarget(r, &cr)
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
