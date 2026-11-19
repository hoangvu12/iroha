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

const responsesPath = "/providers/acme/v1/responses"

func responsesReq(model string) map[string]any {
	return map[string]any{"model": model, "input": "hi"}
}

// responsesEvent is the part of a Responses stream event the tests read.
type responsesEvent struct {
	Type     string
	Seq      *int `json:"sequence_number"`
	Delta    string
	Response *struct {
		ID, Model, Status string
		Error             *struct{ Code, Message string }
	}
}

// readResponses decodes a Responses stream, checking every event is named
// by its type, and returns the events and the text of its deltas.
func readResponses(t *testing.T, events []testkit.Event) ([]responsesEvent, string) {
	t.Helper()
	var out []responsesEvent
	var text strings.Builder
	for _, e := range events {
		var ev responsesEvent
		if err := json.Unmarshal([]byte(e.Data), &ev); err != nil || ev.Type != e.Event {
			t.Fatalf("event %q is not a named Responses event: %s", e.Event, e.Data)
		}
		if ev.Type == "response.output_text.delta" {
			text.WriteString(ev.Delta)
		}
		out = append(out, ev)
	}
	return out, text.String()
}

func TestResponsesPassThroughToAResponsesEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIResponses(t)
	addEndpointProvider(t, srv, "acme", "openai-responses", up.URL(), "sk-test-oai")
	caller := srv.Client(issue(t, srv, "codex", all)).WithHeader("Idempotency-Key", "attempt-123")
	up.SetUsage(40, 12)

	// Stored state, tools, structured output and extensions reach the
	// Provider byte for byte.
	body := `{"model":"gpt-5", "input":"Say hello", "store":true, "previous_response_id":"resp_prev",
		"tools":[{"type":"function","name":"weather","parameters":{"type":"object"}}],
		"text":{"format":{"type":"json_schema","name":"answer","schema":{"type":"object"}}}, "provider_extension":{"cache":"ephemeral"}}`
	resp := caller.Post(responsesPath, body).Expect(200)
	got := up.Last()
	if string(got.Body) != body || got.Path != "/v1/responses" || got.Bearer() != "sk-test-oai" || got.Header.Get("Idempotency-Key") != "attempt-123" {
		t.Fatalf("upstream got %s %v\n%s", got.Path, got.Header, got.Body)
	}
	if m := resp.Map(); m["model"] != "gpt-5" || m["object"] != "response" {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "openai-responses" || r.ShapeOut != "openai-responses" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 40, Output: 12}) {
		t.Fatalf("request = %+v usage %+v", r, r.Usage)
	}

	// Streamed: events pass through in order with their names; the response
	// objects name the model asked for; usage from response.completed is
	// recorded.
	srv.Admin.Patch("/api/providers/acme/endpoints/default", map[string]any{"renames": map[string]string{"codex": "gpt-5-codex"}}).OK()
	st := responsesReq("codex")
	st["stream"] = true
	resp = caller.Post(responsesPath, st).Expect(200)
	if up.Last().Model != "gpt-5-codex" {
		t.Fatalf("upstream model = %s", up.Last().Model)
	}
	evs, text := readResponses(t, resp.Events())
	if evs[0].Type != "response.created" || evs[0].Response.Model != "codex" || evs[len(evs)-1].Type != "response.completed" ||
		evs[len(evs)-1].Response.Model != "codex" || text != "Hello from the fake openai-responses upstream." {
		t.Fatalf("events = %+v", evs)
	}
	for i, ev := range evs {
		if ev.Seq == nil || *ev.Seq != i {
			t.Fatalf("event %d has sequence_number %v", i, ev.Seq)
		}
	}
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Usage == nil || *r.Usage != (usage.Usage{Input: 40, Output: 12}) || r.WireModel != "gpt-5-codex" {
		t.Fatalf("stream request = %+v usage %+v", r, r.Usage)
	}

	// Cached input and reasoning tokens are recorded too.
	up.Enqueue(testkit.JSON(200, map[string]any{"id": "resp_9", "object": "response", "status": "completed", "model": "gpt-5", "output": []any{},
		"usage": map[string]any{"input_tokens": 100, "input_tokens_details": map[string]any{"cached_tokens": 60},
			"output_tokens": 30, "output_tokens_details": map[string]any{"reasoning_tokens": 20}, "total_tokens": 130}}))
	resp = caller.Post(responsesPath, responsesReq("gpt-5")).Expect(200)
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Usage == nil || *r.Usage != (usage.Usage{Input: 100, Output: 30, CacheRead: 60, Reasoning: 20}) {
		t.Fatalf("usage = %+v", r.Usage)
	}
}

func TestResponsesAreTranslatedForAChatEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-oai")
	caller := srv.Client(issue(t, srv, "codex", all))
	up.SetUsage(30, 7)

	// A tool call comes back under the Caller's own tool name.
	up.Enqueue(testkit.JSON(200, map[string]any{
		"id": "chatcmpl-1", "object": "chat.completion", "created": 1767225600, "model": "deepseek-chat",
		"choices": []any{map[string]any{"index": 0, "finish_reason": "tool_calls", "message": map[string]any{"role": "assistant", "content": "Listing.",
			"tool_calls": []any{map[string]any{"id": "call_1", "type": "function", "function": map[string]any{"name": "shell_exec", "arguments": `{"cmd":"ls"}`}}}}}},
		"usage": map[string]any{"prompt_tokens": 30, "completion_tokens": 7, "total_tokens": 37},
	}))
	req := map[string]any{"model": "deepseek-chat", "instructions": "Be terse.", "store": false, "max_output_tokens": 500,
		"input": []any{map[string]any{"role": "user", "content": "List files."}},
		"tools": []any{map[string]any{"type": "function", "name": "shell.exec", "parameters": map[string]any{"type": "object"}}}}
	resp := caller.Post(responsesPath, req).Expect(200)

	got := up.Last()
	sent := got.Map(t)
	msgs, _ := sent["messages"].([]any)
	tools, _ := sent["tools"].([]any)
	if got.Path != "/v1/chat/completions" || got.Bearer() != "sk-test-oai" || len(msgs) != 2 || sent["store"] != nil ||
		len(tools) != 1 || tools[0].(map[string]any)["function"].(map[string]any)["name"] != "shell_exec" {
		t.Fatalf("upstream got %s\n%s", got.Path, got.Body)
	}
	id := resp.Header.Get("X-Request-Id")
	var ans struct {
		ID, Object, Model, Status string
		Output                    []struct {
			Type, Name, Arguments string
			Content               []struct{ Type, Text string }
		}
		Usage map[string]any
	}
	resp.JSON(&ans)
	if ans.ID != "resp_"+id || ans.Object != "response" || ans.Model != "deepseek-chat" || ans.Status != "completed" || len(ans.Output) != 2 ||
		ans.Output[0].Content[0].Text != "Listing." || ans.Output[1].Type != "function_call" || ans.Output[1].Name != "shell.exec" ||
		ans.Usage["input_tokens"] != float64(30) || ans.Usage["output_tokens"] != float64(7) {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, id)
	if r.ShapeIn != "openai-responses" || r.ShapeOut != "openai-chat" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 30, Output: 7}) {
		t.Fatalf("request = %+v", r)
	}

	// Streamed: Chat chunks become Responses events, usage included (Iroha
	// asked the Provider for it).
	req["stream"] = true
	resp = caller.Post(responsesPath, req).Expect(200)
	if opts, _ := up.Last().Map(t)["stream_options"].(map[string]any); opts["include_usage"] != true {
		t.Fatalf("upstream stream request = %s", up.Last().Body)
	}
	id = resp.Header.Get("X-Request-Id")
	evs, text := readResponses(t, resp.Events())
	last := evs[len(evs)-1]
	if evs[0].Type != "response.created" || evs[0].Response.ID != "resp_"+id || last.Type != "response.completed" ||
		last.Response.Model != "deepseek-chat" || text != "Hello from the fake openai-chat upstream." {
		t.Fatalf("events = %+v", evs)
	}
	if !strings.Contains(resp.Text(), `"usage":{"input_tokens":30,"input_tokens_details":{"cached_tokens":0},"output_tokens":7`) {
		t.Fatalf("stream = %s", resp.Body)
	}
	r = readRequest(t, srv, id)
	if r.ShapeOut != "openai-chat" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 30, Output: 7}) || r.Error != nil {
		t.Fatalf("stream request = %+v", r)
	}
}

func TestResponsesAreTranslatedForAnAnthropicEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", up.URL(), "sk-test-ant")
	caller := srv.Client(issue(t, srv, "codex", all))

	req := responsesReq("claude-sonnet-4-5")
	req["reasoning"] = map[string]any{"effort": "medium"}
	resp := caller.Post(responsesPath, req).Expect(200)
	got := up.Last()
	sent := got.Map(t)
	if got.Path != "/v1/messages" || got.Header.Get("X-Api-Key") != "sk-test-ant" || got.Header.Get("Anthropic-Version") != "2023-06-01" ||
		sent["thinking"] == nil || sent["max_tokens"] == nil {
		t.Fatalf("upstream got %s %v\n%s", got.Path, got.Header, got.Body)
	}
	if m := resp.Map(); m["object"] != "response" || m["model"] != "claude-sonnet-4-5" || !strings.Contains(resp.Text(), "Hello from the fake anthropic-messages upstream.") {
		t.Fatalf("answer = %s", resp.Body)
	}

	req["stream"] = true
	resp = caller.Post(responsesPath, req).Expect(200)
	evs, text := readResponses(t, resp.Events())
	if evs[0].Type != "response.created" || evs[len(evs)-1].Type != "response.completed" || text != "Hello from the fake anthropic-messages upstream." {
		t.Fatalf("events = %+v", evs)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "openai-responses" || r.ShapeOut != "anthropic-messages" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) {
		t.Fatalf("request = %+v usage %+v", r, r.Usage)
	}
}

func TestChatAndMessagesAreTranslatedForAResponsesEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIResponses(t)
	addEndpointProvider(t, srv, "acme", "openai-responses", up.URL(), "sk-test-oai")
	caller := srv.Client(issue(t, srv, "pi", all))
	up.SetUsage(21, 4)

	// Chat, whole and streamed with include_usage.
	resp := caller.Post(chatPath, chat("gpt-5")).Expect(200)
	got := up.Last()
	sent := got.Map(t)
	if got.Path != "/v1/responses" || got.Bearer() != "sk-test-oai" || sent["store"] != false || sent["input"] == nil {
		t.Fatalf("upstream got %s\n%s", got.Path, got.Body)
	}
	var ans struct {
		Object, Model string
		Choices       []struct {
			Message      struct{ Content string }
			FinishReason string `json:"finish_reason"`
		}
		Usage map[string]any
	}
	resp.JSON(&ans)
	if ans.Object != "chat.completion" || ans.Model != "gpt-5" || len(ans.Choices) != 1 || ans.Choices[0].Message.Content != "Hello from the fake openai-responses upstream." ||
		ans.Choices[0].FinishReason != "stop" || ans.Usage["prompt_tokens"] != float64(21) {
		t.Fatalf("answer = %s", resp.Body)
	}
	req := chat("gpt-5")
	req["stream"] = true
	req["stream_options"] = map[string]any{"include_usage": true}
	resp = caller.Post(chatPath, req).Expect(200)
	if _, ok := up.Last().Map(t)["stream_options"]; ok {
		t.Fatalf("Responses has no stream_options.include_usage: %s", up.Last().Body)
	}
	events := resp.Events()
	if text(t, events) != "Hello from the fake openai-responses upstream." || events[len(events)-1].Data != "[DONE]" ||
		!strings.Contains(events[len(events)-2].Data, `"prompt_tokens":21`) {
		t.Fatalf("events = %+v", events)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "openai-chat" || r.ShapeOut != "openai-responses" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 21, Output: 4}) {
		t.Fatalf("request = %+v usage %+v", r, r.Usage)
	}

	// Anthropic Messages, streamed.
	st := messages("gpt-5")
	st["stream"] = true
	resp = claudeCaller(t, srv).Post(messagesPath, st).Expect(200)
	events = resp.Events()
	if events[0].Event != "message_start" || events[len(events)-1].Event != "message_stop" ||
		!strings.Contains(events[len(events)-2].Data, `"output_tokens":4`) {
		t.Fatalf("events = %+v", events)
	}
	if up.Last().Header.Get("Anthropic-Version") != "" {
		t.Fatalf("Anthropic headers reached a Responses Endpoint: %v", up.Last().Header)
	}
}

func TestStatefulResponsesCannotBeTranslated(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-oai")
	caller := srv.Client(issue(t, srv, "codex", all))

	var e callerError
	req := responsesReq("m")
	req["previous_response_id"] = "resp_prev"
	resp := caller.Post(responsesPath, req).Expect(400)
	resp.JSON(&e)
	if e.Error.Code != "untranslatable_request" || !strings.Contains(e.Error.Message, "previous_response_id") || up.Count() != 0 {
		t.Fatalf("error = %s (upstream calls %d)", resp.Body, up.Count())
	}
	resp = caller.Post(responsesPath, `{"input":"hi"}`).Expect(400)
	if !strings.Contains(resp.Text(), `"code":"model_required"`) || !strings.Contains(resp.Text(), "OpenAI Responses") {
		t.Fatalf("error = %s", resp.Body)
	}
	caller.Post("/providers/nope/v1/responses", responsesReq("m")).Expect(403)
}

func TestATranslatedResponsesStreamThatFailsEndsWithTheCallersErrorEvent(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIResponses(t)
	addEndpointProvider(t, srv, "acme", "openai-responses", up.URL(), "sk-test-oai")
	caller := srv.Client(issue(t, srv, "pi", all))
	ev := func(data string) string {
		var v struct{ Type string }
		_ = json.Unmarshal([]byte(data), &v)
		return "event: " + v.Type + "\ndata: " + data + "\n\n"
	}
	created := ev(`{"type":"response.created","sequence_number":0,"response":{"id":"resp_1","object":"response","status":"in_progress","model":"m","output":[]}}`)
	added := ev(`{"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}`)
	delta := ev(`{"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hel"}`)
	cases := []struct {
		name  string
		reply testkit.Responder
		code  string
	}{
		{"response.failed", testkit.SSE(created, added, delta,
			ev(`{"type":"response.failed","sequence_number":3,"response":{"id":"resp_1","status":"failed","error":{"code":"server_error","message":"The model failed."}}}`)), "upstream_stream_error"},
		{"an error event", testkit.SSE(created, added, delta, ev(`{"type":"error","sequence_number":3,"code":"rate_limit_exceeded","message":"Slow down."}`)), "upstream_stream_error"},
		{"the stream ends before the answer did", testkit.SSE(created, added, delta), "upstream_stream_broken"},
	}
	for _, tc := range cases {
		up.Enqueue(tc.reply)
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
	}
}

func TestAResponsesStreamIsKeptAliveAndFailsWithErrorEvents(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-oai")
	caller := srv.Client(issue(t, srv, "codex", all))

	release := make(chan struct{})
	up.Enqueue(up.Stream("Hel", "lo").HoldUntil(release))
	req := responsesReq("m")
	req["stream"] = true
	ch := make(chan *liveStream, 1)
	go func() {
		resp := caller.Open(http.MethodPost, responsesPath, req)
		ch <- &liveStream{t: t, resp: resp, lines: eventLines(resp.Body)}
	}()
	up.Await(1)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s := headers(t, ch)
	s.expect(": keep-alive")
	close(release)
	evs, text := readResponses(t, s.rest())
	if evs[len(evs)-1].Type != "response.completed" || text != "Hello" {
		t.Fatalf("events = %+v", evs)
	}

	// A committed stream that then fails ends with the error event (whose
	// top-level error the OpenAI SDKs raise) and response.failed.
	up.Enqueue(testkit.Hang())
	ch = make(chan *liveStream, 1)
	go func() {
		resp := caller.Open(http.MethodPost, responsesPath, req)
		ch <- &liveStream{t: t, resp: resp, lines: eventLines(resp.Body)}
	}()
	up.Await(2)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s = headers(t, ch)
	s.expect(": keep-alive")
	srv.Clock.Advance(100 * time.Second)
	events := s.rest()
	if len(events) != 2 || events[0].Event != "error" || events[1].Event != "response.failed" {
		t.Fatalf("events = %+v", events)
	}
	var e struct {
		Type, Code string
		Error      struct{ Code, Hint string }
	}
	if json.Unmarshal([]byte(events[0].Data), &e) != nil || e.Type != "error" || e.Code != "upstream_timeout" || e.Error.Code != "upstream_timeout" || e.Error.Hint == "" {
		t.Fatalf("error event = %s", events[0].Data)
	}
	evs, _ = readResponses(t, events)
	if f := evs[1].Response; f == nil || f.Status != "failed" || f.Error == nil || f.Error.Code != "upstream_timeout" || !strings.HasPrefix(f.ID, "resp_req_") {
		t.Fatalf("response.failed = %s", events[1].Data)
	}
}

func TestCapturedResponsesStreamsAreReassembled(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIResponses(t)
	addEndpointProvider(t, srv, "acme", "openai-responses", up.URL(), "sk-test-oai")
	var out struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "cap", "scope": all, "capture": true}).Expect(201).JSON(&out)
	caller := srv.Client(out.GatewayKey.Secret)

	req := responsesReq("m")
	req["stream"] = true
	resp := caller.Post(responsesPath, req).Expect(200)
	var c requests.CaptureView
	srv.Admin.Get("/api/requests/" + resp.Header.Get("X-Request-Id") + "/capture").Expect(200).JSON(&c)
	var r struct {
		Object, Model, Status string
		Output                []struct {
			Type    string
			Content []struct{ Text string }
		}
		Usage map[string]any
	}
	if err := json.Unmarshal(c.Response.Body, &r); err != nil {
		t.Fatalf("capture body = %s", c.Response.Body)
	}
	if r.Object != "response" || r.Model != "m" || r.Status != "completed" || len(r.Output) != 1 ||
		r.Output[0].Content[0].Text != "Hello from the fake openai-responses upstream." || r.Usage["output_tokens"] != float64(5) || c.Response.Stream == "" {
		t.Fatalf("capture = %s", c.Response.Body)
	}
}
