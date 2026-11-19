package gateway_test

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testkit"
	"github.com/hoangvu12/iroha/internal/usage"
)

const chatPath = "/providers/acme/v1/chat/completions"

// addProvider creates a Provider with one OpenAI Chat Endpoint at up and an
// Upstream Key per secret, through the admin API.
func addProvider(t *testing.T, srv *testkit.Server, handle string, url string, secrets ...string) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": handle}).Expect(201)
	srv.Admin.Post("/api/providers/"+handle+"/endpoints", map[string]any{"url": url, "shape": "openai-chat"}).Expect(201)
	for _, s := range secrets {
		srv.Admin.Post("/api/providers/"+handle+"/keys", map[string]any{"secret": s}).Expect(201)
	}
}

// issue creates a Gateway Key and returns its secret.
func issue(t *testing.T, srv *testkit.Server, name string, scope any) string {
	t.Helper()
	var out struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": name, "scope": scope}).Expect(201).JSON(&out)
	return out.GatewayKey.Secret
}

var all = map[string]any{"all": true}

func readRequest(t *testing.T, srv *testkit.Server, id string) requests.Request {
	t.Helper()
	var r requests.Request
	srv.Admin.Get("/api/requests/" + id).Expect(200).JSON(&r)
	return r
}

func TestNonStreamedChatPassesThroughWithTheRequestedModelAndIsRecorded(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "zeron-fleet", all))

	up.Enqueue(testkit.JSON(200, map[string]any{
		"id": "chatcmpl-1", "object": "chat.completion", "model": "gpt-x-2026-01-01", "provider_extra": "kept",
		"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "hello"}, "finish_reason": "stop"}},
		"usage": map[string]any{"prompt_tokens": 12, "completion_tokens": 7, "total_tokens": 19,
			"prompt_tokens_details": map[string]any{"cached_tokens": 4}, "completion_tokens_details": map[string]any{"reasoning_tokens": 2}},
	}).Header("X-Upstream-Internal", "leak"))

	body := `{"model":"gpt-x",  "messages":[{"role":"user","content":"hi"}], "vendor_extra":{"a":[1,2]}}`
	resp := caller.Post(chatPath, body).Expect(200)

	// The upstream got the Caller's bytes untouched, with the Upstream Key.
	got := up.Last()
	if string(got.Body) != body || got.Path != "/v1/chat/completions" || got.Bearer() != "sk-test-one" {
		t.Fatalf("upstream got path %s bearer %q body %s", got.Path, got.Bearer(), got.Body)
	}
	// The answer passes through, naming the model asked for.
	m := resp.Map()
	if m["model"] != "gpt-x" || m["provider_extra"] != "kept" || resp.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("answer = %s (content type %q)", resp.Body, resp.Header.Get("Content-Type"))
	}
	if resp.Header.Get("X-Upstream-Internal") != "" {
		t.Fatal("an upstream header reached the Caller")
	}
	id := resp.Header.Get("X-Request-Id")
	if !strings.HasPrefix(id, "req_") {
		t.Fatalf("x-request-id = %q", id)
	}

	r := readRequest(t, srv, id)
	want := requests.Request{ID: id, State: "completed", Status: 200, Route: chatPath, ShapeIn: "openai-chat", ShapeOut: "openai-chat",
		Model: "gpt-x", Provider: "acme", Endpoint: "default", UpstreamKey: "key-1", WireModel: "gpt-x", AttemptCount: 1}
	if r.ID != want.ID || r.State != want.State || r.Status != want.Status || r.Route != want.Route || r.ShapeIn != want.ShapeIn ||
		r.ShapeOut != want.ShapeOut || r.Model != want.Model || r.Provider != want.Provider || r.Endpoint != want.Endpoint ||
		r.UpstreamKey != want.UpstreamKey || r.WireModel != want.WireModel || r.AttemptCount != 1 || r.Stream || r.Error != nil {
		t.Fatalf("request = %+v", r)
	}
	if r.Caller.Kind != "gateway_key" || r.Caller.Name != "zeron-fleet" || r.Caller.GatewayKeyID == "" {
		t.Fatalf("caller = %+v", r.Caller)
	}
	if r.Usage == nil || *r.Usage != (usage.Usage{Input: 12, Output: 7, CacheRead: 4, Reasoning: 2}) {
		t.Fatalf("usage = %+v", r.Usage)
	}
	if r.DurationMs == nil || r.FirstByteMs == nil || r.FinishedAt == nil || !r.StartedAt.Equal(testkit.Epoch) {
		t.Fatalf("timings = start %v first %v duration %v finished %v", r.StartedAt, r.FirstByteMs, r.DurationMs, r.FinishedAt)
	}
	if len(r.Attempts) != 1 {
		t.Fatalf("attempts = %+v", r.Attempts)
	}
	a := r.Attempts[0]
	if a.Seq != 1 || a.Status != 200 || a.Provider != "acme" || a.UpstreamKey != "key-1" || a.EndpointURL != up.URL() ||
		a.Shape != "openai-chat" || a.Usage == nil || a.Usage.Input != 12 || a.Error != "" {
		t.Fatalf("attempt = %+v", a)
	}

	// Attempt and Request events are linked to the Request and Provider,
	// and no secret is ever logged.
	if ev := srv.Logs("kind=attempt,request&request_id=" + id + "&provider=acme"); len(ev) != 2 {
		t.Fatalf("events = %+v", ev)
	}
	if strings.Contains(srv.Console(), "sk-test-one") {
		t.Fatal("the Upstream Key reached the logs")
	}
}

// eventLines reads a live SSE body line by line on a goroutine.
func eventLines(body io.Reader) <-chan string {
	ch := make(chan string, 64)
	go func() {
		defer close(ch)
		sc := bufio.NewScanner(body)
		for sc.Scan() {
			ch <- sc.Text()
		}
	}()
	return ch
}

func TestStreamsFlowChunkByChunkAndUsageIsRecorded(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	hold := make(chan struct{})
	stream := up.Stream("Hel", "lo")
	up.Enqueue(func(r *testkit.Received) testkit.Reply {
		rep := stream(r)
		rep.Chunks[2].Wait = hold // the "lo" chunk waits
		return rep
	})

	resp := caller.Open(http.MethodPost, chatPath, map[string]any{"model": "gpt-x", "stream": true, "messages": []any{map[string]any{"role": "user", "content": "hi"}}})
	defer resp.Body.Close()
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("status %d content type %q", resp.StatusCode, resp.Header.Get("Content-Type"))
	}
	lines := eventLines(resp.Body)
	var seen []string
	deadline := time.After(10 * time.Second)
waitFirst:
	for {
		select {
		case l, ok := <-lines:
			if !ok {
				t.Fatalf("stream ended early: %v", seen)
			}
			seen = append(seen, l)
			if strings.Contains(l, `"Hel"`) {
				break waitFirst
			}
		case <-deadline:
			t.Fatalf("the first chunk did not arrive while the next one was held; got %v", seen)
		}
	}
	close(hold)
	for l := range lines {
		seen = append(seen, l)
	}
	raw := strings.Join(seen, "\n")
	events := testkit.ParseSSE([]byte(raw + "\n"))
	var text strings.Builder
	for _, e := range events {
		if e.Data == "[DONE]" {
			continue
		}
		var c struct {
			Model   string
			Choices []struct{ Delta struct{ Content string } }
			Usage   any
		}
		if err := json.Unmarshal([]byte(e.Data), &c); err != nil {
			t.Fatalf("chunk is not JSON: %s", e.Data)
		}
		if c.Model != "gpt-x" {
			t.Fatalf("chunk model = %q", c.Model)
		}
		if len(c.Choices) == 0 {
			t.Fatalf("the Caller got a usage chunk it did not ask for: %s", e.Data)
		}
		text.WriteString(c.Choices[0].Delta.Content)
	}
	if text.String() != "Hello" || events[len(events)-1].Data != "[DONE]" {
		t.Fatalf("text %q, events %+v", text.String(), events)
	}

	// Iroha asked the upstream for usage.
	var sent struct {
		StreamOptions struct {
			IncludeUsage bool `json:"include_usage"`
		} `json:"stream_options"`
	}
	up.Last().JSON(t, &sent)
	if !sent.StreamOptions.IncludeUsage {
		t.Fatalf("upstream body lacks stream_options.include_usage: %s", up.Last().Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if !r.Stream || r.Status != 200 || r.Usage == nil || r.Usage.Input != 10 || r.Usage.Output != 5 || r.FirstByteMs == nil || r.Attempts[0].Usage == nil {
		t.Fatalf("request = %+v", r)
	}
}

func TestStreamUsageReachesCallersWhoAskForItAndModelsAreEchoed(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "opencode", all))

	up.Enqueue(testkit.SSE(
		"data: {\"id\":\"c1\",\"model\":\"gpt-x-0613\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}],\"usage\":null}\n\n",
		": keep-alive comment\n\n",
		"data: {\"id\":\"c1\",\"model\":\"gpt-x-0613\",\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1}}\n\n",
		"data: [DONE]\n\n",
	))
	body := `{"model":"gpt-x","stream":true,"stream_options":{"include_usage":true},"messages":[]}`
	resp := caller.Post(chatPath, body).Expect(200)
	if string(up.Last().Body) != body {
		t.Fatalf("a body that already asks for usage was changed: %s", up.Last().Body)
	}
	want := "data: {\"id\":\"c1\",\"model\":\"gpt-x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"}}],\"usage\":null}\n\n" +
		": keep-alive comment\n\n" +
		"data: {\"id\":\"c1\",\"model\":\"gpt-x\",\"choices\":[],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":1}}\n\n" +
		"data: [DONE]\n\n"
	if resp.Text() != want {
		t.Fatalf("stream =\n%s\nwant\n%s", resp.Text(), want)
	}
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Usage == nil || r.Usage.Input != 3 || r.Usage.Output != 1 {
		t.Fatalf("usage = %+v", r.Usage)
	}
}

func TestCallersAuthenticateWithAnyKeyHeaderAndTheirCredentialsNeverReachTheUpstream(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	key := issue(t, srv, "discord-bot", all)
	body := map[string]any{"model": "gpt-x", "messages": []any{}}

	clients := map[string]*testkit.Client{
		"bearer":    srv.Client(key),
		"x-api-key": srv.Anon.WithHeader("x-api-key", key),
		"api-key":   srv.Anon.WithHeader("api-key", key),
	}
	for name, c := range clients {
		c = c.WithHeader("Cookie", "session=abc").WithHeader("X-Forwarded-For", "203.0.113.9").WithHeader("Iroha-Debug", "1").
			WithHeader("OpenAI-Beta", "assistants=v2").WithHeader("User-Agent", "pi/1.0")
		c.Post(chatPath, body).Expect(200)
		got := up.Last()
		for h, vs := range got.Header {
			for _, v := range vs {
				if strings.Contains(v, key) {
					t.Fatalf("%s: the Gateway Key reached the upstream in %s", name, h)
				}
			}
		}
		if got.Bearer() != "sk-test-one" || got.Header.Get("X-Api-Key") != "" || got.Header.Get("Api-Key") != "" ||
			got.Header.Get("Cookie") != "" || got.Header.Get("X-Forwarded-For") != "" || got.Header.Get("Iroha-Debug") != "" {
			t.Fatalf("%s: upstream headers %v", name, got.Header)
		}
		if got.Header.Get("Openai-Beta") != "assistants=v2" || got.Header.Get("User-Agent") != "pi/1.0" {
			t.Fatalf("%s: provider headers were not forwarded: %v", name, got.Header)
		}
	}

	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "gone", "scope": all}).Expect(201)
	var revoked struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys/gone/revoke", nil).Expect(200).JSON(&revoked)
	refusals := []struct {
		name   string
		client *testkit.Client
		code   string
	}{
		{"missing", srv.Anon, "gateway_key_missing"},
		{"unknown", srv.Client("sk-iroha_not-a-key"), "gateway_key_invalid"},
		{"revoked", srv.Client(revoked.GatewayKey.Secret), "gateway_key_invalid"},
		{"admin token", srv.Admin, "gateway_key_invalid"},
	}
	before := up.Count()
	for _, tc := range refusals {
		var e struct {
			Error struct {
				Message, Type, Code, Hint string
				RequestID                 string `json:"request_id"`
			}
		}
		r := tc.client.Post(chatPath, body).Expect(401).JSON(&e)
		if e.Error.Code != tc.code || e.Error.Type != "authentication_error" || e.Error.Hint == "" || e.Error.Message == "" ||
			e.Error.RequestID != r.Header.Get("X-Request-Id") {
			t.Fatalf("%s: %s", tc.name, r.Body)
		}
	}
	if up.Count() != before {
		t.Fatal("a refused Caller reached the upstream")
	}
	var page requests.RequestPage
	srv.Admin.Get("/api/requests").Expect(200).JSON(&page)
	if len(page.Requests) != 3 {
		t.Fatalf("recorded %d Requests, want the 3 authenticated ones", len(page.Requests))
	}
}

func TestUpstreamKeysAreChosenRoundRobin(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c")
	caller := srv.Client(issue(t, srv, "pi", all))
	for range 6 {
		caller.Post(chatPath, map[string]any{"model": "gpt-x", "messages": []any{}}).Expect(200)
	}
	var got []string
	for _, r := range up.Requests() {
		got = append(got, strings.TrimPrefix(r.Bearer(), "sk-test-"))
	}
	if strings.Join(got, "") != "abcabc" {
		t.Fatalf("keys used in order = %v", got)
	}
}

func TestUnknownOrOutOfScopeProvidersGetTheUniformRefusal(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	for _, h := range []string{"acme", "other", "off", "old"} {
		addProvider(t, srv, h, up.URL(), "sk-test-"+h)
	}
	srv.Admin.Patch("/api/providers/off", map[string]any{"enabled": false}).Expect(200)
	srv.Admin.Patch("/api/providers/old", map[string]any{"archived": true}).Expect(200)
	everything := srv.Client(issue(t, srv, "everything", all))
	scoped := srv.Client(issue(t, srv, "friend", map[string]any{"providers": []any{
		map[string]any{"provider": "acme", "models": []string{"gpt-x"}},
		map[string]any{"provider": "off"},
		map[string]any{"provider": "old"},
	}}))
	body := map[string]any{"model": "gpt-x", "messages": []any{}}

	cases := []struct {
		name   string
		client *testkit.Client
		handle string
	}{
		{"unknown", scoped, "nope"},
		{"out of scope", scoped, "other"},
		{"disabled", scoped, "off"},
		{"archived", scoped, "old"},
		{"not a handle", scoped, "Not_A_Handle"},
		{"disabled for everything", everything, "off"},
		{"archived for everything", everything, "old"},
		{"unknown for everything", everything, "nope"},
	}
	var shapes []string
	for _, tc := range cases {
		var e struct {
			Error struct{ Message, Type, Code, Hint string }
		}
		tc.client.Post("/providers/"+tc.handle+"/v1/chat/completions", body).Expect(403).JSON(&e)
		if e.Error.Code != "provider_not_allowed" || e.Error.Type != "permission_error" || e.Error.Hint == "" {
			t.Fatalf("%s: %+v", tc.name, e.Error)
		}
		shapes = append(shapes, strings.ReplaceAll(e.Error.Message, tc.handle, "<h>")+"|"+e.Error.Hint)
	}
	if uniq := slices.Compact(slices.Clone(shapes)); len(uniq) != 1 {
		t.Fatalf("refusals differ: %v", uniq)
	}
	if up.Count() != 0 {
		t.Fatal("a refused Request reached an upstream")
	}

	// Within a Provider, a narrowed scope refuses other models.
	e := scoped.Post(chatPath, map[string]any{"model": "gpt-y", "messages": []any{}}).Expect(403)
	if !strings.Contains(e.Text(), `"model_not_allowed"`) {
		t.Fatalf("model outside scope: %s", e.Body)
	}
	scoped.Post(chatPath, body).Expect(200)

	// Refusals are recorded with the reason.
	var page requests.RequestPage
	srv.Admin.Get("/api/requests?caller=friend&status=403").Expect(200).JSON(&page)
	if len(page.Requests) != 6 || page.Requests[0].Error == nil || page.Requests[0].Error.Code != "model_not_allowed" ||
		page.Requests[1].Error.Code != "provider_not_allowed" || page.Requests[0].AttemptCount != 0 {
		t.Fatalf("recorded refusals: %+v", page.Requests)
	}
}

func TestMalformedBodiesAreRefusedBeforeAnyAttempt(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))
	cases := map[string]string{
		"":                           "invalid_request",
		"not json":                   "invalid_request",
		"[1,2]":                      "invalid_request",
		`{"model": 5}`:               "invalid_request",
		`{"messages": []}`:           "model_required",
		`{"model": "  ", "x": true}`: "model_required",
	}
	for body, code := range cases {
		var e struct{ Error struct{ Code, Hint string } }
		caller.Post(chatPath, body).Expect(400).JSON(&e)
		if e.Error.Code != code || e.Error.Hint == "" {
			t.Errorf("%q: %+v, want %s", body, e.Error, code)
		}
	}
	if up.Count() != 0 {
		t.Fatal("a malformed body reached the upstream")
	}
}

func TestUpstreamErrorsPassThroughAndFailuresAreExplained(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	addProvider(t, srv, "dead", "http://127.0.0.1:1/v1", "sk-test-dead")
	addProvider(t, srv, "empty", up.URL())
	caller := srv.Client(issue(t, srv, "pi", all))
	body := map[string]any{"model": "gpt-x", "messages": []any{}}

	// An upstream error reaches the Caller as the Provider wrote it.
	up.Enqueue(up.Error(429, "slow down").Header("Retry-After", "30"))
	resp := caller.Post(chatPath, body).Expect(429)
	if !strings.Contains(resp.Text(), "slow down") {
		t.Fatalf("error body = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Status != 429 || r.Error == nil || r.Error.Code != "upstream_error" || r.Attempts[0].Status != 429 {
		t.Fatalf("recorded = %+v", r)
	}

	// An unreachable Endpoint is a 502 that says so.
	resp = caller.Post("/providers/dead/v1/chat/completions", body).Expect(502)
	var e struct {
		Error struct {
			Code, Hint string
			RequestID  string `json:"request_id"`
		}
	}
	resp.JSON(&e)
	if e.Error.Code != "upstream_unreachable" || e.Error.Hint == "" || e.Error.RequestID == "" {
		t.Fatalf("unreachable: %s", resp.Body)
	}
	r = readRequest(t, srv, e.Error.RequestID)
	if r.Status != 502 || len(r.Attempts) != 1 || r.Attempts[0].Status != 0 || r.Attempts[0].Error == "" {
		t.Fatalf("recorded = %+v", r)
	}

	// A Provider with nothing to send to fails at once.
	resp = caller.Post("/providers/empty/v1/chat/completions", body).Expect(503)
	if !strings.Contains(resp.Text(), `"no_candidate"`) || !strings.Contains(resp.Text(), "no Upstream Keys") {
		t.Fatalf("no candidate: %s", resp.Body)
	}
}

func TestRequestsCanBeFilteredAndPaged(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	a := srv.Client(issue(t, srv, "alice", all))
	b := srv.Client(issue(t, srv, "bob", all))
	for _, c := range []*testkit.Client{a, b, a} {
		c.Post(chatPath, map[string]any{"model": "gpt-x", "messages": []any{}}).Expect(200)
		srv.Clock.Advance(time.Minute)
	}
	b.Post(chatPath, map[string]any{"model": "gpt-y", "messages": []any{}}).Expect(200)

	list := func(q string) []requests.Request {
		var p requests.RequestPage
		srv.Admin.Get("/api/requests?" + q).Expect(200).JSON(&p)
		return p.Requests
	}
	if got := list("caller=alice"); len(got) != 2 || got[0].Caller.Name != "alice" {
		t.Fatalf("caller=alice: %+v", got)
	}
	if got := list("model=gpt-y"); len(got) != 1 || got[0].Caller.Name != "bob" {
		t.Fatalf("model=gpt-y: %+v", got)
	}
	if got := list("provider=acme&status=2xx&since=90s"); len(got) != 2 {
		t.Fatalf("since=90s: %d", len(got))
	}
	var p1, p2 requests.RequestPage
	srv.Admin.Get("/api/requests?limit=3").Expect(200).JSON(&p1)
	srv.Admin.Get("/api/requests?limit=3&before=" + p1.NextBefore).Expect(200).JSON(&p2)
	if len(p1.Requests) != 3 || len(p2.Requests) != 1 || p2.NextBefore != "" || p1.Requests[0].Model != "gpt-y" {
		t.Fatalf("pages: %d then %d (%q)", len(p1.Requests), len(p2.Requests), p2.NextBefore)
	}
	for _, q := range []string{"status=6xx", "limit=0", "since=yesterday"} {
		if e := srv.Admin.Get("/api/requests?" + q).Expect(400).Err(); e.Hint == "" {
			t.Errorf("%s: no hint", q)
		}
	}
	srv.Admin.Get("/api/requests/req_nope").Expect(404)
}
