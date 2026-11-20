package gateway

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/hosts"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/normalise"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/rules"
)

// Trying a failure (UI ticket 34): the Owner types an upstream answer and
// sees what the live Failure Rules decide for one Provider. The answer is
// read by the same code an Attempt uses (failureBody, answerFailure in
// embedded.go), classified by the live rules.Set and passed through
// noCredential, so it can never drift from what the Gateway does. Nothing is
// sent, stored, counted or logged.

// ClassifyFailure is the body of POST /api/providers/{provider}/rules/classify.
type ClassifyFailure struct {
	Status      int               `json:"status" doc:"The upstream HTTP status (100-599); 0 for no response at all (a network failure, or with timeout a time-out)."`
	Body        string            `json:"body,omitempty" doc:"The response body as the Provider sent it: JSON, text, an HTML page or a server-sent event stream (data: lines). A 2xx body is read as an Attempt reads it: an error inside it is a failure."`
	Headers     map[string]string `json:"headers,omitempty" doc:"Response headers, such as Retry-After. Without Content-Type, a body starting with data:, event: or : is read as an event stream, one starting with { or [ as JSON."`
	Timeout     bool              `json:"timeout,omitempty" doc:"With status 0: no response arrived within the time budget."`
	Model       string            `json:"model,omitempty" doc:"The model the Attempt asked for; named in the result's key_effect for per-model outcomes."`
	Endpoint    string            `json:"endpoint,omitempty" doc:"Name or ID of the Endpoint that answered; rules limited to a host match on its host. Default: the Provider's first Endpoint."`
	UpstreamKey string            `json:"upstream_key,omitempty" doc:"Name or ID of the Upstream Key that was sent. A keyless key (empty secret), like an Endpoint with auth style none, sent no credential, so an invalid verdict becomes retry_elsewhere as in an Attempt."`
}

// Classification is what the Failure Rules decide for a ClassifyFailure.
type Classification struct {
	DryRun         bool          `json:"dry_run" doc:"Echoes dry_run; this call never changes anything either way."`
	Provider       string        `json:"provider"`
	Endpoint       string        `json:"endpoint,omitempty" doc:"The Endpoint the failure was read as coming from; empty when the Provider has none."`
	Host           string        `json:"host,omitempty" doc:"Its host, which rules limited to a host match on."`
	Failure        bool          `json:"failure" doc:"false: a 2xx answer that is no failure; Iroha would relay it to the Caller and no rule is tried."`
	Rule           string        `json:"rule,omitempty" doc:"The Failure Rule that matched; empty when none did (5xx and no response then retry elsewhere, anything else fails the Request)."`
	Outcome        rules.Outcome `json:"outcome,omitempty" enum:"invalid,cooling_key,cooling_key_model,model_gap,retry_elsewhere,fail_request"`
	Status         int           `json:"status" doc:"The status the failure was read as: the upstream status, or for an error inside a 2xx answer the status the error stands for; 0 for no response."`
	Embedded       bool          `json:"embedded" doc:"true when the error came inside a 2xx answer."`
	Reason         string        `json:"reason,omitempty" doc:"The one line the Requests page shows for such a failed Attempt."`
	KeyEffect      string        `json:"key_effect" doc:"What happens to the Upstream Key, in words: Mark invalid, Cool 30 s (for the model), Record Model Gap (for the model), No change. Mark invalid on an Endpoint where a key that works elsewhere is refused becomes an Endpoint Gap."`
	RequestEffect  string        `json:"request_effect" enum:"Try next key,Return to Caller,Relay the answer" doc:"What happens to the Request."`
	CoolingSeconds int           `json:"cooling_seconds,omitempty" doc:"For cooling outcomes: how long a key that has not cooled in the last hour cools (repeats of the default double, up to 1 h)."`
	CoolingFrom    string        `json:"cooling_from,omitempty" enum:"response,rule,default" doc:"Where cooling_seconds comes from: a reset time the response names (the rule's reset sources, Retry-After-Ms, Retry-After), the rule's cooling_seconds, or the 60 s default."`
}

// ClassifyRoutes are the routes trying a failure against the Failure Rules.
func (g *Gateway) ClassifyRoutes() []api.Route {
	return []api.Route{{
		Method: http.MethodPost, Path: "/api/providers/{provider}/rules/classify", Tag: "Failure Rules",
		Summary: "Try a failure against a Provider's Failure Rules: which rule matches and what it does, without sending or storing anything",
		Description: "Reads the answer exactly as an Attempt on the Endpoint would (an error inside a 2xx answer, codes from the JSON error fields, an event stream by its first data payload, the Endpoint's host for host-limited rules) " +
			"and classifies it with the rules in force, switched-off rules skipped. Nothing is sent to the Provider, no Key State changes, no hit is counted and no Audit Entry is written.",
		Query: []api.Param{audit.DryRun}, Request: ClassifyFailure{}, Response: Classification{},
		Handle: g.classifyRoute,
	}}
}

func (g *Gateway) classifyRoute(c *api.Call) (any, error) {
	dry, err := audit.IsDryRun(c)
	if err != nil {
		return nil, err
	}
	var in ClassifyFailure
	if err := c.Decode(&in); err != nil {
		return nil, err
	}
	if in.Status != 0 && (in.Status < 100 || in.Status > 599) {
		return nil, api.BadRequest("Send status 100-599, or 0 for no response.", "status %d is not an HTTP status.", in.Status)
	}
	rt, err := g.providers.ResolveRouting(c.R.Context(), c.Path("provider"))
	if err != nil {
		return nil, err
	}
	list := "GET /api/providers/" + rt.Handle + "/endpoints"
	ep := &planner.Endpoint{}
	switch {
	case in.Endpoint != "":
		ep = nil
		for i := range rt.Endpoints {
			if e := &rt.Endpoints[i]; e.ID == in.Endpoint || (ep == nil && e.Name == in.Endpoint) {
				ep = e
			}
		}
		if ep == nil {
			return nil, api.NotFound("List them with "+list+"; address one by its name or ID.", "Provider %s has no Endpoint named %q or with that ID.", rt.Handle, in.Endpoint)
		}
	case len(rt.Endpoints) > 0:
		ep = &rt.Endpoints[0]
	}
	key := &planner.Key{Secret: "set"} // no key named: one that sends a credential
	if in.UpstreamKey != "" {
		if key, err = g.providers.ResolveKey(c.R.Context(), &rt, in.UpstreamKey); err != nil {
			return nil, err
		}
	}
	out := Classification{DryRun: dry, Provider: rt.Handle, Endpoint: ep.Name, Host: hosts.Of(ep.URL), Failure: true}
	f, failed := readFailure(in, *ep)
	if !failed {
		out.Failure, out.Status, out.KeyEffect, out.RequestEffect = false, in.Status, "No change", "Relay the answer"
		return out, nil
	}
	f.Provider, f.Host = rt.Handle, out.Host
	now := g.clock.Now()
	d := noCredential(g.rules().Classify(f, now), planner.Candidate{Endpoint: ep, Key: key})
	out.Rule, out.Outcome, out.Status, out.Reason = d.Rule, d.Outcome, d.Status, d.Reason
	out.Embedded = in.Status >= 200 && in.Status < 300
	out.RequestEffect = "Return to Caller"
	if d.Outcome.Retries() {
		out.RequestEffect = "Try next key"
	}
	forModel := ""
	if d.Outcome == rules.CoolingKeyModel || d.Outcome == rules.ModelGap {
		forModel = " for the model"
		if in.Model != "" {
			forModel = " for " + in.Model
		}
	}
	switch d.Outcome {
	case rules.Invalid:
		out.KeyEffect = "Mark invalid"
	case rules.ModelGap:
		out.KeyEffect = "Record Model Gap" + forModel
	case rules.CoolingKey, rules.CoolingKeyModel:
		until := keystate.FirstCooling(d, now)
		out.CoolingSeconds = int((until.Sub(now) + time.Second - 1) / time.Second)
		switch {
		case !d.ResetAt.IsZero():
			out.CoolingFrom = "response"
		case d.Cooling > 0:
			out.CoolingFrom = "rule"
		default:
			out.CoolingFrom = "default"
		}
		out.KeyEffect = "Cool " + durationWords(out.CoolingSeconds) + forModel
	default:
		out.KeyEffect = "No change"
	}
	return out, nil
}

// readFailure builds the upstream answer the Owner typed and reads it as an
// Attempt on ep does. failed is false for a 2xx answer that is no failure.
func readFailure(in ClassifyFailure, ep planner.Endpoint) (f rules.Failure, failed bool) {
	if in.Status == 0 {
		what := "no response"
		if in.Timeout {
			what = "no response within the time budget"
		}
		return rules.Failure{Timeout: in.Timeout, Err: what}, true
	}
	h := http.Header{}
	for k, v := range in.Headers {
		h.Set(k, v)
	}
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", contentTypeOf(in.Body))
	}
	resp := &http.Response{StatusCode: in.Status, Header: h, Body: io.NopCloser(strings.NewReader(in.Body))}
	if in.Status < 200 || in.Status >= 300 {
		body, _ := failureBody(resp) // reading a string cannot fail
		return rules.Failure{Status: in.Status, Header: h, Body: body}, true
	}
	// A pasted stream is the answer to a streamed request; passthrough, as
	// the Caller's Shape is not known.
	body := answerFailure(resp, isEventStream(h), normalise.For(ep.URL, ep.Shape), false)
	if body == nil {
		return rules.Failure{}, false
	}
	return rules.Failure{Status: in.Status, Header: h, Body: body}, true
}

// contentTypeOf guesses a typed body's Content-Type: an event stream, JSON
// or text.
func contentTypeOf(body string) string {
	b := bytes.TrimSpace([]byte(body))
	switch {
	case bytes.HasPrefix(b, []byte("data:")) || bytes.HasPrefix(b, []byte("event:")) || bytes.HasPrefix(b, []byte(":")):
		return "text/event-stream"
	case bytes.HasPrefix(b, []byte("{")) || bytes.HasPrefix(b, []byte("[")):
		return "application/json"
	}
	return "text/plain; charset=utf-8"
}

// durationWords is a cooling time as the rules list words it: 30 s, 15 min,
// 2 h, 1 h 30 min.
func durationWords(s int) string {
	switch {
	case s < 120:
		return fmt.Sprintf("%d s", s)
	case s < 3600 && s%60 == 0:
		return fmt.Sprintf("%d min", s/60)
	case s < 3600:
		return fmt.Sprintf("%d min %d s", s/60, s%60)
	case s%3600 == 0:
		return fmt.Sprintf("%d h", s/3600)
	}
	return fmt.Sprintf("%d h %d min", s/3600, s%3600/60)
}
