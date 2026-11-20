package gateway_test

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/testkit"
)

// Prompt caching 03: what a translated request gets for the Provider's
// prompt cache, end to end through the fake Providers.

// addCachingProvider creates Provider acme with one Endpoint speaking sh at
// url, with extra Endpoint fields (the caching settings), and one key.
func addCachingProvider(t *testing.T, srv *testkit.Server, sh, url string, extra map[string]any) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	ep := map[string]any{"name": "main", "url": url, "shape": sh}
	for k, v := range extra {
		ep[k] = v
	}
	srv.Admin.Post("/api/providers/acme/endpoints", ep).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-1"}).Expect(201)
}

// passthroughCases are one Caller body per Shape, sent to an Endpoint of
// the same Shape, with markers, conversation fields and Gemini's
// cachedContent, and odd spacing to show the bytes are the Caller's.
var passthroughCases = []struct {
	shape, path, body string
	up                func(testing.TB) *testkit.Upstream
	key               bool // an OpenAI Shape: gets the derived prompt_cache_key
}{
	{"openai-chat", chatPath, `{"model":"m",  "messages":[{"role":"system","content":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral","ttl":"1h"}}]},{"role":"user","content":"hi"}],"user":"u-1","safety_identifier":"s-1"}`, testkit.NewOpenAIChat, true},
	{"openai-responses", responsesPath, `{"model":"m","input":"hi",  "user":"u-1","metadata":{"a":"b"}}`, testkit.NewOpenAIResponses, true},
	{"anthropic-messages", messagesPath, `{"model":"m","max_tokens":10,"system":[{"type":"text","text":"sys","cache_control":{"type":"ephemeral"}}],"messages":[{"role":"user","content":"hi"}],"metadata":{"user_id":"u-1"}}`, testkit.NewAnthropic, false},
	{"gemini", geminiModels + "m:generateContent", `{"cachedContent":"cachedContents/abc",  "contents":[{"role":"user","parts":[{"text":"hi"}]}]}`, testkit.NewGemini, false},
}

// sessionHeaders are the headers relays and Providers route a session by.
var sessionHeaders = []string{"x-session-affinity", "x-session-id", "session_id"}

// sentKey is the prompt_cache_key of a request body, "" when none.
func sentKey(t *testing.T, body []byte) string {
	t.Helper()
	var b struct {
		Key *string `json:"prompt_cache_key"`
	}
	if err := json.Unmarshal(body, &b); err != nil {
		t.Fatalf("body %s: %v", body, err)
	}
	if b.Key == nil {
		return ""
	}
	return *b.Key
}

var appendedKey = regexp.MustCompile(`,"prompt_cache_key":"[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"}$`)

// callerBytes is a passthrough body without the prompt_cache_key Iroha
// appends (prompt caching 04), failing the test when none was appended:
// what remains must be the Caller's bytes.
func callerBytes(t *testing.T, body []byte) string {
	t.Helper()
	loc := appendedKey.FindIndex(body)
	if loc == nil {
		t.Fatalf("no prompt_cache_key appended to %s", body)
	}
	return string(body[:loc[0]]) + "}"
}

// Prompt caching 04: same-Shape passthrough gets the conversation's ID.
// OpenAI Chat and Responses bodies are the Caller's plus exactly the
// appended prompt_cache_key; Anthropic and Gemini bodies stay byte for
// byte; every Shape gets the session headers with the same value, and
// Iroha-Session itself is not forwarded.
func TestPassthroughAddsTheConversationIDAndNothingElse(t *testing.T) {
	for _, tc := range passthroughCases {
		t.Run(tc.shape, func(t *testing.T) {
			srv := testkit.Start(t)
			up := tc.up(t)
			addCachingProvider(t, srv, tc.shape, up.URL(), nil)
			srv.Client(issue(t, srv, "pi", all)).WithHeader("Iroha-Session", "s-1").Post(tc.path, tc.body).Expect(200)
			got := up.Last()
			want := tc.body
			key := sentKey(t, got.Body)
			if tc.key {
				if !uuidPattern.MatchString(key) {
					t.Fatalf("prompt_cache_key %q in\n%s", key, got.Body)
				}
				want = tc.body[:len(tc.body)-1] + `,"prompt_cache_key":"` + key + `"}`
			}
			if string(got.Body) != want {
				t.Fatalf("upstream got\n%s\nwant\n%s", got.Body, want)
			}
			if tc.key {
				// Same value in the headers as in the body.
				for _, h := range sessionHeaders {
					if v := got.Header.Values(h); len(v) != 1 || v[0] != key {
						t.Errorf("%s = %q, want %q", h, v, key)
					}
				}
			} else {
				for _, h := range sessionHeaders {
					if v := got.Header.Get(h); !uuidPattern.MatchString(v) {
						t.Errorf("%s = %q", h, v)
					}
				}
			}
			if got.Header.Get("Iroha-Session") != "" {
				t.Errorf("Iroha-Session forwarded")
			}
		})
	}
}

// send_prompt_cache_key off turns every addition off, headers included:
// each Shape's body is byte for byte and no session header is sent.
func TestPromptCacheKeyOffKeepsPassthroughByteForByte(t *testing.T) {
	for _, tc := range passthroughCases {
		t.Run(tc.shape, func(t *testing.T) {
			srv := testkit.Start(t)
			up := tc.up(t)
			addCachingProvider(t, srv, tc.shape, up.URL(), map[string]any{"cache_markers": "on", "send_prompt_cache_key": "off"})
			srv.Client(issue(t, srv, "pi", all)).WithHeader("Iroha-Session", "s-1").Post(tc.path, tc.body).Expect(200)
			got := up.Last()
			if string(got.Body) != tc.body {
				t.Fatalf("upstream got\n%s\nwant\n%s", got.Body, tc.body)
			}
			for _, h := range sessionHeaders {
				if v := got.Header.Get(h); v != "" {
					t.Errorf("%s = %q with send_prompt_cache_key off", h, v)
				}
			}
		})
	}
}

// The Caller's own prompt_cache_key and session headers are forwarded as
// they are, never overwritten nor sent twice; only the missing ones are
// added.
func TestTheCallersOwnConversationIDsAreKept(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
	caller := srv.Client(issue(t, srv, "pi", all))

	body := `{"model":"m","messages":[{"role":"user","content":"hi"}],"prompt_cache_key":"mine"}`
	caller.Post(chatPath, body).Expect(200)
	if got := up.Last(); string(got.Body) != body {
		t.Fatalf("upstream got %s", got.Body)
	}

	for _, own := range sessionHeaders {
		t.Run(own, func(t *testing.T) {
			caller.WithHeader(own, "their-session").Post(chatPath, chatBody("m")).Expect(200)
			got := up.Last()
			if v := got.Header.Values(own); len(v) != 1 || v[0] != "their-session" {
				t.Errorf("%s = %q", own, v)
			}
			key := sentKey(t, got.Body)
			if !uuidPattern.MatchString(key) {
				t.Fatalf("prompt_cache_key %q: the Caller's raw session must not be sent", key)
			}
			for _, h := range sessionHeaders {
				if h != own && got.Header.Get(h) != key {
					t.Errorf("%s = %q, want the derived %q", h, got.Header.Get(h), key)
				}
			}
		})
	}
}

// A Request with no conversation (an empty prompt: affinity source none)
// gets nothing added.
func TestNoConversationGetsNoConversationID(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
	body := `{"model":"m","messages":[]}`
	srv.Client(issue(t, srv, "pi", all)).Post(chatPath, body).Expect(200)
	got := up.Last()
	if string(got.Body) != body {
		t.Fatalf("upstream got %s", got.Body)
	}
	for _, h := range sessionHeaders {
		if v := got.Header.Get(h); v != "" {
			t.Errorf("%s = %q", h, v)
		}
	}
}

// One conversation keeps one value across Requests; another Gateway Key,
// Provider or model gets another.
func TestPassthroughConversationIDsAreScopedToKeyProviderAndModel(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "zeta"}).Expect(201)
	srv.Admin.Post("/api/providers/zeta/endpoints", map[string]any{"name": "main", "url": up.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/zeta/keys", map[string]any{"secret": "sk-test-2"}).Expect(201)
	pi := srv.Client(issue(t, srv, "pi", all)).WithHeader("Iroha-Session", "s-1")
	zed := srv.Client(issue(t, srv, "zed", all)).WithHeader("Iroha-Session", "s-1")

	key := func(c *testkit.Client, path, model string) string {
		t.Helper()
		c.Post(path, chatBody(model)).Expect(200)
		k := sentKey(t, up.Last().Body)
		if k == "" || up.Last().Header.Get("x-session-affinity") != k {
			t.Fatalf("body key %q, header %q", k, up.Last().Header.Get("x-session-affinity"))
		}
		return k
	}
	a := key(pi, chatPath, "m")
	if key(pi, chatPath, "m") != a {
		t.Errorf("the same conversation got two values")
	}
	if key(zed, chatPath, "m") == a {
		t.Errorf("another Gateway Key got the same value")
	}
	if key(pi, chatPath, "m2") == a {
		t.Errorf("another model got the same value")
	}
	if key(pi, strings.Replace(chatPath, "/acme/", "/zeta/", 1), "m") == a {
		t.Errorf("another Provider got the same value")
	}
}

// A host that refuses unknown fields gets the session headers (headers it
// doesn't know are ignored) but no prompt_cache_key in the body.
func TestAStrictHostGetsHeadersButNoBodyField(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addCachingProvider(t, srv, "openai-chat", up.URLAt("generativelanguage.googleapis.com"), nil)
	body := `{"model":"m","messages":[{"role":"user","content":"hi"}]}`
	srv.Client(issue(t, srv, "pi", all)).WithHeader("Iroha-Session", "s-1").Post(chatPath, body).Expect(200)
	got := up.Last()
	if string(got.Body) != body {
		t.Fatalf("upstream got %s", got.Body)
	}
	for _, h := range sessionHeaders {
		if v := got.Header.Get(h); !uuidPattern.MatchString(v) {
			t.Errorf("%s = %q", h, v)
		}
	}
}

// On passthrough Iroha's prompt_cache_key is the only difference from the
// Caller's body, so a 400 the Failure Rules would end the Request with is
// asked again once without it, whatever its wording, outside the Attempt
// budget. A 400 the rules read as the key's problem is handled as before.
func TestAPassthrough400IsAskedAgainWithoutThePromptCacheKey(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
	srv.Admin.Patch("/api/providers/acme", map[string]any{"max_attempts": 1}).Expect(200)
	caller := srv.Client(issue(t, srv, "pi", all))
	odd := testkit.Raw(400, "application/json", `{"error":{"message":"Bad request: something went wrong","type":"invalid_request_error"}}`)

	up.Enqueue(odd, up.Text("hello"))
	resp := caller.WithHeader("Iroha-Session", "s-1").Post(chatPath, chatBody("m")).Expect(200)
	reqs := up.Requests()
	if len(reqs) != 2 || sentKey(t, reqs[0].Body) == "" || sentKey(t, reqs[1].Body) != "" {
		t.Fatalf("%d upstream calls; bodies %s / %s", len(reqs), reqs[0].Body, up.Last().Body)
	}
	if reqs[1].Header.Get("x-session-affinity") == "" {
		t.Errorf("the plain retry dropped the session headers")
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Outcome != "retry_elsewhere" || r.Attempts[0].UpstreamKey != r.Attempts[1].UpstreamKey ||
		!strings.Contains(r.Attempts[0].Action, "without") {
		t.Fatalf("attempts %+v", r.Attempts)
	}

	// The plain retry fails too: the Caller gets that 400, as before.
	up.Enqueue(odd, odd)
	resp = caller.WithHeader("Iroha-Session", "s-2").Post(chatPath, chatBody("m")).Expect(400)
	if up.Count() != 4 || !strings.Contains(string(resp.Body), "something went wrong") {
		t.Fatalf("%d upstream calls; answer %s", up.Count(), resp.Body)
	}

	// A 400 that is the key's problem (billing) cools the key, no plain retry.
	up.Enqueue(testkit.Raw(400, "application/json", `{"error":{"message":"Your credit balance is too low to access the API.","type":"invalid_request_error"}}`))
	caller.WithHeader("Iroha-Session", "s-3").Post(chatPath, chatBody("m"))
	if up.Count() != 5 {
		t.Fatalf("%d upstream calls after a billing 400", up.Count())
	}
}

func agentChat() map[string]any {
	return map[string]any{"model": "claude-x", "max_tokens": 256, "user": "u-42",
		"messages": []any{
			map[string]any{"role": "system", "content": "You are an agent."},
			map[string]any{"role": "user", "content": "hi"},
		},
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{"name": "read", "parameters": map[string]any{"type": "object"}}}},
	}
}

func TestAChatCallerGetsCacheMarkersOnAnAnthropicEndpointUnlessTheyAreOff(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewAnthropic(t)
	addCachingProvider(t, srv, "anthropic-messages", up.URL(), map[string]any{"auth_style": "x-api-key"})
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(testkit.JSON(200, map[string]any{"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-x", "stop_reason": "end_turn",
		"content": []any{map[string]any{"type": "text", "text": "hello"}},
		"usage":   map[string]any{"input_tokens": 5, "output_tokens": 1, "cache_creation_input_tokens": 3000}}))
	resp := caller.Post(chatPath, agentChat()).Expect(200)
	got := up.Last()
	if p := strings.Join(testkit.CacheMarkers(t, got.Body), ", "); p != "tool:read=5m, system:You are an agent.=5m, user:hi=5m" {
		t.Errorf("markers on %s:\n%s", p, got.Body)
	}
	var sent struct {
		Metadata struct {
			UserID string `json:"user_id"`
		}
	}
	got.JSON(t, &sent)
	if sent.Metadata.UserID != "u-42" {
		t.Errorf("metadata.user_id = %q", sent.Metadata.UserID)
	}
	// The write the markers caused is reported to the Caller and recorded.
	var ans struct {
		Usage struct {
			Details struct {
				CacheWrite int `json:"cache_write_tokens"`
			} `json:"prompt_tokens_details"`
		}
	}
	resp.JSON(&ans)
	if ans.Usage.Details.CacheWrite != 3000 {
		t.Errorf("answer %s", resp.Body)
	}
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Usage == nil || r.Usage.CacheWrite != 3000 {
		t.Errorf("recorded usage %+v", r.Usage)
	}

	srv.Admin.Patch("/api/providers/acme/endpoints/main", map[string]any{"cache_markers": "off"}).Expect(200)
	caller.Post(chatPath, agentChat()).Expect(200)
	if strings.Contains(string(up.Last().Body), "cache_control") {
		t.Errorf("markers sent with cache_markers off: %s", up.Last().Body)
	}
}

func TestAnthropicsOwnAPIGetsTheAutomaticTopLevelMarker(t *testing.T) {
	up := testkit.NewAnthropic(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addCachingProvider(t, srv, "anthropic-messages", up.URLAt("api.anthropic.com"), map[string]any{"auth_style": "x-api-key"})
	srv.Client(issue(t, srv, "pi", all)).Post(chatPath, agentChat()).Expect(200)
	if p := strings.Join(testkit.CacheMarkers(t, up.Last().Body), ", "); p != "top=5m" {
		t.Errorf("markers on %s", p)
	}
	var ep struct {
		Caching struct {
			Markers        string
			PromptCacheKey bool `json:"prompt_cache_key"`
			Summary        string
		}
	}
	srv.Admin.Get("/api/providers/acme/endpoints/main").OK().JSON(&ep)
	if ep.Caching.Markers != "top_level" || ep.Caching.Summary == "" {
		t.Errorf("the Endpoint says %+v", ep.Caching)
	}
}

var uuidPattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// A conversation translated to an OpenAI Endpoint gets a prompt_cache_key
// of its own, the same on every turn, derived from its affinity value (so
// scoped to the Gateway Key, Provider and model); off sends none.
func TestTranslatedConversationsGetADerivedPromptCacheKey(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
	pi := srv.Anon.WithHeader("x-api-key", issue(t, srv, "pi", all))
	zed := srv.Anon.WithHeader("x-api-key", issue(t, srv, "zed", all))

	key := func(c *testkit.Client, session string) string {
		t.Helper()
		c.WithHeader("X-Claude-Code-Session-Id", session).Post(messagesPath, messages("gpt-x")).Expect(200)
		var sent struct {
			Key  *string `json:"prompt_cache_key"`
			User *string
		}
		up.Last().JSON(t, &sent)
		if sent.User != nil {
			t.Errorf("user sent: %s", *sent.User)
		}
		if sent.Key == nil {
			return ""
		}
		return *sent.Key
	}
	a := key(pi, "s-1")
	if !uuidPattern.MatchString(a) {
		t.Fatalf("prompt_cache_key %q is not a UUID", a)
	}
	if key(pi, "s-1") != a || key(pi, "s-2") == a || key(zed, "s-1") == a {
		t.Errorf("one key per conversation and Caller")
	}
	srv.Admin.Patch("/api/providers/acme/endpoints/main", map[string]any{"send_prompt_cache_key": "off"}).Expect(200)
	if k := key(pi, "s-1"); k != "" {
		t.Errorf("sent %q with send_prompt_cache_key off", k)
	}
}

// An Endpoint refusing what Iroha added for the cache (a field it doesn't
// know) is asked again at once without it: nothing that worked before
// prompt caching 03 fails now, and the key is not blamed.
func TestAnEndpointRefusingTheCacheFieldsIsAskedAgainWithoutThem(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
	caller := claudeCaller(t, srv)
	up.Enqueue(testkit.Raw(400, "application/json", `{"error":{"message":"Unrecognized request argument supplied: prompt_cache_key","type":"invalid_request_error"}}`), up.Text("hello"))
	resp := caller.WithHeader("Iroha-Session", "s-1").Post(messagesPath, messages("gpt-x")).Expect(200)
	if !strings.Contains(string(up.Requests()[0].Body), "prompt_cache_key") || strings.Contains(string(up.Last().Body), "prompt_cache_key") {
		t.Fatalf("bodies:\n%s\n%s", up.Requests()[0].Body, up.Last().Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Outcome != "retry_elsewhere" || !strings.Contains(r.Attempts[0].Action, "without") ||
		r.Attempts[0].UpstreamKey != r.Attempts[1].UpstreamKey {
		t.Fatalf("attempts %+v", r.Attempts)
	}
	if k := readKey(t, srv, r.Attempts[0].UpstreamKey); k.State.State != "active" {
		t.Errorf("key state %+v", k.State)
	}

	// The same on Anthropic for markers.
	srv2 := testkit.Start(t)
	ant := testkit.NewAnthropic(t)
	addCachingProvider(t, srv2, "anthropic-messages", ant.URL(), map[string]any{"auth_style": "x-api-key"})
	ant.Enqueue(testkit.Raw(400, "application/json", `{"type":"error","error":{"type":"invalid_request_error","message":"system.0.cache_control: Extra inputs are not permitted"}}`))
	srv2.Client(issue(t, srv2, "pi", all)).Post(chatPath, agentChat()).Expect(200)
	if ant.Count() != 2 || strings.Contains(string(ant.Last().Body), "cache_control") {
		t.Fatalf("second body %s", ant.Last().Body)
	}
}

// The retry without Iroha's additions is free: it is its own Attempt but
// does not use the Request's budget, so a Provider allowing one Attempt
// still serves, and one with two keys keeps its fallback to the second.
func TestTheRetryWithoutCacheFieldsUsesNoAttemptOfTheBudget(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
	srv.Admin.Patch("/api/providers/acme", map[string]any{"max_attempts": 1}).Expect(200)
	refusal := testkit.Raw(400, "application/json", `{"error":{"message":"Unrecognized request argument supplied: prompt_cache_key","type":"invalid_request_error"}}`)
	caller := claudeCaller(t, srv)
	up.Enqueue(refusal, up.Text("hello"))
	resp := caller.WithHeader("Iroha-Session", "s-1").Post(messagesPath, messages("gpt-x")).Expect(200)
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); len(r.Attempts) != 2 || r.Attempts[0].Outcome != "retry_elsewhere" || r.Attempts[1].Status != 200 {
		t.Fatalf("attempts %+v", r.Attempts)
	}

	// With two Attempts and two keys, a 5xx on the plain retry still moves on
	// to the second key.
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-2"}).Expect(201)
	srv.Admin.Patch("/api/providers/acme", map[string]any{"max_attempts": 2}).Expect(200)
	srv.SkipShortWaits(time.Second)
	up.Enqueue(refusal, up.Error(503, "busy"), up.Text("hello"))
	resp = caller.WithHeader("Iroha-Session", "s-2").Post(messagesPath, messages("gpt-x")).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 3 || r.Attempts[0].UpstreamKey != r.Attempts[1].UpstreamKey || r.Attempts[2].UpstreamKey == r.Attempts[1].UpstreamKey {
		t.Fatalf("attempts %+v", r.Attempts)
	}

	// At most once per Endpoint: a second refusal on the plain request is
	// judged by the Failure Rules like any other 400.
	srv.Admin.Patch("/api/providers/acme", map[string]any{"max_attempts": 1}).Expect(200)
	up.Enqueue(refusal, refusal)
	resp = caller.WithHeader("Iroha-Session", "s-3").Post(messagesPath, messages("gpt-x"))
	if resp.Status == 200 || up.Count() != 7 {
		t.Fatalf("status %d after %d upstream calls", resp.Status, up.Count())
	}
}

// Only a refusal of the field as unknown is retried: a 400 that merely
// quotes 'user' (a role error) or echoes the request (which holds the
// added prompt_cache_key) is judged by the Failure Rules as before, with
// no second call.
func TestAnOrdinary400NamingAnAddedFieldIsNotRetried(t *testing.T) {
	for name, body := range map[string]string{
		"role error": `{"error":{"message":"Invalid value: 'tool'. Supported values are: 'system', 'assistant', 'user'.","type":"invalid_request_error","param":"messages[1].role"}}`,
		"body echo":  `{"error":{"message":"Invalid request","type":"invalid_request_error","request":{"model":"gpt-x","user":"u-7","prompt_cache_key":"0b1c"}}}`,
	} {
		t.Run(name, func(t *testing.T) {
			srv := testkit.Start(t)
			up := testkit.NewOpenAIChat(t)
			addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
			up.Enqueue(testkit.Raw(400, "application/json", body), up.Text("hello"))
			req := messages("gpt-x")
			req["metadata"] = map[string]any{"user_id": "u-7"}
			resp := claudeCaller(t, srv).WithHeader("Iroha-Session", "s-1").Post(messagesPath, req)
			if !strings.Contains(string(up.Last().Body), "prompt_cache_key") || !strings.Contains(string(up.Last().Body), `"user"`) {
				t.Fatalf("the request lacks Iroha's additions: %s", up.Last().Body)
			}
			if resp.Status != 400 || up.Count() != 1 {
				t.Fatalf("status %d after %d upstream calls: %s", resp.Status, up.Count(), resp.Body)
			}
		})
	}
}

// A Gemini request naming a stored cache is refused when it would be
// translated (its context would be silently lost), before any Attempt.
func TestGeminiCachedContentIsRefusedWhenTranslated(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
	var e struct {
		Error struct {
			Code    int
			Status  string
			Message string
			Details []struct {
				Reason string
			}
		}
	}
	body := `{"cachedContent":"cachedContents/abc","contents":[{"role":"user","parts":[{"text":"hi"}]}]}`
	resp := srv.Anon.WithHeader("x-goog-api-key", issue(t, srv, "pi", all)).Post(geminiModels+"m:generateContent", body).Expect(400)
	resp.JSON(&e)
	if !strings.Contains(string(resp.Body), "untranslatable_request") || !strings.Contains(e.Error.Message, "cachedContent") ||
		!strings.Contains(string(resp.Body), "Send the cached contents") || up.Count() != 0 {
		t.Fatalf("answer %s (upstream calls %d)", resp.Body, up.Count())
	}
}

// The two settings are Endpoint fields: checked, audited and revertible.
func TestCachingSettingsAreEndpointFields(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addCachingProvider(t, srv, "openai-chat", up.URL(), nil)
	srv.Admin.Patch("/api/providers/acme/endpoints/main", map[string]any{"cache_markers": "sometimes"}).Expect(400)
	var res struct {
		AuditEntry string `json:"audit_entry"`
		Endpoint   struct {
			CacheMarkers       string `json:"cache_markers"`
			SendPromptCacheKey string `json:"send_prompt_cache_key"`
		}
	}
	srv.Admin.Patch("/api/providers/acme/endpoints/main", map[string]any{"cache_markers": "on", "send_prompt_cache_key": "off"}).OK().JSON(&res)
	if res.Endpoint.CacheMarkers != "on" || res.Endpoint.SendPromptCacheKey != "off" || res.AuditEntry == "" {
		t.Fatalf("%+v", res)
	}
	srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).OK()
	srv.Admin.Get("/api/providers/acme/endpoints/main").OK().JSON(&res.Endpoint)
	if res.Endpoint.CacheMarkers != "" || res.Endpoint.SendPromptCacheKey != "" {
		t.Fatalf("after revert %+v", res.Endpoint)
	}
	// The OpenAPI document describes both settings and the read-only effect.
	doc := string(srv.Anon.Get("/api/openapi.json").Expect(200).Body)
	for _, s := range []string{`"cache_markers"`, `"send_prompt_cache_key"`, `"EndpointCaching"`, "top_only"} {
		if !strings.Contains(doc, s) {
			t.Errorf("openapi lacks %s", s)
		}
	}
}
