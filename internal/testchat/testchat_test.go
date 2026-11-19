package testchat_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testchat"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func addProvider(t *testing.T, srv *testkit.Server, handle, sh, url string, secrets ...string) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": handle}).Expect(201)
	addEndpoint(t, srv, handle, "main", sh, url)
	for _, s := range secrets {
		srv.Admin.Post("/api/providers/"+handle+"/keys", map[string]any{"secret": s}).Expect(201)
	}
}

func addEndpoint(t *testing.T, srv *testkit.Server, handle, name, sh, url string) {
	t.Helper()
	ep := map[string]any{"name": name, "url": url, "shape": sh}
	if sh == "anthropic-messages" {
		ep["auth_style"] = "x-api-key"
	}
	srv.Admin.Post("/api/providers/"+handle+"/endpoints", ep).Expect(201)
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

func readRequest(t *testing.T, srv *testkit.Server, id string) requests.Request {
	t.Helper()
	var r requests.Request
	srv.Admin.Get("/api/requests/" + id).Expect(200).JSON(&r)
	return r
}

func send(m map[string]any) map[string]any {
	if _, ok := m["messages"]; !ok {
		m["messages"] = []any{map[string]any{"role": "user", "content": "hi"}}
	}
	return m
}

// TestPinningSendsEveryAttemptToOneKeyOrEndpoint: a pinned key gets every
// Attempt (the 5xx replay included), whatever its Key State, and a pinned
// Endpoint is the only one called.
func TestPinningSendsEveryAttemptToOneKeyOrEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up, other := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1", "sk-test-2", "sk-test-3")
	addEndpoint(t, srv, "acme", "other", "openai-chat", other.URL())

	// key-2 disabled: still tried when pinned. Two 500s: the Request fails
	// with both Attempts on key-2 (replayed once), never key-1 or key-3.
	srv.Admin.Post("/api/providers/acme/keys/key-2/disable", nil).OK()
	srv.SkipShortWaits(time.Second) // the pause before a replay (ticket 31)
	up.Default(up.Error(500, "boom"))
	other.Default(other.Error(500, "boom"))
	resp := srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "upstream_key": "key-2", "stream": false})).Expect(502)
	var env struct {
		Error struct {
			Code    string
			Details struct {
				Attempts []struct {
					UpstreamKey string `json:"upstream_key"`
				}
			}
		}
	}
	resp.JSON(&env)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Caller.Kind != requests.CallerTest || r.Caller.Name != "Test" || len(r.Attempts) < 2 || env.Error.Code != "upstream_failed" {
		t.Fatalf("request %+v, error %s", r, resp.Body)
	}
	for _, a := range r.Attempts {
		if a.UpstreamKey != "key-2" {
			t.Fatalf("attempt on %s: %+v", a.UpstreamKey, r.Attempts)
		}
	}
	for _, got := range append(up.Requests(), other.Requests()...) {
		if got.Bearer() != "sk-test-2" {
			t.Fatalf("upstream got bearer %q", got.Bearer())
		}
	}

	// Pinned to Endpoint "other": main is never called.
	n := up.Count()
	other.Enqueue(other.Text("from other"))
	resp = srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "endpoint": "other", "stream": false})).Expect(200)
	if up.Count() != n || !strings.Contains(resp.Text(), "from other") {
		t.Fatalf("main called %d more times; answer %s", up.Count()-n, resp.Body)
	}
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Endpoint != "other" {
		t.Fatalf("served by Endpoint %q", r.Endpoint)
	}

	// Pins need one Provider and must exist; checked before anything is sent.
	srv.Admin.Post("/api/test", send(map[string]any{"model": "pool-x", "upstream_key": "key-1"})).Expect(400)
	srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "upstream_key": "nope"})).Expect(404)
	srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "endpoint": "nope"})).Expect(404)

	// dry_run shows the request and sends nothing.
	n = up.Count() + other.Count()
	var dry struct {
		DryRun      bool `json:"dry_run"`
		Caller      string
		Route       string
		UpstreamKey string `json:"upstream_key"`
		Body        map[string]any
	}
	srv.Admin.Post("/api/test?dry_run=true", send(map[string]any{"model": "acme/m", "upstream_key": "key-3"})).OK().JSON(&dry)
	if !dry.DryRun || dry.Route != "/v1/chat/completions" || dry.UpstreamKey != "key-3" || dry.Body["model"] != "acme/m" || up.Count()+other.Count() != n {
		t.Fatalf("dry run %+v", dry)
	}
}

// TestSendingAsAGatewayKeyAppliesItsScopeButNeverCountsAsItsTraffic.
func TestSendingAsAGatewayKeyAppliesItsScopeButNeverCountsAsItsTraffic(t *testing.T) {
	srv := testkit.Start(t)
	acme, other := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", acme.URL(), "sk-test-a")
	addProvider(t, srv, "other", "openai-chat", other.URL(), "sk-test-o")
	issue(t, srv, "zeron-fleet", map[string]any{"providers": []any{map[string]any{"provider": "acme"}}})

	// Outside the key's scope: refused like the key's own Request would be.
	resp := srv.Admin.Post("/api/test", send(map[string]any{"model": "other/m", "as": "zeron-fleet", "stream": false})).Expect(403)
	if !strings.Contains(resp.Text(), "provider_not_allowed") || other.Count() != 0 {
		t.Fatalf("answer %s, other called %d", resp.Body, other.Count())
	}
	acme.Enqueue(acme.Text("hello"))
	resp = srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "as": "zeron-fleet", "stream": false})).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	var key struct {
		ID             string  `json:"id"`
		RecentRequests int     `json:"recent_requests"`
		LastUsedAt     *string `json:"last_used_at"`
	}
	srv.Admin.Get("/api/gateway-keys/zeron-fleet").OK().JSON(&key)
	if r.Caller.Kind != requests.CallerTest || r.Caller.Name != "Test (as zeron-fleet)" || r.Caller.GatewayKeyID != key.ID || !r.Captured {
		t.Fatalf("caller %+v captured %v", r.Caller, r.Captured)
	}
	if key.RecentRequests != 0 || key.LastUsedAt != nil {
		t.Fatalf("test counted as the key's traffic: %+v", key)
	}
	if strings.Contains(srv.Admin.Get("/api/requests?caller="+key.ID).OK().Text(), r.ID) {
		t.Fatalf("the key's own feed lists the test")
	}
	if !strings.Contains(srv.Admin.Get("/api/requests?caller_kind=test").OK().Text(), r.ID) {
		t.Fatalf("the test feed misses the test")
	}
	// A revoked key cannot be sent as.
	srv.Admin.Post("/api/gateway-keys/zeron-fleet/revoke", nil).OK()
	srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "as": "zeron-fleet"})).Expect(409)
}

// streamText collects the text of a streamed answer in any Shape.
func streamText(t *testing.T, sh string, body []byte) string {
	t.Helper()
	var b strings.Builder
	for _, e := range testkit.ParseSSE(body) {
		if e.Data == "" || e.Data == "[DONE]" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(e.Data), &m); err != nil {
			t.Fatalf("event %q: %v", e.Data, err)
		}
		switch sh {
		case "openai-chat":
			for _, c := range anyList(m["choices"]) {
				if s, ok := anyMap(anyMap(c)["delta"])["content"].(string); ok {
					b.WriteString(s)
				}
			}
		case "openai-responses":
			if m["type"] == "response.output_text.delta" {
				b.WriteString(m["delta"].(string))
			}
		case "anthropic-messages":
			if d := anyMap(m["delta"]); m["type"] == "content_block_delta" && d["type"] == "text_delta" {
				b.WriteString(d["text"].(string))
			}
		case "gemini":
			for _, c := range anyList(m["candidates"]) {
				for _, p := range anyList(anyMap(anyMap(c)["content"])["parts"]) {
					if s, ok := anyMap(p)["text"].(string); ok {
						b.WriteString(s)
					}
				}
			}
		}
	}
	return b.String()
}

func anyMap(v any) map[string]any { m, _ := v.(map[string]any); return m }
func anyList(v any) []any         { l, _ := v.([]any); return l }

var shapes = []string{"openai-chat", "openai-responses", "anthropic-messages", "gemini"}

// TestMultiTurnChatStreamsInEveryShapeWithReasoningTranslated: each Shape's
// request reaches an OpenAI Chat Endpoint with the whole conversation and
// the reasoning level, and streams back in the Shape.
func TestMultiTurnChatStreamsInEveryShapeWithReasoningTranslated(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1")
	for _, sh := range shapes {
		t.Run(sh, func(t *testing.T) {
			up.Enqueue(up.Stream("Xin ", "chào"))
			resp := srv.Admin.Post("/api/test", map[string]any{"model": "acme/m", "shape": sh, "reasoning": "high", "system": "Be brief.",
				"messages": []any{
					map[string]any{"role": "user", "content": "Hello"},
					map[string]any{"role": "assistant", "content": "Hi! How can I help?"},
					map[string]any{"role": "user", "content": "Say hi in Vietnamese"},
				}}).Expect(200)
			if got := streamText(t, sh, resp.Body); got != "Xin chào" {
				t.Fatalf("streamed %q from %s", got, resp.Body)
			}
			var body struct {
				Messages []struct {
					Role    string
					Content any
				}
				ReasoningEffort string `json:"reasoning_effort"`
				Stream          bool
			}
			up.Last().JSON(t, &body)
			n := len(body.Messages)
			if n != 4 || body.Messages[0].Role != "system" || body.Messages[n-1].Role != "user" || body.Messages[2].Role != "assistant" || !body.Stream {
				t.Fatalf("upstream got %s", up.Last().Body)
			}
			if body.ReasoningEffort != "high" {
				t.Fatalf("reasoning_effort %q in %s", body.ReasoningEffort, up.Last().Body)
			}
			r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
			if string(r.ShapeIn) != sh || r.Model != "acme/m" || !r.Stream || r.Caller.Name != "Test" {
				t.Fatalf("recorded %+v", r)
			}
		})
	}
}

const toolCallStream = `data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_9","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\": \"Hanoi\"}"}}]},"finish_reason":null}]}

data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]

`

// toolCheck reads the verdict that ends a streamed test answer.
func toolCheck(t *testing.T, body []byte) testchat.ToolCheck {
	t.Helper()
	const prefix = ": iroha-tool-check "
	i := strings.LastIndex(string(body), prefix)
	if i < 0 {
		t.Fatalf("no tool check in %s", body)
	}
	line, _, _ := strings.Cut(string(body[i+len(prefix):]), "\n")
	var c testchat.ToolCheck
	if err := json.Unmarshal([]byte(line), &c); err != nil {
		t.Fatalf("tool check %q: %v", line, err)
	}
	return c
}

// TestToolCheckReportsPassOrFailWithTheRawCall in every Shape, and a
// follow-up turn answers the call with the made-up weather.
func TestToolCheckReportsPassOrFailWithTheRawCall(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1")
	for _, sh := range shapes {
		t.Run(sh, func(t *testing.T) {
			up.Enqueue(testkit.SSE(toolCallStream))
			resp := srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "shape": sh, "tool_check": true})).Expect(200)
			c := toolCheck(t, resp.Body)
			var args map[string]any
			if !c.Passed || c.Name != "get_weather" || json.Unmarshal([]byte(c.Arguments), &args) != nil || args["city"] != "Hanoi" {
				t.Fatalf("check %+v in %s", c, resp.Body)
			}
			var body struct {
				Tools []struct{ Function struct{ Name string } }
			}
			up.Last().JSON(t, &body)
			if len(body.Tools) != 1 || body.Tools[0].Function.Name != "get_weather" {
				t.Fatalf("upstream tools: %s", up.Last().Body)
			}
		})
	}

	// A plain answer fails the check; non-streamed, the verdict is a header.
	up.Enqueue(up.Text("It is sunny."))
	resp := srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "tool_check": true, "stream": false})).Expect(200)
	var c testchat.ToolCheck
	if err := json.Unmarshal([]byte(resp.Header.Get("Iroha-Tool-Check")), &c); err != nil || c.Passed || !strings.Contains(c.Reason, "without calling") {
		t.Fatalf("check %q", resp.Header.Get("Iroha-Tool-Check"))
	}
	if !strings.Contains(resp.Text(), "It is sunny.") {
		t.Fatalf("answer %s", resp.Body)
	}

	// The next turn sends the call back with its made-up result.
	up.Enqueue(up.Text("27C in Hanoi."))
	srv.Admin.Post("/api/test", map[string]any{"model": "acme/m", "stream": false, "messages": []any{
		map[string]any{"role": "user", "content": "Weather in Hanoi?"},
		map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": "call_9", "name": "get_weather", "arguments": `{"city":"Hanoi"}`}}},
		map[string]any{"role": "user", "content": "Thanks"},
	}}).Expect(200)
	var next struct {
		Messages []struct {
			Role       string
			ToolCallID string `json:"tool_call_id"`
			Content    string
		}
		Tools []any
	}
	up.Last().JSON(t, &next)
	if len(next.Messages) != 4 || next.Messages[2].Role != "tool" || next.Messages[2].ToolCallID != "call_9" ||
		!strings.Contains(next.Messages[2].Content, "Hanoi") || len(next.Tools) != 1 {
		t.Fatalf("upstream got %s", up.Last().Body)
	}
}

// TestFailedTestCarriesTheAttemptExplanation: a failed test answers the
// Shape's error with every Attempt, and the Request explains each one.
func TestFailedTestCarriesTheAttemptExplanation(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1")
	up.Enqueue(up.Error(401, "invalid api key"))
	resp := srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/m", "shape": "anthropic-messages"})).Expect(502)
	if !strings.Contains(resp.Text(), `"type":"error"`) || !strings.Contains(resp.Text(), `"attempts"`) {
		t.Fatalf("answer %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 1 || r.Attempts[0].Outcome != "invalid" || r.Attempts[0].Rule == "" || r.Attempts[0].FailureBody == "" {
		t.Fatalf("attempts %+v", r.Attempts)
	}
}

// TestModelSearchListsPoolsFirstWithinTheScope.
func TestModelSearchListsPoolsFirstWithinTheScope(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "dashscope", "openai-chat", up.URL(), "sk-test-1")
	addProvider(t, srv, "openrouter", "openai-chat", up.URL(), "sk-test-2")
	for _, m := range []string{"qwen3-coder-plus", "qwen3-max", "glm-4.6"} {
		srv.Admin.Post("/api/providers/dashscope/models", map[string]any{"model": m}).Expect(201)
	}
	srv.Admin.Post("/api/providers/openrouter/models", map[string]any{"model": "qwen/qwen3-coder"}).Expect(201)
	srv.Admin.Post("/api/pools", map[string]any{"name": "qwen3-coder-plus", "members": []any{map[string]any{"provider": "dashscope", "model": "qwen3-coder-plus"}}}).Expect(201)

	var got testchat.ModelChoices
	srv.Admin.Get("/api/test/models?q=QWEN%20coder").OK().JSON(&got)
	if got.Total != 5 || got.Matched != 3 || len(got.Pools) != 1 || got.Pools[0].ID != "qwen3-coder-plus" || len(got.Providers) != 2 ||
		got.Providers[0].Provider != "dashscope" || got.Providers[0].Models[0].ID != "dashscope/qwen3-coder-plus" || got.Providers[1].Models[0].Model != "qwen/qwen3-coder" {
		t.Fatalf("search %+v", got)
	}
	srv.Admin.Get("/api/test/models?q=qwen&limit=2").OK().JSON(&got)
	if got.Matched != 4 || !got.Truncated || len(got.Pools)+len(got.Providers[0].Models) != 2 {
		t.Fatalf("limited %+v", got)
	}
	issue(t, srv, "friend", map[string]any{"providers": []any{map[string]any{"provider": "openrouter"}}})
	srv.Admin.Get("/api/test/models?as=friend").OK().JSON(&got)
	if got.Total != 1 || len(got.Pools) != 0 || got.Providers[0].Provider != "openrouter" {
		t.Fatalf("as friend %+v", got)
	}
}

// TestModelSearchPutsThePreferredProviderOrPoolFirst: prefer=<provider>/
// lists that Provider before the Pools (and fills limit with it first);
// prefer=<pool> puts that Pool first among the Pools. Search filters both.
func TestModelSearchPutsThePreferredProviderOrPoolFirst(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1")
	addProvider(t, srv, "zeta", "openai-chat", up.URL(), "sk-test-2")
	for _, m := range []string{"a-1", "b-2"} {
		srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": m}).Expect(201)
	}
	srv.Admin.Post("/api/providers/zeta/models", map[string]any{"model": "z-1"}).Expect(201)
	for _, p := range []string{"alpha", "fast"} {
		srv.Admin.Post("/api/pools", map[string]any{"name": p, "members": []any{map[string]any{"provider": "acme", "model": "b-2"}}}).Expect(201)
	}

	var got testchat.ModelChoices
	get := func(query string) {
		t.Helper()
		got = testchat.ModelChoices{}
		srv.Admin.Get("/api/test/models?" + query).OK().JSON(&got)
	}
	get("prefer=zeta/")
	if len(got.Providers) != 2 || got.Providers[0].Provider != "zeta" || got.Providers[1].Provider != "acme" || len(got.Pools) != 2 || got.Pools[0].ID != "alpha" {
		t.Fatalf("prefer zeta %+v", got)
	}
	// Any <provider>/<model> names its Provider; limit is filled with it first.
	get("prefer=zeta/z-1&limit=1")
	if !got.Truncated || got.Matched != 5 || len(got.Pools) != 0 || len(got.Providers[0].Models) != 1 || got.Providers[0].Models[0].ID != "zeta/z-1" {
		t.Fatalf("prefer zeta, limit 1 %+v", got)
	}
	// Search filters the preferred Provider and everything else alike.
	get("prefer=zeta/&q=1")
	if got.Matched != 2 || len(got.Pools) != 0 || len(got.Providers) != 2 || got.Providers[0].Models[0].ID != "zeta/z-1" || got.Providers[1].Models[0].ID != "acme/a-1" {
		t.Fatalf("prefer zeta, q=1 %+v", got)
	}
	get("prefer=fast")
	if len(got.Pools) != 2 || got.Pools[0].ID != "fast" || got.Pools[1].ID != "alpha" || got.Providers[0].Provider != "acme" || got.Suggested != "" {
		t.Fatalf("prefer fast %+v", got)
	}
	// A Provider the caller may not use, or that doesn't exist, changes nothing.
	get("prefer=nope/")
	if got.Providers[0].Provider != "acme" || got.Suggested != "" {
		t.Fatalf("prefer nope %+v", got)
	}
}

// TestModelSearchSuggestsTheModelAProviderServedMost: with prefer naming a
// Provider, suggested is its model with the most 2xx Requests of the last
// 7 days (direct, global or through a Pool), else its first listed model.
func TestModelSearchSuggestsTheModelAProviderServedMost(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1")
	for _, m := range []string{"a-1", "b-2", "c-3"} {
		srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": m}).Expect(201)
	}
	srv.Admin.Post("/api/pools", map[string]any{"name": "fast", "members": []any{map[string]any{"provider": "acme", "model": "c-3"}}}).Expect(201)
	suggested := func(query string) string {
		t.Helper()
		var got testchat.ModelChoices
		srv.Admin.Get("/api/test/models?" + query).OK().JSON(&got)
		return got.Suggested
	}
	if s := suggested("prefer=acme/"); s != "acme/a-1" {
		t.Fatalf("no traffic: suggested %q, want the first listed", s)
	}

	up.Default(up.Text("ok"))
	for _, m := range []string{"acme/b-2", "acme/b-2", "fast", "fast", "fast"} {
		srv.Admin.Post("/api/test", send(map[string]any{"model": m, "stream": false})).Expect(200)
	}
	// A failed Request served nothing.
	up.Default(up.Error(400, "bad"))
	for range 3 {
		srv.Admin.Post("/api/test", send(map[string]any{"model": "acme/a-1", "stream": false}))
	}
	if s := suggested("prefer=acme/&q=b&limit=1"); s != "acme/c-3" {
		t.Fatalf("suggested %q, want acme/c-3 (3 through the Pool; q and limit don't matter)", s)
	}
	// A hidden model is not offered.
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "c-3", "hidden": true}).OK()
	if s := suggested("prefer=acme/"); s != "acme/b-2" {
		t.Fatalf("c-3 hidden: suggested %q", s)
	}
	srv.Clock.Advance(8 * 24 * time.Hour)
	if s := suggested("prefer=acme/"); s != "acme/a-1" {
		t.Fatalf("traffic older than 7 days: suggested %q", s)
	}
}

// curlArgs splits a POSIX shell command (quotes, backslash-newline).
func curlArgs(t *testing.T, cmd string) []string {
	t.Helper()
	var args []string
	var cur strings.Builder
	in, quote := false, byte(0)
	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		switch {
		case quote == '\'':
			if c == '\'' {
				quote = 0
			} else {
				cur.WriteByte(c)
			}
		case quote == '"':
			if c == '"' {
				quote = 0
			} else {
				cur.WriteByte(c)
			}
		case c == '\'' || c == '"':
			quote, in = c, true
		case c == '\\' && i+1 < len(cmd) && cmd[i+1] == '\n':
			i++
		case c == '\\' && i+1 < len(cmd):
			i++
			cur.WriteByte(cmd[i])
			in = true
		case c == ' ' || c == '\n' || c == '\t':
			if in {
				args = append(args, cur.String())
				cur.Reset()
				in = false
			}
		default:
			cur.WriteByte(c)
			in = true
		}
	}
	if in {
		args = append(args, cur.String())
	}
	return args
}

// runCurl sends what a curl snippet sends, without needing curl.
func runCurl(t *testing.T, cmd string) (*http.Response, []byte) {
	t.Helper()
	args := curlArgs(t, cmd)
	if len(args) == 0 || args[0] != "curl" {
		t.Fatalf("not a curl command: %q", cmd)
	}
	var target, data string
	h := http.Header{}
	for i := 1; i < len(args); i++ {
		switch args[i] {
		case "-N":
		case "-H":
			i++
			k, v, _ := strings.Cut(args[i], ":")
			h.Set(strings.TrimSpace(k), strings.TrimSpace(v))
		case "-d":
			i++
			data = args[i]
		default:
			if strings.HasPrefix(args[i], "-") || target != "" {
				t.Fatalf("unexpected curl argument %q", args[i])
			}
			target = args[i]
		}
	}
	req, err := http.NewRequest(http.MethodPost, target, strings.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	req.Header = h
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var b strings.Builder
	buf := make([]byte, 4096)
	for {
		n, err := resp.Body.Read(buf)
		b.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return resp, []byte(b.String())
}

// TestSnippetsRunUnchangedAgainstIroha: each Shape's curl snippet, as
// written, is answered by the Gateway as the Gateway Key it names; with
// sh and curl installed the snippet also runs in a real shell.
func TestSnippetsRunUnchangedAgainstIroha(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-1")
	secret := issue(t, srv, "zeron-fleet", map[string]any{"all": true})
	up.Default(up.Text("it works"))
	for _, sh := range shapes {
		t.Run(sh, func(t *testing.T) {
			var sn testchat.Snippets
			q := url.Values{"model": {"acme/m"}, "shape": {sh}, "as": {"zeron-fleet"}, "prompt": {"It's a 'test'"}, "base_url": {srv.URL},
				"reasoning": {"low"}, "tool_check": {"true"}}
			srv.Admin.Get("/api/test/snippets?" + q.Encode()).OK().JSON(&sn)
			resp, body := runCurl(t, sn.Curl)
			if resp.StatusCode != 200 || streamText(t, sh, body) != "it works" {
				t.Fatalf("curl snippet answered %d %s\n%s", resp.StatusCode, body, sn.Curl)
			}
			if !strings.Contains(sn.Python, secret) || !strings.Contains(sn.TypeScript, secret) || sn.KeyEnv {
				t.Fatalf("snippets do not carry the key:\n%s\n%s", sn.Python, sn.TypeScript)
			}
			if sh != "gemini" && (!strings.Contains(sn.Python, "get_weather") || !strings.Contains(sn.Python, "True")) {
				t.Fatalf("python snippet:\n%s", sn.Python)
			}
			// It was the key's own Request, not a test.
			r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
			if r.Caller.Kind != requests.CallerGatewayKey || r.Caller.Name != "zeron-fleet" {
				t.Fatalf("recorded caller %+v", r.Caller)
			}
		})
	}

	// Without as, the key comes from IROHA_KEY; pins are test-only and not carried.
	var sn testchat.Snippets
	resp := srv.Admin.Get("/api/test/snippets?model=acme/m&upstream_key=key-1&base_url=" + url.QueryEscape(srv.URL)).OK()
	resp.JSON(&sn)
	if !sn.KeyEnv || !strings.Contains(sn.Curl, "$IROHA_KEY") || !strings.Contains(sn.Python, `os.environ["IROHA_KEY"]`) {
		t.Fatalf("snippets %+v", sn)
	}
	var fields map[string]any
	resp.JSON(&fields)
	if _, ok := fields["note"]; ok || strings.Contains(sn.Curl+sn.Python+sn.TypeScript, "key-1") {
		t.Fatalf("a pin shows in the snippets: %v", fields)
	}

	// A real shell, when there is one.
	shell, errSh := exec.LookPath("sh")
	_, errCurl := exec.LookPath("curl")
	if errSh != nil || errCurl != nil {
		t.Log("sh or curl not found; the shell run is skipped")
		return
	}
	cmd := exec.Command(shell, "-c", sn.Curl)
	cmd.Env = append(cmd.Environ(), "IROHA_KEY="+secret)
	out, err := cmd.Output()
	if err != nil || streamText(t, "openai-chat", out) != "it works" {
		t.Fatalf("shell run: %v\n%s", err, out)
	}
}
