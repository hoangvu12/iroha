package gateway_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/testkit"
	"github.com/hoangvu12/iroha/internal/usage"
)

// Cache writes are recorded on the Request and on its Attempt, beside the
// reads, with input still counting every prompt token.
func TestCacheWritesAreRecordedOnTheRequestAndItsAttempt(t *testing.T) {
	srv := testkit.Start(t)
	ant := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", ant.URL(), "sk-test-ant")
	ant.Enqueue(testkit.JSON(200, map[string]any{
		"id": "msg_1", "type": "message", "role": "assistant", "model": "claude-x",
		"content":     []any{map[string]any{"type": "text", "text": "hello"}},
		"stop_reason": "end_turn",
		"usage": map[string]any{"input_tokens": 12, "output_tokens": 5, "cache_read_input_tokens": 4000, "cache_creation_input_tokens": 1500,
			"cache_creation": map[string]any{"ephemeral_5m_input_tokens": 500, "ephemeral_1h_input_tokens": 1000}},
	}))
	resp := claudeCaller(t, srv).Post(messagesPath, messages("claude-x")).Expect(200)

	want := usage.Usage{Input: 5512, Output: 5, CacheRead: 4000, CacheWrite: 1500, CacheWriteLong: 1000}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Usage == nil || *r.Usage != want {
		t.Fatalf("request usage = %+v, want %+v", r.Usage, want)
	}
	if len(r.Attempts) != 1 || r.Attempts[0].Usage == nil || *r.Attempts[0].Usage != want {
		t.Fatalf("attempts = %+v", r.Attempts)
	}

	// A streamed Chat answer from Qwen (writes in prompt_tokens_details) and
	// one from DeepSeek (reads in prompt_cache_hit_tokens).
	chat := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "qwen", chat.URL(), "sk-test-qwen")
	caller := srv.Client(issue(t, srv, "zeron-fleet", all))
	chat.Enqueue(testkit.SSE(
		`data: {"id":"c1","object":"chat.completion.chunk","model":"qwen3","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}`+"\n\n",
		`data: {"id":"c1","object":"chat.completion.chunk","model":"qwen3","choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":0,"cache_creation_input_tokens":1800}}}`+"\n\n",
		"data: [DONE]\n\n",
	), testkit.JSON(200, map[string]any{
		"id": "c2", "object": "chat.completion", "model": "deepseek-chat",
		"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "hi"}, "finish_reason": "stop"}},
		"usage":   map[string]any{"prompt_tokens": 500, "completion_tokens": 2, "prompt_cache_hit_tokens": 384, "prompt_cache_miss_tokens": 116},
	}))
	resp = caller.Post("/providers/qwen/v1/chat/completions", map[string]any{"model": "qwen3", "stream": true, "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).Expect(200)
	resp.Events()
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Usage == nil || *r.Usage != (usage.Usage{Input: 2000, Output: 3, CacheWrite: 1800}) {
		t.Fatalf("qwen usage = %+v", r.Usage)
	}
	resp = caller.Post("/providers/qwen/v1/chat/completions", map[string]any{"model": "deepseek-chat", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).Expect(200)
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Usage == nil || *r.Usage != (usage.Usage{Input: 500, Output: 2, CacheRead: 384}) {
		t.Fatalf("deepseek usage = %+v", r.Usage)
	}
}
