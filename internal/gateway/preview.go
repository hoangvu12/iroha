package gateway

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/shape"
)

// The route preview (ticket 18): where a Request for a Pool or a
// <provider>/<model> would go right now. It resolves the model with the
// global route's resolver and plans with planner.Plan, as live traffic
// does, peeking at the live rotation without moving it; nothing is sent and
// nothing is written.

// RoutePreview is the response of GET /api/route-preview.
type RoutePreview struct {
	Model   string          `json:"model" doc:"The model as asked: a Pool name or <provider>/<model>."`
	Pool    string          `json:"pool,omitempty" doc:"The Pool's name, when model names one."`
	Shape   shape.Shape     `json:"shape" doc:"The Caller Shape planned for."`
	As      string          `json:"as,omitempty" doc:"The Gateway Key whose scope was applied; absent: no scope (everything)."`
	At      time.Time       `json:"at" doc:"The time Key States were judged at."`
	Budget  PreviewBudget   `json:"budget" doc:"The Request budget the first candidate would start (absent fields: nothing to try)."`
	Members []PreviewMember `json:"members" doc:"Every member in Pool order (one for <provider>/<model>), switched-off and unusable ones included."`
	Ready   int             `json:"ready" doc:"Candidates (key and Endpoint pairs) across all members, in the order of members[].candidates."`
	Outcome *PreviewOutcome `json:"outcome,omitempty" doc:"Set when a Caller would be refused before any Attempt: the error it would get."`
}

// PreviewBudget is the budget of a previewed Request.
type PreviewBudget struct {
	MaxAttempts      int `json:"max_attempts,omitempty"`
	FirstByteSeconds int `json:"first_byte_seconds,omitempty"`
}

// PreviewMember is one Pool member (or the one Provider) in a route preview.
type PreviewMember struct {
	Position   int                `json:"position" doc:"1 for the first member tried."`
	Provider   string             `json:"provider" doc:"Provider handle."`
	Model      string             `json:"model" doc:"The model asked of the Provider (before Endpoint renames)."`
	Enabled    bool               `json:"enabled" doc:"false: switched off in the Pool."`
	Planned    bool               `json:"planned" doc:"true: Iroha would try this member's candidates, after the earlier members'."`
	NotPlanned string             `json:"not_planned,omitempty" enum:"off,provider_unavailable,model_not_offered" doc:"Why the member is left out."`
	Reason     string             `json:"reason,omitempty" doc:"The same in a sentence."`
	Keys       int                `json:"keys" doc:"Upstream Keys of the Provider."`
	ReadyKeys  int                `json:"ready_keys" doc:"Keys with at least one candidate."`
	Candidates []PreviewCandidate `json:"candidates" doc:"What Iroha would try for this member, in order."`
	Skipped    []PreviewSkip      `json:"skipped" doc:"Keys left out right now, each with why and until when."`
	Empty      *PreviewEmpty      `json:"empty,omitempty" doc:"Set when a planned member has no candidate: why."`
}

// PreviewCandidate is one Attempt Iroha would make.
type PreviewCandidate struct {
	Endpoint    string      `json:"endpoint" doc:"Endpoint name."`
	Shape       shape.Shape `json:"shape" doc:"The Endpoint's Shape."`
	Translated  bool        `json:"translated" doc:"true when the request would be translated to the Endpoint's Shape."`
	UpstreamKey string      `json:"upstream_key" doc:"Upstream Key name."`
	WireModel   string      `json:"wire_model" doc:"The model name sent on that Endpoint."`
	Carrier     bool        `json:"carrier" doc:"true when the key's own discovered model list names the wire model (tried first)."`
}

// PreviewSkip is a key left out of the plan.
type PreviewSkip struct {
	UpstreamKey string     `json:"upstream_key"`
	Reason      string     `json:"reason" enum:"disabled,invalid,cooling,cooling_model,model_gap,restricted" doc:"cooling: the whole key; cooling_model: the key for this model; model_gap: the Provider refused this key the model; restricted: the key may not use the Endpoints that serve."`
	Model       string     `json:"model,omitempty" doc:"The wire model, for cooling_model and model_gap."`
	Until       *time.Time `json:"until,omitempty" doc:"When the cooling ends or the Model Gap expires."`
	SecondsLeft int        `json:"seconds_left,omitempty" doc:"Whole seconds until then."`
}

// PreviewEmpty explains a planned member with no candidate.
type PreviewEmpty struct {
	Code    string     `json:"code" enum:"no_endpoint,no_upstream_key,no_usable_key,cooling,model_gap"`
	Message string     `json:"message"`
	Until   *time.Time `json:"until,omitempty"`
}

// PreviewOutcome is the error a Caller would get before any Attempt.
type PreviewOutcome struct {
	Status  int    `json:"status"`
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
}

// PreviewRoutes are the route preview's admin routes.
func (g *Gateway) PreviewRoutes() []api.Route {
	return []api.Route{{
		Method: http.MethodGet, Path: "/api/route-preview", Tag: "Model Pools",
		Summary: "Show where a Request for a Pool or <provider>/<model> would go right now, without sending anything",
		Description: "Plans exactly as live traffic does: members in Pool order (switched-off and unusable ones reported, not planned), " +
			"within each the Endpoints and Upstream Keys in try order (the next Request's round-robin start), and every key left out with its reason " +
			"and until-time (cooling, Model Gap...). With as=<Gateway Key> the key's scope applies, and a model outside it shows the refusal " +
			"that key would get. Nothing is sent and no Key State changes.",
		Query: []api.Param{
			{Name: "model", Required: true, Description: "A Model Pool name, or <provider handle>/<model ID>, as a Caller would send it to the global routes."},
			{Name: "shape", Description: "The Caller's Shape. Default openai-chat.", Enum: []string{"openai-chat", "openai-responses", "anthropic-messages", "gemini"}},
			{Name: "as", Description: "A Gateway Key (name or ID) whose scope to apply. Default: no scope."},
		},
		Response: RoutePreview{},
		Handle: func(c *api.Call) (any, error) {
			return g.preview(c.R.Context(), c.Query("model"), c.Query("shape"), c.Query("as"))
		},
	}}
}

func (g *Gateway) preview(ctx context.Context, model, sh, as string) (RoutePreview, error) {
	model = strings.TrimSpace(model)
	if model == "" {
		return RoutePreview{}, api.BadRequest("Send ?model=<pool> or ?model=<provider>/<model>.", "model is required.")
	}
	if sh == "" {
		sh = string(shape.OpenAIChat)
	}
	if !shape.Shape(sh).Valid() {
		return RoutePreview{}, api.BadRequest("Use shape openai-chat, openai-responses, anthropic-messages or gemini.", "shape %q is not a Shape.", sh)
	}
	caller := gatewaykeys.Unrestricted("Owner")
	if as != "" {
		var err error
		if caller, err = g.keys.CallerOf(ctx, as); err != nil {
			return RoutePreview{}, err
		}
	}
	now := g.clock.Now()
	out := RoutePreview{Model: model, Shape: shape.Shape(sh), At: now.UTC(), Members: []PreviewMember{}}
	if as != "" {
		out.As = caller.Name
	}

	// The live resolver on an exchange that answers no one.
	x := &exchange{g: g, ctx: ctx, start: now}
	rt, aerr := x.global(caller, model)
	if rt.pool != nil {
		out.Pool = rt.pool.Name
	}
	if aerr != nil && len(rt.members) == 0 {
		out.Outcome = outcomeOf(aerr)
		return out, nil
	}
	req := planRequest(shape.Shape(sh), rt, now)
	rot := g.rotation.Peek()
	plan := planner.Plan(req, rt.providers, rot)

	// One entry per member: a Pool's notes, or the one Provider.
	notes := rt.members
	if rt.pool == nil {
		notes = []memberNote{{planned: 0}}
	}
	for i, n := range notes {
		m := PreviewMember{Position: i + 1, Provider: n.member.Handle, Model: n.member.Model, Enabled: n.member.Enabled || rt.pool == nil,
			NotPlanned: n.reason, Reason: n.detail, Candidates: []PreviewCandidate{}, Skipped: []PreviewSkip{}}
		if n.planned < 0 {
			out.Members = append(out.Members, m)
			continue
		}
		p := &rt.providers[n.planned]
		m.Provider, m.Model, m.Planned, m.Keys = p.Handle, p.ModelFor(req), true, len(p.Keys)
		ready := map[string]bool{}
		for _, c := range plan.Candidates {
			if c.Provider != p {
				continue
			}
			ready[c.Key.ID] = true
			m.Candidates = append(m.Candidates, PreviewCandidate{Endpoint: c.Endpoint.Name, Shape: c.Endpoint.Shape, Translated: c.Endpoint.Shape != req.Shape,
				UpstreamKey: c.Key.Name, WireModel: c.WireModel, Carrier: c.Key.Carries[c.WireModel]})
		}
		m.ReadyKeys = len(ready)
		for _, s := range plan.Skipped {
			if s.Provider != p {
				continue
			}
			ps := PreviewSkip{UpstreamKey: s.Key.Name, Reason: s.Reason, Model: s.Model}
			if !s.Until.IsZero() {
				u := s.Until.UTC()
				ps.Until, ps.SecondsLeft = &u, retryAfter(s.Until, now)
			}
			m.Skipped = append(m.Skipped, ps)
		}
		if len(m.Candidates) == 0 {
			// The member alone, planned the same way, says why it has none.
			if e := planner.Plan(req, []planner.Provider{*p}, rot).Empty; e != nil {
				m.Empty = &PreviewEmpty{Code: e.Code, Message: e.Message}
				if !e.Until.IsZero() {
					u := e.Until.UTC()
					m.Empty.Until = &u
				}
			}
		}
		out.Ready += len(m.Candidates)
		out.Members = append(out.Members, m)
	}
	switch {
	case aerr != nil:
		out.Outcome = outcomeOf(aerr)
	case len(plan.Candidates) == 0:
		out.Outcome = outcomeOf(rt.noCandidate(plan.Empty))
	default:
		n, fb := x.budget(plan.Candidates[0].Provider)
		out.Budget = PreviewBudget{MaxAttempts: n, FirstByteSeconds: int(fb / time.Second)}
	}
	return out, nil
}

func outcomeOf(e *api.Error) *PreviewOutcome {
	return &PreviewOutcome{Status: e.Status, Code: e.Code, Message: e.Message, Hint: e.Hint}
}
