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

const ToolCheckHeader = "Iroha-Tool-Check"

const toolCheckComment = ": iroha-tool-check "

type testRun struct {
	caller   requests.Caller
	keyID    string
	endpoint string
}

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
		for i := range p.Keys {
			plannedWhateverItsState(&p.Keys[i], now)
		}
	}
	return nil
}

func plannedWhateverItsState(k *planner.Key, now time.Time) {
	coolingsJustEnded := now.Add(-time.Millisecond)
	k.Disabled, k.Invalid, k.ModelGaps, k.EndpointGaps, k.WorkedOn = false, false, nil, nil, nil
	if k.CoolingUntil.After(coolingsJustEnded) {
		k.CoolingUntil = coolingsJustEnded
	}
	for m, u := range k.ModelCooling {
		if u.After(coolingsJustEnded) {
			k.ModelCooling[m] = coolingsJustEnded
		}
	}
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
	"tools names test tools to offer (GET /api/test/tools; tool_check: true alone means [\"get_weather\"]); the verdict on the model's calls " +
	"(JSON: passed, reason, name, arguments, id, calls; it passes when every call names an offered tool with arguments valid against its schema) ends a stream as the SSE comment line " +
	"\": iroha-tool-check {...}\" (SDKs ignore comments) and comes in the Iroha-Tool-Check header of a JSON answer. " +
	"To continue after a tool call, send the assistant turn back with tool_calls: Iroha answers each with that tool's result. " +
	"Errors before anything is sent (bad body, unknown pin or Gateway Key) use the admin error envelope. dry_run=true sends nothing and shows the request."

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
	b, err := testchat.Build(s, g.clock.Now())
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

	ir, err := callerRequestWithoutAdminHeaders(r, b)
	if err != nil {
		api.WriteError(w, api.AsError(err))
		return
	}
	out := w
	var buf *bufferedWriter
	if s.Checked() && !b.Stream {
		buf = &bufferedWriter{header: http.Header{}}
		out = buf
	}
	x := g.newExchange(out, ir, b.Shape)
	x.test = run
	untrack := g.track(x)
	g.run(x, caller, (*exchange).global)
	untrack()

	if !s.Checked() {
		return
	}
	var check testchat.ToolCheck
	if x.capture != nil {
		status, answer := x.capture.Answer(b.Shape)
		check = testchat.CheckTool(b.Shape, status, answer, s.Tools)
	}
	verdict, _ := json.Marshal(check)
	if buf != nil {
		buf.header.Set(ToolCheckHeader, string(verdict))
		buf.flushTo(w)
		return
	}
	if x.out.isStreaming() {
		_, _ = io.WriteString(w, toolCheckComment+string(verdict)+"\n\n")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
}

func callerRequestWithoutAdminHeaders(admin *http.Request, b testchat.Built) (*http.Request, error) {
	r, err := http.NewRequestWithContext(admin.Context(), http.MethodPost, b.Path, bytes.NewReader(b.Body))
	if err != nil {
		return nil, err
	}
	r.Header.Set("Content-Type", "application/json")
	r.RemoteAddr = admin.RemoteAddr
	if b.Shape == shape.Gemini {
		r.SetPathValue("model", strings.TrimPrefix(b.Path, "/v1beta/models/"))
	}
	return r, nil
}

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
