package gateway_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/testkit"
)

type confAnthropicError struct {
	Type      string
	RequestID string `json:"request_id"`
	Error     struct {
		Type, Code, Message, Hint string
		RequestID                 string `json:"request_id"`
		Details                   struct {
			Summary  string
			Attempts []struct {
				Seq                   int
				UpstreamKey           string `json:"upstream_key"`
				Status                int
				Rule, Outcome, Reason string
			}
		}
	}
}

func confAddKeys(t *testing.T, srv *testkit.Server, secrets ...string) {
	t.Helper()
	for _, s := range secrets {
		srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": s}).Expect(201)
	}
}

func confStreamed(model string) map[string]any {
	req := messages(model)
	req["stream"] = true
	return req
}

func confAnthropicText(events []testkit.Event) string {
	var b strings.Builder
	for _, e := range events {
		var d struct {
			Delta struct{ Text string }
		}
		if e.Event == "content_block_delta" && json.Unmarshal([]byte(e.Data), &d) == nil {
			b.WriteString(d.Delta.Text)
		}
	}
	return b.String()
}

func confChatChunk(delta map[string]any, finish any) string {
	b, _ := json.Marshal(map[string]any{"id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 1767225600, "model": "m",
		"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}})
	return string(b)
}

func confUntil(s *liveStream, want string) {
	s.t.Helper()
	for range 100 {
		if strings.Contains(s.next(), want) {
			return
		}
	}
	s.t.Fatalf("no line containing %q in %q", want, s.seen)
}

func TestA429FromIrohaIsARateLimitErrorInEveryShape(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	srv.Admin.Put("/api/rules/rate-limited", map[string]any{"outcome": "fail_request"}).Expect(200)
	up.Default(up.ErrorCode(429, "rate_limit_exceeded", "Slow down"))
	key := issue(t, srv, "pi", all)

	resp := srv.Client(key).Post(chatPath, chat("gpt-x")).Expect(429)
	var oai struct {
		Error map[string]any
	}
	resp.JSON(&oai)
	if param, ok := oai.Error["param"]; !ok || param != nil {
		t.Errorf("param = %v (present %v), want null", param, ok)
	}
	if oai.Error["type"] != "rate_limit_error" || oai.Error["code"] != "upstream_rejected" || !strings.Contains(oai.Error["message"].(string), "Slow down") {
		t.Errorf("OpenAI error = %s", resp.Body)
	}

	var ant confAnthropicError
	srv.Anon.WithHeader("x-api-key", key).Post(messagesPath, messages("m")).Expect(429).JSON(&ant)
	if ant.Type != "error" || ant.Error.Type != "rate_limit_error" || ant.Error.Code != "upstream_rejected" {
		t.Errorf("Anthropic error = %+v", ant)
	}

	var gem struct {
		Error struct {
			Code           int
			Status, Reason string
		}
	}
	srv.Anon.WithHeader("x-goog-api-key", key).Post("/providers/acme/v1beta/models/m:generateContent",
		map[string]any{"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "hi"}}}}}).Expect(429).JSON(&gem)
	if gem.Error.Code != 429 || gem.Error.Status != "RESOURCE_EXHAUSTED" || gem.Error.Reason != "upstream_rejected" {
		t.Errorf("Gemini error = %+v", gem)
	}
}

func TestAnHTMLPageSentWith200IsAFailedAttemptWhenTranslating(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-a")
	confAddKeys(t, srv, "sk-test-b")
	caller := claudeCaller(t, srv)
	html := testkit.Raw(200, "text/html; charset=utf-8", "<html><body>Please sign in</body></html>")

	for _, req := range []map[string]any{messages("m"), confStreamed("m")} {
		n := up.Count()
		up.Enqueue(html)
		resp := caller.Post(messagesPath, req).Expect(200)
		if req["stream"] == true {
			if ev := resp.Events(); confAnthropicText(ev) != "Hello from the fake openai-chat upstream." || ev[len(ev)-1].Event != "message_stop" {
				t.Fatalf("stream = %s", resp.Body)
			}
		} else if m := resp.Map(); m["type"] != "message" {
			t.Fatalf("answer = %s", resp.Body)
		}
		if got := bearers(up, n); got != "a,b" && got != "b,a" {
			t.Fatalf("keys tried = %s", got)
		}
		r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
		a := r.Attempts[0]
		if r.Status != 200 || r.Error != nil || len(r.Attempts) != 2 || a.Status != 200 || a.Rule != "server-error" || a.Outcome != "retry_elsewhere" ||
			!strings.Contains(a.FailureBody, "Please sign in") || !strings.Contains(a.Reason, "sent inside a 2xx answer") {
			t.Fatalf("request = %+v", r)
		}
	}

	srv.SkipShortWaits(time.Second)
	up.Default(html)
	var e confAnthropicError
	resp := caller.Post(messagesPath, messages("m")).Expect(502).JSON(&e)
	if e.Type != "error" || e.Error.Type != "api_error" || e.Error.Code != "upstream_failed" || len(e.Error.Details.Attempts) != 3 ||
		e.Error.Details.Attempts[0].Status != 200 || !strings.Contains(e.Error.Message, "Please sign in") {
		t.Fatalf("error = %s", resp.Body)
	}
	if r := readRequest(t, srv, e.Error.RequestID); r.Status != 502 || r.Error == nil || r.Error.Code != "upstream_failed" {
		t.Fatalf("request = %+v", r)
	}
}

func TestAnHTMLPageSentWith200PassesThroughUntouched(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", up.URL(), "sk-test-a")
	page := "<html><body>Maintenance</body></html>"
	up.Enqueue(testkit.Raw(200, "text/html", page))
	resp := claudeCaller(t, srv).Post(messagesPath, messages("m")).Expect(200)
	if resp.Text() != page || resp.Header.Get("Content-Type") != "text/html" || up.Count() != 1 {
		t.Fatalf("answer = %q (%s), upstream calls %d", resp.Body, resp.Header.Get("Content-Type"), up.Count())
	}
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Status != 200 || r.Error != nil || r.AttemptCount != 1 {
		t.Fatalf("request = %+v", r)
	}
}

func TestAMessagesCallerGetsTheProvidersRefusalInAnthropicsEnvelope(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", up.URL(), "sk-test-a")
	confAddKeys(t, srv, "sk-test-b")
	caller := claudeCaller(t, srv)

	for _, req := range []map[string]any{messages("m"), confStreamed("m")} {
		up.Enqueue(up.ErrorCode(529, "overloaded_error", "Overloaded"), up.ErrorCode(400, "invalid_request_error", "max_tokens: too large"))
		var e confAnthropicError
		resp := caller.Post(messagesPath, req).Expect(400).JSON(&e)
		if !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") || e.Type != "error" || e.RequestID == "" ||
			e.Error.Type != "invalid_request_error" || e.Error.Code != "upstream_rejected" || e.Error.RequestID != e.RequestID || e.Error.Hint == "" ||
			!strings.Contains(e.Error.Message, "max_tokens: too large") {
			t.Fatalf("stream %v: error = %s", req["stream"], resp.Body)
		}
		at := e.Error.Details.Attempts
		if len(at) != 2 || at[0].Status != 529 || at[0].Outcome != "retry_elsewhere" || at[1].Status != 400 || at[1].Rule != "bad-request" || at[1].Outcome != "fail_request" {
			t.Fatalf("stream %v: attempts = %+v", req["stream"], at)
		}
		if r := readRequest(t, srv, e.RequestID); r.Status != 400 || r.Error == nil || r.Error.Code != "upstream_rejected" {
			t.Fatalf("stream %v: request = %+v", req["stream"], r)
		}
	}
}

func TestAMessagesCallerWhoseKeysAreAllRateLimitedGets503WithRetryAfter(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-a")
	confAddKeys(t, srv, "sk-test-b")
	caller := claudeCaller(t, srv)
	up.Default(up.ErrorCode(429, "rate_limit_exceeded", "Slow down").Header("Retry-After", "30"))

	for _, req := range []map[string]any{messages("m1"), confStreamed("m2")} {
		var e confAnthropicError
		resp := caller.Post(messagesPath, req).Expect(http.StatusServiceUnavailable).JSON(&e)
		if resp.Header.Get("Retry-After") != "30" || e.Type != "error" || e.Error.Type != "overloaded_error" || e.Error.Code != "upstream_unavailable" ||
			!strings.Contains(e.Error.Hint, "Retry after 30 seconds") || len(e.Error.Details.Attempts) != 2 || e.Error.Details.Summary == "" {
			t.Fatalf("stream %v: error = %s (Retry-After %q)", req["stream"], resp.Body, resp.Header.Get("Retry-After"))
		}
		for _, a := range e.Error.Details.Attempts {
			if a.Status != 429 || a.Rule != "rate-limited" || a.Outcome != "cooling_key_model" {
				t.Fatalf("stream %v: attempts = %+v", req["stream"], e.Error.Details.Attempts)
			}
		}
	}
}

func TestAMessagesStreamFromChatThatBreaksEndsWithAnErrorEvent(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-a")
	caller := claudeCaller(t, srv)
	start := "data: " + confChatChunk(map[string]any{"role": "assistant", "content": ""}, nil) + "\n\n"
	hel := "data: " + confChatChunk(map[string]any{"content": "Hel"}, nil) + "\n\n"

	for _, tc := range []struct {
		name  string
		reply testkit.Responder
		code  string
	}{
		{"the connection drops", testkit.SSE(start, hel).ThenDisconnect(), "upstream_stream_broken"},
		{"the Provider sends an error chunk", testkit.SSE(start, hel, `data: {"error":{"message":"upstream exploded","type":"server_error","code":"boom"}}`+"\n\n"), "upstream_stream_error"},
	} {
		up.Enqueue(tc.reply)
		resp := caller.Post(messagesPath, confStreamed("m")).Expect(200)
		events := resp.Events()
		last := events[len(events)-1]
		var e confAnthropicError
		_ = json.Unmarshal([]byte(last.Data), &e)
		if confAnthropicText(events) != "Hel" || last.Event != "error" || e.Type != "error" || e.Error.Code != tc.code || e.Error.Type != "api_error" {
			t.Errorf("%s: events = %+v", tc.name, events)
		}
		for _, ev := range events {
			if ev.Event == "message_stop" || ev.Event == "message_delta" {
				t.Errorf("%s: a broken stream claimed completion: %+v", tc.name, events)
			}
		}
		if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Status != 200 || r.Error == nil || r.Error.Code != tc.code {
			t.Errorf("%s: request = %+v", tc.name, r)
		}
	}
}

func TestCRLFFramedStreamsFlowEventByEvent(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-a")
	key := issue(t, srv, "pi", all)
	crlf := func(payload string) []byte { return []byte("data: " + payload + "\r\n\r\n") }
	reply := func(hold chan struct{}) testkit.Responder {
		return func(*testkit.Received) testkit.Reply {
			return testkit.Reply{Status: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Chunks: []testkit.Chunk{
				{Data: crlf(confChatChunk(map[string]any{"role": "assistant", "content": ""}, nil))},
				{Data: crlf(confChatChunk(map[string]any{"content": "Hel"}, nil))},
				{Data: crlf(confChatChunk(map[string]any{"content": "lo"}, nil)), Wait: hold},
				{Data: crlf(confChatChunk(map[string]any{}, "stop"))},
				{Data: crlf("[DONE]")},
			}}
		}
	}
	open := func(c *testkit.Client, path string, body any) *liveStream {
		ch := make(chan *liveStream, 1)
		go func() {
			resp := c.Open(http.MethodPost, path, body)
			ch <- &liveStream{t: t, resp: resp, lines: eventLines(resp.Body)}
		}()
		return headers(t, ch)
	}

	hold := make(chan struct{})
	up.Enqueue(reply(hold))
	req := chat("m")
	req["stream"] = true
	s := open(srv.Client(key), chatPath, req)
	confUntil(s, `"content":"Hel"`)
	close(hold)
	events := s.rest()
	if got := text(t, events); got != "Hello" || events[len(events)-1].Data != "[DONE]" {
		t.Fatalf("passthrough: text %q, events %+v", got, events)
	}

	hold = make(chan struct{})
	up.Enqueue(reply(hold))
	s = open(srv.Anon.WithHeader("x-api-key", key), messagesPath, confStreamed("m"))
	confUntil(s, `"text":"Hel"`)
	close(hold)
	events = s.rest()
	if got := confAnthropicText(events); got != "Hello" || events[len(events)-1].Event != "message_stop" {
		t.Fatalf("translated: text %q, events %+v", got, events)
	}
}
