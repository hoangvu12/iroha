package caching_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/caching"
	"github.com/hoangvu12/iroha/internal/shape"
)

// What a translated request to each kind of Endpoint gets, by its Shape,
// host and the Owner's two settings (prompt caching 03).
func TestPolicyFollowsShapeHostAndSettings(t *testing.T) {
	for _, tc := range []struct {
		name         string
		sh           shape.Shape
		url          string
		markers, key string
		want         caching.Markers
		wantKey      bool
	}{
		{"Anthropic's own API takes the automatic marker", shape.AnthropicMessages, "https://api.anthropic.com/v1", "", "", caching.TopLevel, false},
		{"a relay in front of Claude gets block markers", shape.AnthropicMessages, "https://relay.example/v1", "", "", caching.Blocks, false},
		{"on is the default", shape.AnthropicMessages, "https://relay.example/v1", "on", "", caching.Blocks, false},
		{"Kimi takes only the top-level form", shape.AnthropicMessages, "https://api.moonshot.ai/anthropic", "", "", caching.TopOnly, false},
		{"Kimi Code", shape.AnthropicMessages, "https://api.kimi.com/coding", "", "", caching.TopOnly, false},
		{"DeepSeek ignores markers: none added", shape.AnthropicMessages, "https://api.deepseek.com/anthropic", "", "", caching.Keep, false},
		{"Alibaba honours blocks", shape.AnthropicMessages, "https://dashscope-intl.aliyuncs.com/apps/anthropic", "", "", caching.Blocks, false},
		{"off strips toward Anthropic", shape.AnthropicMessages, "https://api.anthropic.com/v1", "off", "", caching.Strip, false},
		{"OpenRouter honours markers on Chat", shape.OpenAIChat, "https://openrouter.ai/api/v1", "", "", caching.Keep, true},
		{"Qwen honours markers on Chat", shape.OpenAIChat, "https://dashscope.aliyuncs.com/compatible-mode/v1", "", "", caching.Keep, true},
		{"another Chat Endpoint stays as before", shape.OpenAIChat, "https://api.openai.com/v1", "", "", caching.AsBefore, true},
		{"on keeps markers on any Chat Endpoint", shape.OpenAIChat, "https://api.openai.com/v1", "on", "", caching.Keep, true},
		{"off strips on Chat", shape.OpenAIChat, "https://openrouter.ai/api/v1", "off", "", caching.Strip, true},
		{"prompt_cache_key off", shape.OpenAIChat, "https://api.openai.com/v1", "", "off", caching.AsBefore, false},
		{"Responses gets the key", shape.OpenAIResponses, "https://api.openai.com/v1", "", "", caching.AsBefore, true},
		{"Gemini's OpenAI API refuses unknown fields", shape.OpenAIChat, "https://generativelanguage.googleapis.com/v1beta/openai", "", "", caching.AsBefore, false},
		{"Mistral refuses unknown fields", shape.OpenAIChat, "https://api.mistral.ai/v1", "", "", caching.AsBefore, false},
		{"on wins over the host", shape.OpenAIChat, "https://api.mistral.ai/v1", "", "on", caching.AsBefore, true},
		{"Gemini Endpoints get neither", shape.Gemini, "https://generativelanguage.googleapis.com/v1beta", "on", "on", caching.AsBefore, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := caching.For(tc.sh, tc.url, tc.markers, tc.key)
			if p.Markers != tc.want || p.PromptCacheKey != tc.wantKey {
				t.Errorf("For(%s, %s, %q, %q) = %+v, want markers %q, key %v", tc.sh, tc.url, tc.markers, tc.key, p, tc.want, tc.wantKey)
			}
		})
	}
}

// Conversation fields go wherever they can be read: always to Anthropic,
// to OpenAI Endpoints with the prompt_cache_key (a strict one refuses both).
func TestFieldsFollowThePromptCacheKeyOnOpenAIEndpoints(t *testing.T) {
	if !caching.For(shape.AnthropicMessages, "https://x.example", "off", "off").Fields {
		t.Error("Anthropic Endpoints always take metadata.user_id")
	}
	if caching.For(shape.OpenAIChat, "https://api.mistral.ai/v1", "", "").Fields || !caching.For(shape.OpenAIChat, "https://api.openai.com/v1", "", "").Fields {
		t.Error("OpenAI Endpoints follow send_prompt_cache_key")
	}
	if caching.For(shape.Gemini, "https://x.example", "on", "on").Fields {
		t.Error("Gemini has no such fields")
	}
}

func TestSettingValuesAreChecked(t *testing.T) {
	for _, v := range []string{"", "on", "off"} {
		if !caching.ValidSetting(v) {
			t.Errorf("%q refused", v)
		}
	}
	for _, v := range []string{"yes", "On", "auto"} {
		if caching.ValidSetting(v) {
			t.Errorf("%q accepted", v)
		}
	}
}

// The derived prompt_cache_key is a UUID made from the affinity value, the
// same for the same conversation, never longer than OpenAI's 64 characters.
func TestPromptCacheKeyIsAUUIDOfTheAffinityValue(t *testing.T) {
	a := caching.PromptCacheKey("3f2a")
	if len(a) != 36 || a != caching.PromptCacheKey("3f2a") || a == caching.PromptCacheKey("3f2b") {
		t.Errorf("key %q", a)
	}
	if a[14] != '5' {
		t.Errorf("not a version 5 UUID: %s", a)
	}
	if caching.PromptCacheKey("") != "" {
		t.Error("no conversation must give no key")
	}
}
