package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
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
	Passed      bool           `json:"passed" doc:"true when the Provider answered the chat call with a 2xx."`
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

var testModelParam = api.Param{Name: "model", Description: "The model to ask for. Default: the model of the Provider's latest successful Request."}

const keyTestDescription = "Sends a tiny real chat call (\"" + keyTestPrompt + "\", max_tokens 16) with the key on the Provider's first OpenAI Chat Endpoint. " +
	"A pass makes an invalid or cooling key active again and clears its Model Gaps. A failure is read by the Failure Rules like any Attempt, so a 401 makes the key invalid and a 429 cools it. " +
	"Disabled keys are tested too and stay disabled. The test is not recorded as a Request."

// AdminRoutes are the admin routes the Gateway serves: key tests.
func (g *Gateway) AdminRoutes() []api.Route {
	const tag = "Upstream Keys"
	return []api.Route{
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/{key}/test", Tag: tag,
			Summary: "Test an Upstream Key with a tiny real chat call", Description: keyTestDescription,
			Query: []api.Param{audit.DryRun, testModelParam}, Response: KeyTestResult{},
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
				return g.testKey(ctx, &rt, k, model, dry)
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/bulk/test", Tag: tag,
			Summary:     "Test many Upstream Keys of a Provider, each by name or ID",
			Description: keyTestDescription + ` Body {"items": ["key-1", "uk_..."]}; up to 5 tests run at once. Each item reports its own result or error.`,
			Query:       []api.Param{audit.DryRun, testModelParam},
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
						res, err := g.testKey(ctx, &rt, k, model, dry)
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
func (g *Gateway) testKey(ctx context.Context, rt *providers.Routing, k *planner.Key, model string, dry bool) (KeyTestResult, error) {
	res := KeyTestResult{DryRun: dry, Provider: rt.Handle, UpstreamKey: k.Name}
	var ep *planner.Endpoint
	for i := range rt.Endpoints {
		if rt.Endpoints[i].Shape == shape.OpenAIChat {
			ep = &rt.Endpoints[i]
			break
		}
	}
	if ep == nil {
		return res, api.Conflict("no_testable_endpoint", "Add an OpenAI Chat Endpoint to "+rt.Handle+" (POST /api/providers/"+rt.Handle+"/endpoints); key tests use one.",
			"Provider %s has no OpenAI Chat Endpoint to test keys on.", rt.Handle)
	}
	wire := model
	if w, ok := ep.Renames[model]; ok && w != "" {
		wire = w
	}
	res.Endpoint, res.Model = ep.Name, wire
	if dry {
		res.Action = "Nothing sent (dry run)."
		st, err := g.providers.KeyState(ctx, k.ID)
		res.State = st
		return res, err
	}
	ctx = context.WithoutCancel(ctx) // a test the Owner asked for finishes and records its verdict
	body, _ := json.Marshal(map[string]any{"model": wire, "max_tokens": 16,
		"messages": []any{map[string]any{"role": "user", "content": keyTestPrompt}}})
	c := planner.Candidate{Provider: &rt.Provider, Endpoint: ep, Key: k, WireModel: wire}
	started := g.clock.Now()
	actx, _, release := deadlineContext(ctx, g.clock, started.Add(keyTestTimeout))
	defer release()
	f := &rules.Failure{Provider: rt.Handle, Host: hostOf(ep.URL)}
	req, err := outbound(actx, c, http.Header{}, body, opChat, false)
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
	if f.Status >= 200 && f.Status < 300 {
		res.Passed = true
		res.Action = "Key State is active: the Provider answered the chat call."
		if err := g.states.TestPassed(ctx, key, wire); err != nil {
			return res, err
		}
	} else {
		d := g.rules().Classify(*f, g.clock.Now())
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
