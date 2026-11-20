package usage

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/shape"
)

// Iroha's convention: input is every prompt token; cache read and cache
// write are parts of it, whatever way the Provider counted them.
func TestCacheReadsAndWritesAreReadForEveryProviderFamily(t *testing.T) {
	cases := []struct {
		name   string
		sh     shape.Shape
		body   string   // a whole answer
		events []string // or the data of stream events
		want   Usage
	}{
		{
			name: "Anthropic counts reads and writes apart from input_tokens",
			sh:   shape.AnthropicMessages,
			body: `{"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":200,"cache_creation_input_tokens":300,
				"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200}}}`,
			want: Usage{Input: 510, Output: 5, CacheRead: 200, CacheWrite: 300, CacheWriteLong: 200},
		},
		{
			name: "Anthropic stream: cache counts in message_start, output in message_delta",
			sh:   shape.AnthropicMessages,
			events: []string{
				`{"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":300,"cache_creation":{"ephemeral_5m_input_tokens":300,"ephemeral_1h_input_tokens":0}}}}`,
				`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}`,
			},
			want: Usage{Input: 310, Output: 7, CacheWrite: 300},
		},
		{
			name: "OpenAI Chat (GPT-5.6+, Kimi): cache_write_tokens and its lifetime split",
			sh:   shape.OpenAIChat,
			body: `{"usage":{"prompt_tokens":1000,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":600,"cache_write_tokens":300,
				"cache_write_tokens_details":{"ttl_30m_tokens":100,"ttl_12h_tokens":200}}}}`,
			want: Usage{Input: 1000, Output: 20, CacheRead: 600, CacheWrite: 300, CacheWriteLong: 200},
		},
		{
			name: "Qwen: prompt_tokens_details.cache_creation_input_tokens",
			sh:   shape.OpenAIChat,
			body: `{"usage":{"prompt_tokens":2000,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":0,"cache_creation_input_tokens":1800,
				"cache_creation":{"ephemeral_5m_input_tokens":1800},"cache_type":"ephemeral"}}}`,
			want: Usage{Input: 2000, Output: 30, CacheWrite: 1800},
		},
		{
			name: "DeepSeek: prompt_cache_hit_tokens when cached_tokens is absent",
			sh:   shape.OpenAIChat,
			body: `{"usage":{"prompt_tokens":500,"completion_tokens":10,"prompt_cache_hit_tokens":384,"prompt_cache_miss_tokens":116}}`,
			want: Usage{Input: 500, Output: 10, CacheRead: 384},
		},
		{
			name: "Moonshot's older answers: top-level cached_tokens",
			sh:   shape.OpenAIChat,
			body: `{"usage":{"prompt_tokens":300,"completion_tokens":4,"cached_tokens":256}}`,
			want: Usage{Input: 300, Output: 4, CacheRead: 256},
		},
		{
			name: "OpenRouter-style top-level cache_write_tokens",
			sh:   shape.OpenAIChat,
			body: `{"usage":{"prompt_tokens":300,"completion_tokens":4,"cache_write_tokens":120}}`,
			want: Usage{Input: 300, Output: 4, CacheWrite: 120},
		},
		{
			name: "OpenAI Responses: input_tokens_details.cache_write_tokens",
			sh:   shape.OpenAIResponses,
			events: []string{
				`{"type":"response.completed","response":{"usage":{"input_tokens":900,"output_tokens":40,"input_tokens_details":{"cached_tokens":500,"cache_write_tokens":400,
					"cache_write_tokens_details":{"ttl_30m_tokens":0,"ttl_12h_tokens":400}},"output_tokens_details":{"reasoning_tokens":12}}}}`,
			},
			want: Usage{Input: 900, Output: 40, CacheRead: 500, CacheWrite: 400, CacheWriteLong: 400, Reasoning: 12},
		},
		{
			name: "Gemini reports reads only",
			sh:   shape.Gemini,
			body: `{"usageMetadata":{"promptTokenCount":800,"candidatesTokenCount":9,"cachedContentTokenCount":512}}`,
			want: Usage{Input: 800, Output: 9, CacheRead: 512},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := NewReader(c.sh)
			if c.body != "" {
				r.Body([]byte(c.body))
			}
			for _, e := range c.events {
				r.Event([]byte(e))
			}
			if got := r.Usage(); got == nil || *got != c.want {
				t.Fatalf("usage = %+v, want %+v", got, c.want)
			}
		})
	}
}
