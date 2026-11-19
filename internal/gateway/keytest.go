package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/shape"
)

// KindKeyTest is logged after every key test.
var KindKeyTest = logs.NewKind("key.test", "An Upstream Key test (a tiny real chat call) finished: upstream_key, endpoint, model, passed, status, rule, reason.")

// A key test is a tiny real chat call: a key whose account is dead often
// still answers 200 on /models, so only a completion proves it works.
const (
	keyTestTimeout     = 30 * time.Second
	keyTestConcurrency = 5
	keyTestPrompt      = "Reply with the word OK."
)

// KeyTestResult is the outcome of one key test.
type KeyTestResult struct {
	DryRun      bool           `json:"dry_run" doc:"true when nothing was sent."`
	Provider    string         `json:"provider"`
	UpstreamKey string         `json:"upstream_key"`
	Endpoint    string         `json:"endpoint"`
	Model       string         `json:"model" doc:"The model sent upstream."`
	Passed      bool           `json:"passed" doc:"true when the Provider answered the chat call with a 2xx that is not an error (an error inside a 200, such as MiniMax's base_resp, fails the test)."`
	Status      int            `json:"status" doc:"Upstream status; 0 when no answer arrived (or on a dry run)."`
	Rule        string         `json:"rule,omitempty" doc:"The Failure Rule a failed test matched."`
	Outcome     string         `json:"outcome,omitempty" enum:"invalid,cooling_key,cooling_key_model,model_gap,retry_elsewhere,fail_request"`
	Reason      string         `json:"reason,omitempty" doc:"What the Provider answered, when the test failed."`
	Action      string         `json:"action" doc:"What the test did to the key's Key State."`
	DurationMs  int64          `json:"duration_ms"`
	State       keystate.State `json:"state" doc:"The key's Key State after the test."`
}

// KeyTestItem is one item of a bulk key test.
type KeyTestItem struct {
	Index  int            `json:"index"`
	OK     bool           `json:"ok" doc:"true when the test ran (read result.passed for its verdict)."`
	Result *KeyTestResult `json:"result,omitempty"`
	Error  *api.Error     `json:"error,omitempty" doc:"Why the test could not run."`
}

// KeyTestBulk is the response of a bulk key test.
type KeyTestBulk struct {
	DryRun bool          `json:"dry_run"`
	Passed int           `json:"passed"`
	Failed int           `json:"failed" doc:"Tests that ran and did not pass, plus items that could not be tested."`
	Items  []KeyTestItem `json:"items"`
}

var (
	testModelParam    = api.Param{Name: "model", Description: "The model to ask for. Default: the model of the Provider's latest successful Request."}
	testEndpointParam = api.Param{Name: "endpoint", Description: "The Endpoint (name or ID) to test on. Default: the first Endpoint the key may use."}
)

const keyTestDescription = "Sends a tiny real chat call (\"" + keyTestPrompt + "\", at most 16 tokens) with the key, in the Endpoint's Shape and auth style, " +
	"on the first Endpoint the key may use (or ?endpoint=). " +
	"A pass makes an invalid or cooling key active again and clears its Model Gaps. A failure is read by the Failure Rules like any Attempt, so a 401 makes the key invalid and a 429 cools it; " +
	"a keyless test (empty secret or auth style none) sends no credential, so a 401 then leaves the key as it is. " +
	"Disabled keys are tested too and stay disabled. The test is not recorded as a Request."

// AdminRoutes are the admin routes the Gateway serves: key tests.
func (g *Gateway) AdminRoutes() []api.Route {
	const tag = "Upstream Keys"
	return []api.Route{
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/{key}/test", Tag: tag,
			Summary: "Test an Upstream Key with a tiny real chat call", Description: keyTestDescription,
			Query: []api.Param{audit.DryRun, testModelParam, testEndpointParam}, Response: KeyTestResult{},
			Handle: func(c *api.Call) (any, error) {
				dry, err := audit.IsDryRun(c)
				if err != nil {
					return nil, err
				}
				ctx := c.R.Context()
				rt, err := g.providers.ResolveRouting(ctx, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				k, err := g.providers.ResolveKey(ctx, &rt, c.Path("key"))
				if err != nil {
					return nil, err
				}
				model, err := g.testModel(ctx, &rt, c.Query("model"))
				if err != nil {
					return nil, err
				}
				return g.testKey(ctx, &rt, k, model, c.Query("endpoint"), dry)
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/bulk/test", Tag: tag,
			Summary:     "Test many Upstream Keys of a Provider, each by name or ID",
			Description: keyTestDescription + ` Body {"items": ["key-1", "uk_..."]}; up to 5 tests run at once. Each item reports its own result or error.`,
			Query:       []api.Param{audit.DryRun, testModelParam, testEndpointParam},
			Request:     audit.BulkRequest[string]{}, Response: KeyTestBulk{},
			Handle: func(c *api.Call) (any, error) {
				dry, err := audit.IsDryRun(c)
				if err != nil {
					return nil, err
				}
				var in audit.BulkRequest[string]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				if len(in.Items) == 0 || len(in.Items) > audit.MaxBulkItems {
					return nil, api.BadRequest(fmt.Sprintf(`Send {"items": [...]} with 1 to %d key names or IDs.`, audit.MaxBulkItems), "The bulk call has %d items.", len(in.Items))
				}
				ctx := c.R.Context()
				rt, err := g.providers.ResolveRouting(ctx, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				model, err := g.testModel(ctx, &rt, c.Query("model"))
				if err != nil {
					return nil, err
				}
				out := KeyTestBulk{DryRun: dry, Items: make([]KeyTestItem, len(in.Items))}
				sem := make(chan struct{}, keyTestConcurrency)
				var wg sync.WaitGroup
				for i, ref := range in.Items {
					out.Items[i].Index = i
					k, err := g.providers.ResolveKey(ctx, &rt, ref)
					if err != nil {
						out.Items[i].Error = api.AsError(err)
						continue
					}
					wg.Add(1)
					go func() {
						defer wg.Done()
						sem <- struct{}{}
						defer func() { <-sem }()
						res, err := g.testKey(ctx, &rt, k, model, c.Query("endpoint"), dry)
						if err != nil {
							out.Items[i].Error = api.AsError(err)
							return
						}
						out.Items[i].OK, out.Items[i].Result = true, &res
					}()
				}
				wg.Wait()
				for _, it := range out.Items {
					if it.OK && it.Result.Passed {
						out.Passed++
					} else if !dry || !it.OK {
						out.Failed++
					}
				}
				return out, nil
			},
		},
	}
}

// testModel is the model a key test asks for.
func (g *Gateway) testModel(ctx context.Context, rt *providers.Routing, given string) (string, error) {
	if given != "" {
		return given, nil
	}
	m, err := g.rec.LastServedModel(ctx, rt.ID)
	if err != nil {
		return "", err
	}
	if m == "" {
		return "", api.Errorf(http.StatusBadRequest, "model_required", "Pass ?model=<a model the Provider serves>.",
			"Provider %s has served no Request yet, so the test needs a model.", rt.Handle)
	}
	return m, nil
}

// testKey runs one key test and applies its verdict to the Key State.
func (g *Gateway) testKey(ctx context.Context, rt *providers.Routing, k *planner.Key, model, endpoint string, dry bool) (KeyTestResult, error) {
	res := KeyTestResult{DryRun: dry, Provider: rt.Handle, UpstreamKey: k.Name}
	ep, err := testEndpoint(rt, k, endpoint)
	if err != nil {
		return res, err
	}
	wire := ep.WireModel(model)
	res.Endpoint, res.Model = ep.Name, wire
	if dry {
		res.Action = "Nothing sent (dry run)."
		st, err := g.providers.KeyState(ctx, k.ID)
		res.State = st
		return res, err
	}
	ctx = context.WithoutCancel(ctx) // a test the Owner asked for finishes and records its verdict
	op, body, header := testCall(ep.Shape, wire)
	c := planner.Candidate{Provider: &rt.Provider, Endpoint: ep, Key: k, WireModel: wire}
	started := g.clock.Now()
	actx, _, release := deadlineContext(ctx, g.clock, started.Add(keyTestTimeout))
	defer release()
	f := &rules.Failure{Provider: rt.Handle, Host: hostOf(ep.URL)}
	req, err := outbound(actx, c, header, body, op, false)
	if err != nil {
		return res, api.Conflict("endpoint_misconfigured", "Fix the Endpoint (GET /api/providers/"+rt.Handle+"/endpoints).", "%s", err.Error())
	}
	resp, err := g.http.Do(req)
	if err != nil {
		f.Err = transportError(err)
		if context.Cause(actx) == errFirstByte {
			f.Timeout, f.Err = true, fmt.Sprintf("no answer within %s", keyTestTimeout)
		}
	} else {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, requests.MaxFailureBody))
		resp.Body.Close()
		f.Status, f.Header, f.Body = resp.StatusCode, resp.Header, data
	}
	res.Status = f.Status
	res.DurationMs = g.clock.Now().Sub(started).Milliseconds()
	key := keystate.Key{ID: k.ID, Name: k.Name, Provider: rt.Handle}
	// An error sent inside a 2xx answer (MiniMax's base_resp) fails the test
	// as it fails an Attempt: rules.Classify reads it as the status it stands for.
	if f.Status >= 200 && f.Status < 300 && !rules.EmbeddedError(f.Body) {
		res.Passed = true
		res.Action = "Key State is active: the Provider answered the chat call."
		if err := g.states.TestPassed(ctx, key, wire); err != nil {
			return res, err
		}
	} else {
		d := noCredential(g.rules().Classify(*f, g.clock.Now()), c)
		res.Rule, res.Outcome, res.Reason = d.Rule, string(d.Outcome), d.Reason
		res.Action = "Key State unchanged."
		switch d.Outcome {
		case rules.Invalid, rules.CoolingKey, rules.CoolingKeyModel, rules.ModelGap:
			eff, err := g.states.Fail(ctx, keystate.Failure{Key: key, Model: wire, Decision: d})
			if err != nil {
				return res, err
			}
			res.Action = eff.Action
		}
	}
	st, err := g.providers.KeyState(ctx, k.ID)
	if err != nil {
		return res, err
	}
	res.State = st
	attrs := []any{logs.Kind(KindKeyTest), logs.Provider(rt.Handle), "upstream_key", k.Name, "endpoint", ep.Name, "model", wire,
		"passed", res.Passed, "status", res.Status}
	if !res.Passed {
		attrs = append(attrs, "rule", res.Rule, "reason", res.Reason)
	}
	g.log.Info("Upstream Key tested", attrs...)
	return res, nil
}

// testEndpoint is the Endpoint a key test uses: the one named by ref, or
// the first one the key may use.
func testEndpoint(rt *providers.Routing, k *planner.Key, ref string) (*planner.Endpoint, error) {
	list := "GET /api/providers/" + rt.Handle + "/endpoints"
	if ref != "" {
		var ep *planner.Endpoint
		for i := range rt.Endpoints {
			if e := &rt.Endpoints[i]; e.ID == ref || (ep == nil && e.Name == ref) {
				ep = e
			}
		}
		switch {
		case ep == nil:
			return nil, api.NotFound("List them with "+list+"; address one by its name or ID.",
				"Provider %s has no Endpoint named %q or with that ID.", rt.Handle, ref)
		case !k.Allows(ep.ID):
			return nil, api.Conflict("endpoint_not_allowed", "Test on an Endpoint the key may use (GET /api/providers/"+rt.Handle+"/keys/"+k.Name+" lists them), or lift its restriction.",
				"Upstream Key %s is restricted to other Endpoints than %s.", k.Name, ep.Name)
		}
		return ep, nil
	}
	for i := range rt.Endpoints {
		if k.Allows(rt.Endpoints[i].ID) {
			return &rt.Endpoints[i], nil
		}
	}
	return nil, api.Conflict("no_testable_endpoint", "Add an Endpoint to "+rt.Handle+" (POST /api/providers/"+rt.Handle+"/endpoints); key tests use one.",
		"Provider %s has no Endpoint this key may use.", rt.Handle)
}

// testCall is the tiny chat call of a key test in Shape sh: the operation
// path, the body and any header that Shape needs.
func testCall(sh shape.Shape, model string) (op string, body []byte, header http.Header) {
	header = http.Header{}
	msgs := []any{map[string]any{"role": "user", "content": keyTestPrompt}}
	var v map[string]any
	switch sh {
	case shape.OpenAIResponses:
		op, v = "/responses", map[string]any{"model": model, "input": keyTestPrompt, "max_output_tokens": 16}
	case shape.AnthropicMessages:
		op, v = "/messages", map[string]any{"model": model, "max_tokens": 16, "messages": msgs}
		header.Set("Anthropic-Version", "2023-06-01")
	case shape.Gemini:
		op = "/models/" + url.PathEscape(model) + ":generateContent"
		v = map[string]any{"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": keyTestPrompt}}}},
			"generationConfig": map[string]any{"maxOutputTokens": 16}}
	default:
		op, v = opChat, map[string]any{"model": model, "max_tokens": 16, "messages": msgs}
	}
	body, _ = json.Marshal(v)
	return op, body, header
}
