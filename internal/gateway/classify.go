package gateway

import (
	"bytes"
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

type ClassifyFailure struct {
	Status      int               `json:"status" doc:"The upstream HTTP status (100-599); 0 for no response at all (a network failure, or with timeout a time-out)."`
	Body        string            `json:"body,omitempty" doc:"The response body as the Provider sent it: JSON, text, an HTML page or a server-sent event stream (data: lines). A 2xx body is read as an Attempt reads it: an error inside it is a failure."`
	Headers     map[string]string `json:"headers,omitempty" doc:"Response headers, such as Retry-After. Without Content-Type, a body starting with data:, event: or : is read as an event stream, one starting with { or [ as JSON."`
	Timeout     bool              `json:"timeout,omitempty" doc:"With status 0: no response arrived within the time budget."`
	Translated  bool              `json:"translated,omitempty" doc:"true: the answer would be translated to the Caller's Shape (the Caller used another Shape than the Endpoint's), so a whole 2xx body that is not JSON (an HTML page) is a failure, read as a 502. Default false: passthrough, where such a body is relayed as it came."`
	Model       string            `json:"model,omitempty" doc:"The model the Attempt asked for; named in the result's key_effect for per-model outcomes."`
	Endpoint    string            `json:"endpoint,omitempty" doc:"Name or ID of the Endpoint that answered; rules limited to a host match on its host. Default: the Provider's first Endpoint."`
	UpstreamKey string            `json:"upstream_key,omitempty" doc:"Name or ID of the Upstream Key that was sent. A keyless key (empty secret), like an Endpoint with auth style none, sent no credential, so an invalid verdict becomes retry_elsewhere as in an Attempt."`
}

type Classification struct {
	DryRun         bool          `json:"dry_run" doc:"Echoes dry_run; this call never changes anything either way."`
	Provider       string        `json:"provider"`
	Endpoint       string        `json:"endpoint,omitempty" doc:"The Endpoint the failure was read as coming from; empty when the Provider has none."`
	Host           string        `json:"host,omitempty" doc:"Its host, which rules limited to a host match on."`
	Failure        bool          `json:"failure" doc:"false: a 2xx answer that is no failure; Iroha would relay it to the Caller and no rule is tried."`
	Rule           string        `json:"rule,omitempty" doc:"The Failure Rule that matched; empty when none did (5xx and no response then retry elsewhere, anything else fails the Request)."`
	Outcome        rules.Outcome `json:"outcome,omitempty" enum:"invalid,cooling_key,cooling_key_model,model_gap,retry_elsewhere,fail_request"`
	Status         int           `json:"status" doc:"The status the failure was read as: the upstream status, or for an error inside a 2xx answer the status the error stands for; 0 for no response."`
	Embedded       bool          `json:"embedded" doc:"true when an error came inside a 2xx answer (not for a 2xx failing otherwise: a normaliser's finding, or a body that is not JSON on a translated path)."`
	Reason         string        `json:"reason,omitempty" doc:"The one line the Requests page shows for such a failed Attempt."`
	KeyEffect      string        `json:"key_effect" doc:"What happens to the Upstream Key, in words: Mark invalid, Cool 30 s (for the model), Record Model Gap (for the model), No change. Mark invalid on an Endpoint where a key that works elsewhere is refused becomes an Endpoint Gap."`
	RequestEffect  string        `json:"request_effect" enum:"Try next key,Return to Caller,Relay the answer" doc:"What happens to the Request."`
	CoolingSeconds int           `json:"cooling_seconds,omitempty" doc:"For cooling outcomes: how long a key that has not cooled in the last hour cools (repeats of the default double, up to 1 h)."`
	CoolingFrom    string        `json:"cooling_from,omitempty" enum:"response,rule,default" doc:"Where cooling_seconds comes from: a reset time the response names (the rule's reset sources, Retry-After-Ms, Retry-After), the rule's cooling_seconds, or the 60 s default."`
}

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
	ep := &planner.Endpoint{}
	switch {
	case in.Endpoint != "":
		if ep, err = endpointOf(&rt, in.Endpoint); err != nil {
			return nil, err
		}
	case len(rt.Endpoints) > 0:
		ep = &rt.Endpoints[0]
	}
	key := keySendingACredential()
	if in.UpstreamKey != "" {
		if key, err = g.providers.ResolveKey(c.R.Context(), &rt, in.UpstreamKey); err != nil {
			return nil, err
		}
	}
	out := Classification{DryRun: dry, Provider: rt.Handle, Endpoint: ep.Name, Host: hosts.Of(ep.URL), Failure: true}
	f, failed, embedded := readFailure(in, *ep)
	if !failed {
		out.Failure, out.Status, out.KeyEffect, out.RequestEffect = false, in.Status, "No change", "Relay the answer"
		return out, nil
	}
	f.Provider, f.Host = rt.Handle, out.Host
	now := g.clock.Now()
	d := noCredential(g.rules().Classify(f, now), planner.Candidate{Endpoint: ep, Key: key})
	out.Rule, out.Outcome, out.Status, out.Reason = d.Rule, d.Outcome, d.Status, d.Reason
	out.Embedded = embedded
	out.RequestEffect = d.Outcome.RequestEffect()
	cool := ""
	if d.Outcome.Cools() {
		until := keystate.FirstCooling(d, now)
		out.CoolingSeconds = int((until.Sub(now) + time.Second - 1) / time.Second)
		switch {
		case !d.ResetAt.IsZero() && d.ResetAt.After(now):
			out.CoolingFrom = "response"
		case d.Cooling > 0:
			out.CoolingFrom = "rule"
		default:
			out.CoolingFrom = "default"
		}
		cool = rules.Seconds(out.CoolingSeconds)
	}
	out.KeyEffect = rules.KeyEffect(d.Outcome, cool, in.Model)
	return out, nil
}

func keySendingACredential() *planner.Key { return &planner.Key{Secret: "any"} }

func readFailure(in ClassifyFailure, ep planner.Endpoint) (f rules.Failure, failed, embedded bool) {
	if in.Status == 0 {
		what := "no response"
		if in.Timeout {
			what = "no response within the time budget"
		}
		return rules.Failure{Timeout: in.Timeout, Err: what}, true, false
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
		body, _ := failureBody(resp) // a strings.Reader never fails
		return rules.Failure{Status: in.Status, Header: h, Body: body}, true, false
	}
	body, embedded := answerFailure(resp, isEventStream(h), normalise.For(ep.URL, ep.Shape), in.Translated)
	if body == nil {
		return rules.Failure{}, false, false
	}
	return rules.Failure{Status: in.Status, Header: h, Body: body}, true, embedded
}

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
