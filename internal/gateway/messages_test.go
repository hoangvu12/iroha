package gateway_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testkit"
	"github.com/hoangvu12/iroha/internal/usage"
)

const messagesPath = "/providers/acme/v1/messages"

func addEndpointProvider(t *testing.T, srv *testkit.Server, handle, sh, url, secret string) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": handle}).Expect(201)
	ep := map[string]any{"url": url, "shape": sh}
	if sh == "anthropic-messages" {
		ep["auth_style"] = "x-api-key"
	}
	srv.Admin.Post("/api/providers/"+handle+"/endpoints", ep).Expect(201)
	srv.Admin.Post("/api/providers/"+handle+"/keys", map[string]any{"secret": secret}).Expect(201)
}

func messages(model string) map[string]any {
	return map[string]any{"model": model, "max_tokens": 256, "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
}

// The Anthropic SDK and Claude Code send the key in x-api-key.
func claudeCaller(t *testing.T, srv *testkit.Server) *testkit.Client {
	return srv.Anon.WithHeader("x-api-key", issue(t, srv, "claude-code", all))
}

func TestMessagesPassThroughToAnAnthropicEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", up.URL(), "sk-test-ant")
	caller := claudeCaller(t, srv).WithHeader("anthropic-beta", "prompt-caching-2024-07-31")

	body := `{"model":"claude-x", "max_tokens":256, "messages":[{"role":"user","content":[{"type":"text","text":"hi","cache_control":{"type":"ephemeral"}}]}], "metadata":{"user_id":"u1"}}`
	resp := caller.Post(messagesPath, body).Expect(200)
	got := up.Last()
	if string(got.Body) != body || got.Path != "/v1/messages" || got.Header.Get("X-Api-Key") != "sk-test-ant" ||
		got.Header.Get("Anthropic-Version") != "2023-06-01" || got.Header.Get("Anthropic-Beta") != "prompt-caching-2024-07-31" {
		t.Fatalf("upstream got %s %v\n%s", got.Path, got.Header, got.Body)
	}
	if m := resp.Map(); m["model"] != "claude-x" || m["type"] != "message" {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "anthropic-messages" || r.ShapeOut != "anthropic-messages" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) {
		t.Fatalf("request = %+v usage %+v", r, r.Usage)
	}

	srv.Admin.Patch("/api/providers/acme/endpoints/default", map[string]any{"renames": map[string]string{"sonnet": "claude-sonnet-4-5"}}).OK()
	st := messages("sonnet")
	st["stream"] = true
	resp = caller.Post(messagesPath, st).Expect(200)
	if up.Last().Model != "claude-sonnet-4-5" {
		t.Fatalf("upstream model = %s", up.Last().Model)
	}
	events := resp.Events()
	if len(events) < 3 || events[0].Event != "message_start" || !strings.Contains(events[0].Data, `"model":"sonnet"`) || events[len(events)-1].Event != "message_stop" {
		t.Fatalf("events = %+v", events)
	}
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) || r.WireModel != "claude-sonnet-4-5" {
		t.Fatalf("stream request = %+v usage %+v", r, r.Usage)
	}
}

func TestMessagesAreTranslatedForAnOpenAIChatEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-oai")
	caller := claudeCaller(t, srv).WithHeader("anthropic-version", "2023-06-01")
	up.SetUsage(30, 7)

	req := messages("glm-4.6")
	req["system"] = "Be terse."
	req["thinking"] = map[string]any{"type": "enabled", "budget_tokens": 1000}
	resp := caller.Post(messagesPath, req).Expect(200)

	got := up.Last()
	sent := got.Map(t)
	if got.Path != "/v1/chat/completions" || got.Bearer() != "sk-test-oai" || got.Header.Get("Anthropic-Version") != "" || got.Header.Get("X-Api-Key") != "" {
		t.Fatalf("upstream got %s %v", got.Path, got.Header)
	}
	msgs, _ := sent["messages"].([]any)
	if len(msgs) != 2 || sent["reasoning_effort"] != "low" || sent["max_tokens"] != float64(256) {
		t.Fatalf("translated request = %s", got.Body)
	}
	var ans struct {
		Type, Role, Model string
		StopReason        string `json:"stop_reason"`
		Content           []struct{ Type, Text string }
		Usage             map[string]any
	}
	resp.JSON(&ans)
	if ans.Type != "message" || ans.Model != "glm-4.6" || ans.StopReason != "end_turn" || len(ans.Content) != 1 || ans.Content[0].Text == "" ||
		ans.Usage["input_tokens"] != float64(30) || ans.Usage["output_tokens"] != float64(7) {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "anthropic-messages" || r.ShapeOut != "openai-chat" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 30, Output: 7}) ||
		len(r.Attempts) != 1 || r.Attempts[0].Shape != "openai-chat" {
		t.Fatalf("request = %+v", r)
	}

	req["stream"] = true
	resp = caller.Post(messagesPath, req).Expect(200)
	if opts, _ := up.Last().Map(t)["stream_options"].(map[string]any); opts["include_usage"] != true {
		t.Fatalf("upstream stream request = %s", up.Last().Body)
	}
	events := resp.Events()
	var names []string
	var text strings.Builder
	for _, e := range events {
		names = append(names, e.Event)
		var d struct {
			Delta struct{ Text string }
		}
		if json.Unmarshal([]byte(e.Data), &d) == nil {
			text.WriteString(d.Delta.Text)
		}
	}
	if names[0] != "message_start" || names[len(names)-1] != "message_stop" || names[len(names)-2] != "message_delta" ||
		text.String() != "Hello from the fake openai-chat upstream." || !strings.Contains(events[0].Data, `"model":"glm-4.6"`) {
		t.Fatalf("events = %+v", events)
	}
	if !strings.Contains(events[len(events)-2].Data, `"output_tokens":7`) {
		t.Fatalf("message_delta = %s", events[len(events)-2].Data)
	}
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeOut != "openai-chat" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 30, Output: 7}) || r.Error != nil {
		t.Fatalf("stream request = %+v", r)
	}
}

func TestChatIsTranslatedForAnAnthropicEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", up.URL(), "sk-test-ant")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(testkit.JSON(200, map[string]any{
		"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5", "stop_reason": "tool_use",
		"content": []any{
			map[string]any{"type": "thinking", "thinking": "Need the file.", "signature": "sig"},
			map[string]any{"type": "tool_use", "id": "toolu_1", "name": "fs_read", "input": map[string]any{"path": "/a"}},
		},
		"usage": map[string]any{"input_tokens": 20, "output_tokens": 9, "cache_read_input_tokens": 4},
	}))
	req := chat("sonnet")
	req["reasoning_effort"] = "medium"
	req["max_tokens"] = 4000
	req["tools"] = []any{map[string]any{"type": "function", "function": map[string]any{"name": "fs.read", "parameters": map[string]any{"type": "object"}}}}
	resp := caller.Post(chatPath, req).Expect(200)

	got := up.Last()
	sent := got.Map(t)
	tools, _ := sent["tools"].([]any)
	if got.Path != "/v1/messages" || got.Header.Get("X-Api-Key") != "sk-test-ant" || got.Header.Get("Anthropic-Version") != "2023-06-01" ||
		len(tools) != 1 || tools[0].(map[string]any)["name"] != "fs_read" || sent["thinking"] == nil {
		t.Fatalf("upstream got %s %v\n%s", got.Path, got.Header, got.Body)
	}
	var ans struct {
		Object, Model string
		Choices       []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Reasoning string `json:"reasoning_content"`
				ToolCalls []struct {
					Function struct{ Name, Arguments string }
				} `json:"tool_calls"`
			}
		}
		Usage map[string]any
	}
	resp.JSON(&ans)
	if ans.Object != "chat.completion" || ans.Model != "sonnet" || len(ans.Choices) != 1 || ans.Choices[0].FinishReason != "tool_calls" ||
		ans.Choices[0].Message.Reasoning != "Need the file." || len(ans.Choices[0].Message.ToolCalls) != 1 ||
		ans.Choices[0].Message.ToolCalls[0].Function.Name != "fs.read" || ans.Usage["prompt_tokens"] != float64(24) {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "openai-chat" || r.ShapeOut != "anthropic-messages" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 24, Output: 9, CacheRead: 4}) {
		t.Fatalf("request = %+v usage %+v", r, r.Usage)
	}

	req["stream"] = true
	resp = caller.Post(chatPath, req).Expect(200)
	events := resp.Events()
	if got := text(t, events); got != "Hello from the fake anthropic-messages upstream." || events[len(events)-1].Data != "[DONE]" {
		t.Fatalf("events = %+v", events)
	}
	for _, e := range events {
		if strings.Contains(e.Data, `"usage"`) || (e.Data != "[DONE]" && !strings.Contains(e.Data, `"model":"sonnet"`)) {
			t.Fatalf("chunk %s", e.Data)
		}
	}
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) {
		t.Fatalf("stream usage = %+v", r.Usage)
	}
}

func TestSameShapeEndpointsComeBeforeTranslation(t *testing.T) {
	srv := testkit.Start(t)
	oai := testkit.NewOpenAIChat(t)
	ant := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", ant.URL(), "sk-test-a")
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "chat", "url": oai.URL(), "shape": "openai-chat"}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))

	caller.Post(chatPath, chat("m")).Expect(200)
	caller.Post(messagesPath, messages("m")).Expect(200)
	if oai.Count() != 1 || ant.Count() != 1 || oai.Last().Path != "/v1/chat/completions" || ant.Last().Path != "/v1/messages" {
		t.Fatalf("chat endpoint got %d, anthropic endpoint got %d", oai.Count(), ant.Count())
	}
}

func TestMessagesErrorsUseTheAnthropicEnvelope(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-oai")
	caller := claudeCaller(t, srv)

	var e struct {
		Type  string
		Error struct {
			Type, Code, Message, Hint string
			RequestID                 string `json:"request_id"`
		}
	}
	resp := caller.Post("/providers/nope/v1/messages", messages("m")).Expect(403)
	resp.JSON(&e)
	if e.Type != "error" || e.Error.Type != "permission_error" || e.Error.Code != "provider_not_allowed" || e.Error.RequestID == "" || e.Error.Hint == "" {
		t.Fatalf("error = %s", resp.Body)
	}
	resp = caller.Post(messagesPath, `{"max_tokens":1,"messages":[]}`).Expect(400)
	if !strings.Contains(resp.Text(), `"code":"model_required"`) || !strings.Contains(resp.Text(), "Anthropic Messages") {
		t.Fatalf("error = %s", resp.Body)
	}
	resp = caller.Post(messagesPath, `{"model":"m","max_tokens":1,"messages":"hi"}`).Expect(400)
	resp.JSON(&e)
	if e.Error.Code != "untranslatable_request" || e.Error.Type != "invalid_request_error" || up.Count() != 0 {
		t.Fatalf("error = %s (upstream calls %d)", resp.Body, up.Count())
	}
	r := readRequest(t, srv, e.Error.RequestID)
	if r.Status != 400 || r.Error == nil || r.Error.Code != "untranslatable_request" {
		t.Fatalf("request = %+v", r)
	}
}

func TestATranslatedStreamThatFailsEndsWithTheCallersErrorEvent(t *testing.T) {
	srv := testkit.Start(t)
	ant := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", ant.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))
	start := `{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"usage":{"input_tokens":3,"output_tokens":1}}}`
	block := `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`
	delta := `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}`
	ev := func(name, data string) string { return "event: " + name + "\ndata: " + data + "\n\n" }

	cases := []struct {
		name  string
		reply testkit.Responder
		code  string
	}{
		{"the Provider reports an error", testkit.SSE(ev("message_start", start), ev("content_block_start", block), ev("content_block_delta", delta),
			ev("error", `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`)), "upstream_stream_error"},
		{"the stream ends before the answer did", testkit.SSE(ev("message_start", start), ev("content_block_start", block), ev("content_block_delta", delta)), "upstream_stream_broken"},
	}
	for _, tc := range cases {
		ant.Enqueue(tc.reply)
		req := chat("m")
		req["stream"] = true
		resp := caller.Post(chatPath, req).Expect(200)
		events := resp.Events()
		if text(t, events) != "Hel" {
			t.Errorf("%s: events = %+v", tc.name, events)
		}
		if e := streamError(t, events); e.Error.Code != tc.code {
			t.Errorf("%s: error = %+v", tc.name, e)
		}
		r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
		if r.Status != 200 || r.Error == nil || r.Error.Code != tc.code {
			t.Errorf("%s: request = %+v", tc.name, r)
		}
	}
}

func TestAnAnthropicStreamIsKeptAliveWithPings(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-oai")
	caller := claudeCaller(t, srv)

	release := make(chan struct{})
	up.Enqueue(up.Stream("Hel", "lo").HoldUntil(release))
	req := messages("m")
	req["stream"] = true
	ch := make(chan *liveStream, 1)
	go func() {
		resp := caller.Open(http.MethodPost, messagesPath, req)
		ch <- &liveStream{t: t, resp: resp, lines: eventLines(resp.Body)}
	}()
	up.Await(1)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s := headers(t, ch)
	s.expect("event: ping")
	s.expect(`data: {"type":"ping"}`)
	close(release)
	events := s.rest()
	if events[len(events)-1].Event != "message_stop" {
		t.Fatalf("events = %+v", events)
	}
	up.Enqueue(testkit.Hang())
	ch = make(chan *liveStream, 1)
	go func() {
		resp := caller.Open(http.MethodPost, messagesPath, req)
		ch <- &liveStream{t: t, resp: resp, lines: eventLines(resp.Body)}
	}()
	up.Await(2)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s = headers(t, ch)
	s.expect("event: ping")
	srv.Clock.Advance(100 * time.Second)
	events = s.rest()
	last := events[len(events)-1]
	if last.Event != "error" || !strings.Contains(last.Data, `"type":"error"`) || !strings.Contains(last.Data, `"code":"upstream_timeout"`) {
		t.Fatalf("events = %+v", events)
	}
}

func TestCapturedAnthropicStreamsAreReassembled(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", up.URL(), "sk-test-a")
	var out struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "cap", "scope": all, "capture": true}).Expect(201).JSON(&out)
	caller := srv.Anon.WithHeader("x-api-key", out.GatewayKey.Secret)

	req := messages("m")
	req["stream"] = true
	resp := caller.Post(messagesPath, req).Expect(200)
	var c requests.CaptureView
	srv.Admin.Get("/api/requests/" + resp.Header.Get("X-Request-Id") + "/capture").Expect(200).JSON(&c)
	var msg struct {
		Type, Model string
		StopReason  string `json:"stop_reason"`
		Content     []struct{ Type, Text string }
		Usage       map[string]any
	}
	if err := json.Unmarshal(c.Response.Body, &msg); err != nil {
		t.Fatalf("capture body = %s", c.Response.Body)
	}
	if msg.Type != "message" || msg.Model != "m" || msg.StopReason != "end_turn" || len(msg.Content) != 1 ||
		msg.Content[0].Text != "Hello from the fake anthropic-messages upstream." || msg.Usage["output_tokens"] != float64(5) || c.Response.Stream == "" {
		t.Fatalf("capture = %s", c.Response.Body)
	}
}
