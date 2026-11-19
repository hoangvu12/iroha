package gateway_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// Normalisers end to end (ticket 16): the Endpoint's answer is normalised
// before it is passed through or translated, whole or streamed. Bodies are
// the ones v1 recorded (see internal/normalise/normalise_test.go).

// minimaxThink is a MiniMax M2 answer with its reasoning inline and its
// vendor fields.
const minimaxThink = `{"id":"chatcmpl-1","object":"chat.completion","model":"MiniMax-M2","choices":[{"index":0,"message":{"role":"assistant","content":"<think>\nThe user said hi.\n</think>\n\nHello there!","name":"MiniMax AI","audio_content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}`

// minimaxThinkStream is the same answer streamed, the tags split across writes.
var minimaxThinkStream = []string{
	`data: {"id":"c","object":"chat.completion.chunk","model":"MiniMax-M2","choices":[{"index":0,"delta":{"role":"assistant","content":"<th","name":"MiniMax AI","audio_content":""}}]}` + "\n\n",
	`data: {"id":"c","object":"chat.completion.chunk","model":"MiniMax-M2","choices":[{"index":0,"delta":{"content":"ink>\nThe user said hi.\n</thi"}}]}` + "\n\n",
	`data: {"id":"c","object":"chat.completion.chunk","model":"MiniMax-M2","choices":[{"index":0,"delta":{"content":"nk>\n\nHello there!"}}]}` + "\n\n",
	`data: {"id":"c","object":"chat.completion.chunk","model":"MiniMax-M2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}` + "\n\n",
	"data: [DONE]\n\n",
}

// glmBlocks is a GLM answer whose content is an array of blocks.
const glmBlocks = `{"id":"chatcmpl-glm","object":"chat.completion","model":"glm-4.6","choices":[{"index":0,"message":{"role":"assistant","content":[{"type":"thinking","thinking":[{"type":"text","text":"Greet back."}]},{"type":"text","text":"Hello!"}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`

type chatAnswer struct {
	Model   string
	Choices []struct {
		Message map[string]any
	}
}

// chatStream reads a Chat stream: the text and reasoning it carried, and
// whether every delta was free of vendor fields.
func chatStream(t *testing.T, events []testkit.Event) (text, reasoning string, finish []string) {
	t.Helper()
	for _, e := range events {
		if e.Data == "[DONE]" {
			continue
		}
		var c struct {
			Choices []struct {
				Delta        map[string]any
				FinishReason string `json:"finish_reason"`
			}
		}
		if err := json.Unmarshal([]byte(e.Data), &c); err != nil {
			t.Fatalf("chunk is not JSON: %s", e.Data)
		}
		for _, ch := range c.Choices {
			if _, ok := ch.Delta["name"]; ok {
				t.Fatalf("a delta kept name: %s", e.Data)
			}
			if _, ok := ch.Delta["audio_content"]; ok {
				t.Fatalf("a delta kept audio_content: %s", e.Data)
			}
			s, _ := ch.Delta["content"].(string)
			text += s
			r, _ := ch.Delta["reasoning_content"].(string)
			reasoning += r
			if ch.FinishReason != "" {
				finish = append(finish, ch.FinishReason)
			}
		}
	}
	return text, reasoning, finish
}

// anthropicAnswer reads an Anthropic message's thinking and text.
func anthropicAnswer(t *testing.T, body []byte) (thinking, text string) {
	t.Helper()
	var m struct {
		Content []struct{ Type, Text, Thinking string }
	}
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("answer: %s", body)
	}
	for _, b := range m.Content {
		switch b.Type {
		case "thinking":
			thinking += b.Thinking
		case "text":
			text += b.Text
		}
	}
	return thinking, text
}

// anthropicStream reads the thinking and text an Anthropic stream carried.
func anthropicStream(t *testing.T, events []testkit.Event) (thinking, text string, names []string) {
	t.Helper()
	for _, e := range events {
		names = append(names, e.Event)
		var d struct {
			Delta struct{ Type, Text, Thinking string }
		}
		if json.Unmarshal([]byte(e.Data), &d) == nil {
			thinking += d.Delta.Thinking
			text += d.Delta.Text
		}
	}
	return thinking, text, names
}

func TestThinkTextMovesIntoReasoningOnEveryPath(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "opencode", all))
	claude := claudeCaller(t, srv)

	// Chat Caller, whole answer (REQ-85, REQ-23).
	up.Enqueue(testkit.Raw(200, "application/json", minimaxThink))
	var a chatAnswer
	caller.Post(chatPath, chat("minimax-m2")).Expect(200).JSON(&a)
	msg := a.Choices[0].Message
	if a.Model != "minimax-m2" || msg["content"] != "Hello there!" || msg["reasoning_content"] != "\nThe user said hi.\n" || msg["name"] != nil || msg["audio_content"] != nil {
		t.Fatalf("answer = %+v", a)
	}

	// Chat Caller, streamed with the tags split across writes (REQ-86).
	up.Enqueue(testkit.SSE(minimaxThinkStream...))
	st := chat("minimax-m2")
	st["stream"] = true
	resp := caller.Post(chatPath, st).Expect(200)
	text, reasoning, finish := chatStream(t, resp.Events())
	if text != "Hello there!" || reasoning != "\nThe user said hi.\n" || len(finish) != 1 || !strings.HasSuffix(resp.Text(), "data: [DONE]\n\n") {
		t.Fatalf("text %q reasoning %q finish %v\n%s", text, reasoning, finish, resp.Text())
	}

	// Anthropic Caller (translated): the reasoning is a thinking block, not
	// text (REQ-37, REQ-61).
	up.Enqueue(testkit.Raw(200, "application/json", minimaxThink))
	resp = claude.Post(messagesPath, messages("minimax-m2")).Expect(200)
	if thinking, text := anthropicAnswer(t, resp.Body); thinking != "\nThe user said hi.\n" || text != "Hello there!" {
		t.Fatalf("thinking %q text %q\n%s", thinking, text, resp.Body)
	}
	up.Enqueue(testkit.SSE(minimaxThinkStream...))
	sm := messages("minimax-m2")
	sm["stream"] = true
	resp = claude.Post(messagesPath, sm).Expect(200)
	thinking, text, names := anthropicStream(t, resp.Events())
	if thinking != "\nThe user said hi.\n" || text != "Hello there!" || names[len(names)-1] != "message_stop" {
		t.Fatalf("thinking %q text %q events %v\n%s", thinking, text, names, resp.Text())
	}
}

func TestGLMContentBlocksAreFlattened(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	// REQ-24: a Chat Caller gets string content plus reasoning_content.
	up.Enqueue(testkit.Raw(200, "application/json", glmBlocks))
	var a chatAnswer
	caller.Post(chatPath, chat("glm-4.6")).Expect(200).JSON(&a)
	if msg := a.Choices[0].Message; msg["content"] != "Hello!" || msg["reasoning_content"] != "Greet back." {
		t.Fatalf("answer = %+v", a)
	}

	// REQ-61: translated for Claude Code the message is not empty.
	up.Enqueue(testkit.Raw(200, "application/json", glmBlocks))
	resp := claudeCaller(t, srv).Post(messagesPath, messages("glm-4.6")).Expect(200)
	if thinking, text := anthropicAnswer(t, resp.Body); thinking != "Greet back." || text != "Hello!" {
		t.Fatalf("thinking %q text %q\n%s", thinking, text, resp.Body)
	}
}

func TestPassthroughStaysByteForByteWhenNoNormaliserActs(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	body := `{"id": "chatcmpl-9",  "model":"gpt-x", "choices":[{"index":0,"message":{"role":"assistant","content":"plain <b>reply</b>","reasoning_content":"r"},"finish_reason":"stop"}], "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}, "x_extra":1.50}`
	up.Enqueue(testkit.Raw(200, "application/json", body))
	if got := caller.Post(chatPath, chat("gpt-x")).Expect(200).Text(); got != body {
		t.Fatalf("answer changed:\n%s", got)
	}
}

func TestStreamsEndingWithoutAFinishReasonAreClosed(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))
	st := chat("qwen3")
	st["stream"] = true
	noFinish := []string{
		`data: {"id":"c","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}` + "\n\n",
		`data: {"id":"c","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"content":"lo"}}]}` + "\n\n",
	}

	// [DONE] but no finish_reason: a closing chunk goes before [DONE].
	up.Enqueue(testkit.SSE(append(noFinish, "data: [DONE]\n\n")...))
	resp := caller.Post(chatPath, st).Expect(200)
	if text, _, finish := chatStream(t, resp.Events()); text != "Hello" || len(finish) != 1 || finish[0] != "stop" || !strings.HasSuffix(resp.Text(), "data: [DONE]\n\n") {
		t.Fatalf("stream:\n%s", resp.Text())
	}

	// The body ends cleanly with neither: the stream is closed with both.
	up.Enqueue(testkit.SSE(noFinish...))
	resp = caller.Post(chatPath, st).Expect(200)
	if text, _, finish := chatStream(t, resp.Events()); text != "Hello" || len(finish) != 1 || !strings.HasSuffix(resp.Text(), "data: [DONE]\n\n") {
		t.Fatalf("stream:\n%s", resp.Text())
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Error != nil || r.Status != 200 {
		t.Fatalf("request = %+v", r)
	}

	// Translated for an Anthropic Caller it ends like any answer.
	up.Enqueue(testkit.SSE(noFinish...))
	sm := messages("qwen3")
	sm["stream"] = true
	resp = claudeCaller(t, srv).Post(messagesPath, sm).Expect(200)
	if _, text, names := anthropicStream(t, resp.Events()); text != "Hello" || names[len(names)-1] != "message_stop" || strings.Contains(resp.Text(), "event: error") {
		t.Fatalf("events %v\n%s", names, resp.Text())
	}

	// A stream that breaks off is still reported as broken.
	up.Enqueue(testkit.SSE(noFinish...).ThenDisconnect())
	resp = caller.Post(chatPath, st).Expect(200)
	if !strings.Contains(resp.Text(), "upstream_stream_broken") || strings.Contains(resp.Text(), "[DONE]") {
		t.Fatalf("broken stream:\n%s", resp.Text())
	}
}

func TestReplayedMessageIDsNeverReachAChatEndpoint(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addProvider(t, srv, "mistral", up.URLAt("api.mistral.ai"), "sk-test-one")

	// REQ-53, recorded from v1's inference-anthropic-v1-messages test: Claude
	// Code replays the assistant turn with the id Anthropic gave it.
	turns := []any{
		map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "Hello"}}},
		map[string]any{"id": "msg_01ReplayedAssistantTurn", "role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Hi"}}},
		map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "Again"}}},
	}
	req := messages("mistral-large-latest")
	req["messages"] = turns
	claudeCaller(t, srv).Post("/providers/mistral/v1/messages", req).Expect(200)
	if b := string(up.Last().Body); strings.Contains(b, "msg_01Replayed") || !strings.Contains(b, `"Again"`) {
		t.Fatalf("upstream got %s", b)
	}

	// A Chat Caller that replays such a turn on passthrough: the id is
	// dropped, everything else kept.
	body := `{"model":"mistral-large-latest","messages":[{"role":"user","content":"Hello"},{"id":"msg_01ReplayedAssistantTurn","role":"assistant","content":"Hi"},{"role":"user","content":"Again"}],"safe_prompt":true}`
	srv.Client(issue(t, srv, "pi", all)).Post("/providers/mistral/v1/chat/completions", body).Expect(200)
	got := up.Last().Map(t)
	msgs, _ := got["messages"].([]any)
	if strings.Contains(string(up.Last().Body), "msg_01Replayed") || len(msgs) != 3 || got["safe_prompt"] != true {
		t.Fatalf("upstream got %s", up.Last().Body)
	}
}

func TestZaiFinishReasons(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addProvider(t, srv, "acme", up.URLAt("api.z.ai"), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))
	answer := func(finish string) string {
		return `{"id":"c","object":"chat.completion","model":"glm-4.6","choices":[{"index":0,"message":{"role":"assistant","content":"partial"},"finish_reason":"` + finish + `"}]}`
	}

	// FAIL-22: Z.ai's own reasons read as OpenAI's.
	up.Enqueue(testkit.Raw(200, "application/json", answer("sensitive")))
	if b := caller.Post(chatPath, chat("glm-4.6")).Expect(200).Text(); !strings.Contains(b, `"finish_reason":"content_filter"`) {
		t.Fatalf("answer = %s", b)
	}

	// network_error in a whole answer is a failed Attempt: the next key serves.
	up.Enqueue(testkit.Raw(200, "application/json", answer("network_error")), up.Text("hello"))
	resp := caller.Post(chatPath, chat("glm-4.6")).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Status != 200 || !strings.Contains(r.Attempts[0].FailureBody, "network_error") || r.Attempts[0].Outcome != "retry_elsewhere" {
		t.Fatalf("attempts = %+v", r.Attempts)
	}

	// In a stream that has begun it ends the stream with an error event.
	up.Enqueue(testkit.SSE(
		`data: {"id":"c","choices":[{"index":0,"delta":{"role":"assistant","content":"part"}}]}`+"\n\n",
		`data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"network_error"}]}`+"\n\n",
		"data: [DONE]\n\n"))
	st := chat("glm-4.6")
	st["stream"] = true
	resp = caller.Post(chatPath, st).Expect(200)
	if b := resp.Text(); !strings.Contains(b, "upstream_stream_error") || strings.Contains(b, "[DONE]") || strings.Contains(b, `"finish_reason"`) {
		t.Fatalf("stream:\n%s", b)
	}
}

func TestProviderSummaryListsTheNormalisersThatApply(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addProvider(t, srv, "zai", up.URLAt("api.z.ai")+"/api/coding/paas/v4")
	srv.Admin.Post("/api/providers/zai/endpoints", map[string]any{"name": "anthropic", "url": "https://api.z.ai/api/anthropic/v1", "shape": "anthropic-messages"}).Expect(201)

	var s providers.ProviderSummary
	srv.Admin.Get("/api/providers/zai/summary").Expect(200).JSON(&s)
	got := map[string][]string{}
	for _, n := range s.Normalisers {
		got[n.Name] = n.Endpoints
		if n.Description == "" || n.Side == "" || n.Shape != "openai-chat" {
			t.Fatalf("normaliser = %+v", n)
		}
	}
	for _, name := range []string{"chat-reasoning-tags", "chat-content-blocks", "chat-vendor-fields", "chat-finish-reason", "chat-replayed-fields", "zai-finish-reasons"} {
		if eps := got[name]; len(eps) != 1 || eps[0] != "default" {
			t.Fatalf("%s on %v; summary %+v", name, eps, s.Normalisers)
		}
	}

	addProvider(t, srv, "plain", up.URLAt("api.example.com"))
	srv.Admin.Get("/api/providers/plain/summary").Expect(200).JSON(&s)
	for _, n := range s.Normalisers {
		if n.Name == "zai-finish-reasons" {
			t.Fatalf("a Z.ai normaliser on another host: %+v", s.Normalisers)
		}
	}
}
