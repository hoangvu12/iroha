package gateway

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/testchat"
)

// Test sends (ticket 23): POST /api/test runs the request a Caller of the
// chosen Shape would send (testchat.Build) through run, the same path as
// Gateway Key traffic, with three differences held in exchange.test: the
// Request is recorded as the Test caller ("Test", or "Test (as <key>)"
// with the key's scope), it is always captured, and pins narrow the plan
// to one Upstream Key and/or Endpoint.

// ToolCheckHeader carries the tool check of a non-streamed test answer.
const ToolCheckHeader = "Iroha-Tool-Check"

// toolCheckComment starts the SSE comment that ends a streamed test answer
// with its tool check.
const toolCheckComment = ": iroha-tool-check "

// testRun is what a test send changes in its exchange.
type testRun struct {
	caller   requests.Caller
	keyID    string // pinned Upstream Key, "" for any
	endpoint string // pinned Endpoint ID, "" for any
}

// pin narrows rt to the pinned key and Endpoint. The pinned key is planned
// whatever its Key State, as key tests do: disabled and invalid are ignored,
// its coolings are treated as just ended (so a success clears them) and its
// Model Gaps are left out. Failures still go through the Failure Rules.
func (t *testRun) pin(rt *route, now time.Time) *api.Error {
	if t.keyID == "" && t.endpoint == "" {
		return nil
	}
	p := &rt.providers[0]
	if t.endpoint != "" {
		p.Endpoints = slicesFilter(p.Endpoints, func(e planner.Endpoint) bool { return e.ID == t.endpoint })
	}
	if t.keyID != "" {
		p.Keys = slicesFilter(p.Keys, func(k planner.Key) bool { return k.ID == t.keyID })
		past := now.Add(-time.Millisecond)
		for i := range p.Keys {
			k := &p.Keys[i]
			k.Disabled, k.Invalid, k.ModelGaps = false, false, nil
			if k.CoolingUntil.After(past) {
				k.CoolingUntil = past
			}
			for m, u := range k.ModelCooling {
				if u.After(past) {
					k.ModelCooling[m] = past
				}
			}
		}
	}
	return nil
}

func slicesFilter[T any](in []T, keep func(T) bool) []T {
	var out []T
	for _, v := range in {
		if keep(v) {
			out = append(out, v)
		}
	}
	return out
}

// TestDryRun is the answer of POST /api/test?dry_run=true.
type TestDryRun struct {
	DryRun      bool            `json:"dry_run"`
	Caller      string          `json:"caller" doc:"The Caller the Request would be recorded as."`
	Shape       shape.Shape     `json:"shape"`
	Route       string          `json:"route" doc:"The global route the request takes."`
	Body        json.RawMessage `json:"body" doc:"The request body, as a Caller of the Shape would send it."`
	UpstreamKey string          `json:"upstream_key,omitempty" doc:"The pinned Upstream Key's name."`
	Endpoint    string          `json:"endpoint,omitempty" doc:"The pinned Endpoint's name."`
}

const testDescription = "Runs a chat turn through the Gateway exactly as a Caller of the chosen Shape would (global route, translation, Failure Rules, Key States, budget), " +
	"recorded in Requests as the Caller \"Test\" (caller.kind test), or \"Test (as <name>)\" with as=<Gateway Key>, whose scope then applies but whose own traffic counts never include it. " +
	"Test Requests are always captured (GET /api/requests/{request}/capture). " +
	"The answer is the Gateway's answer in that Shape, byte for byte as a Caller would get it: the Shape's server-sent events (stream, the default) or JSON, " +
	"the Shape's error envelope on failure, and the Request ID in x-request-id (GET /api/requests/{request} has every Attempt). " +
	"upstream_key and endpoint pin every Attempt to that key and/or Endpoint of the model's Provider (model must be <provider>/<model>). " +
	"With tool_check the request offers get_weather(city); the verdict (JSON: passed, reason, name, arguments, id) ends a stream as the SSE comment line " +
	"\": iroha-tool-check {...}\" (SDKs ignore comments) and comes in the Iroha-Tool-Check header of a JSON answer. " +
	"To continue after a tool call, send the assistant turn back with tool_calls: Iroha answers each with a made-up weather report. " +
	"Errors before anything is sent (bad body, unknown pin or Gateway Key) use the admin error envelope. dry_run=true sends nothing and shows the request."

// TestRoutes are the test chat's send route.
func (g *Gateway) TestRoutes() []api.Route {
	return []api.Route{{
		Method: http.MethodPost, Path: "/api/test", Tag: "Test",
		Summary: "Send a test chat turn through the Gateway as the Test caller", Description: testDescription,
		Query: []api.Param{audit.DryRun}, Request: testchat.Send{}, Response: TestDryRun{},
		Raw: http.HandlerFunc(g.serveTest),
	}}
}

func (g *Gateway) serveTest(w http.ResponseWriter, r *http.Request) {
	dry, err := audit.IsDryRun(&api.Call{W: w, R: r})
	if err != nil {
		api.WriteError(w, api.AsError(err))
		return
	}
	var s testchat.Send
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, api.MaxBodyBytes))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&s); err != nil {
		if errors.Is(err, io.EOF) {
			api.WriteError(w, api.BadRequest(`Send a JSON object such as {"model": "acme/gpt-4o", "messages": [{"role": "user", "content": "Hi"}]}.`, "The request body is empty."))
			return
		}
		api.WriteError(w, api.BadRequest("Fix the JSON body; GET /api/openapi.json has the schema for POST /api/test.", "The request body is not valid: %v", err))
		return
	}
	if err := s.Check(); err != nil {
		api.WriteError(w, api.AsError(err))
		return
	}
	b, err := testchat.Build(s)
	if err != nil {
		api.WriteError(w, api.AsError(err))
		return
	}
	ctx := r.Context()
	caller := gatewaykeys.Unrestricted(testchat.CallerName)
	run := &testRun{caller: requests.Caller{Kind: requests.CallerTest, Name: testchat.CallerName}}
	if s.As != "" {
		if caller, err = g.keys.CallerOf(ctx, s.As); err != nil {
			api.WriteError(w, api.AsError(err))
			return
		}
		run.caller.GatewayKeyID, run.caller.Name = caller.KeyID, testchat.CallerAs(caller.Name)
	}
	keyName, endpointName, aerr := g.resolvePins(r, s, run)
	if aerr != nil {
		api.WriteError(w, aerr)
		return
	}
	if dry {
		api.WriteJSON(w, http.StatusOK, TestDryRun{DryRun: true, Caller: run.caller.Name, Shape: b.Shape, Route: b.Path, Body: b.Body,
			UpstreamKey: keyName, Endpoint: endpointName})
		return
	}

	// The request a Caller would send, with no header of the admin call
	// (its cookie and Admin Token must never reach a Provider).
	ir, err := http.NewRequestWithContext(ctx, http.MethodPost, b.Path, bytes.NewReader(b.Body))
	if err != nil {
		api.WriteError(w, api.AsError(err))
		return
	}
	ir.Header.Set("Content-Type", "application/json")
	ir.RemoteAddr = r.RemoteAddr
	if b.Shape == shape.Gemini {
		ir.SetPathValue("model", strings.TrimPrefix(b.Path, "/v1beta/models/"))
	}
	out := w
	var buf *bufferedWriter
	if s.ToolCheck && !b.Stream {
		buf = &bufferedWriter{header: http.Header{}}
		out = buf
	}
	x := g.newExchange(out, ir, b.Shape)
	x.test = run
	untrack := g.track(x)
	g.run(x, caller, (*exchange).global)
	untrack()

	if !s.ToolCheck {
		return
	}
	var check testchat.ToolCheck
	if x.capture != nil {
		status, answer := x.capture.Answer(b.Shape)
		check = testchat.CheckTool(b.Shape, status, answer)
	}
	verdict, _ := json.Marshal(check)
	if buf != nil {
		buf.header.Set(ToolCheckHeader, string(verdict))
		buf.flushTo(w)
		return
	}
	x.mu.Lock()
	streaming := x.streaming
	x.mu.Unlock()
	if streaming {
		_, _ = io.WriteString(w, toolCheckComment+string(verdict)+"\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
}

// resolvePins checks the pins against the model's Provider before anything
// is recorded, so a typo is a plain admin error.
func (g *Gateway) resolvePins(r *http.Request, s testchat.Send, run *testRun) (keyName, endpointName string, _ *api.Error) {
	if s.UpstreamKey == "" && s.Endpoint == "" {
		return "", "", nil
	}
	handle, _, ok := splitModel(s.Model)
	if !ok {
		return "", "", api.Errorf(http.StatusBadRequest, "pin_needs_provider",
			"Name the model as <provider>/<model> to pin an Upstream Key or Endpoint; a Model Pool spreads over several Providers.",
			"Pinning needs one Provider, and %q names none.", s.Model)
	}
	rt, err := g.providers.ResolveRouting(r.Context(), handle)
	if err != nil {
		return "", "", api.AsError(err)
	}
	if s.UpstreamKey != "" {
		k, err := g.providers.ResolveKey(r.Context(), &rt, s.UpstreamKey)
		if err != nil {
			return "", "", api.AsError(err)
		}
		run.keyID, keyName = k.ID, k.Name
	}
	if s.Endpoint != "" {
		for _, e := range rt.Endpoints {
			if e.ID == s.Endpoint || e.Name == s.Endpoint {
				run.endpoint, endpointName = e.ID, e.Name
			}
		}
		if run.endpoint == "" {
			return "", "", api.NotFound("GET /api/providers/"+rt.Handle+"/endpoints lists its Endpoints.", "Provider %s has no Endpoint %q.", rt.Handle, s.Endpoint)
		}
	}
	return keyName, endpointName, nil
}

// bufferedWriter holds a whole JSON answer so a header can be added after it.
type bufferedWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (b *bufferedWriter) Header() http.Header { return b.header }

func (b *bufferedWriter) WriteHeader(status int) {
	if b.status == 0 {
		b.status = status
	}
}

func (b *bufferedWriter) Write(p []byte) (int, error) {
	if b.status == 0 {
		b.status = http.StatusOK
	}
	return b.body.Write(p)
}

func (b *bufferedWriter) flushTo(w http.ResponseWriter) {
	for k, v := range b.header {
		w.Header()[k] = v
	}
	w.Header().Set("Content-Length", strconv.Itoa(b.body.Len()))
	if b.status == 0 {
		b.status = http.StatusOK
	}
	w.WriteHeader(b.status)
	_, _ = w.Write(b.body.Bytes())
}
