package caching_test

import (
	"strings"
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
		{"an explicit on wins over Kimi's default", shape.AnthropicMessages, "https://api.moonshot.ai/anthropic", "on", "", caching.Blocks, false},
		{"an explicit on wins over DeepSeek's default", shape.AnthropicMessages, "https://api.deepseek.com/anthropic", "on", "", caching.Blocks, false},
		{"an explicit on on Anthropic's own API", shape.AnthropicMessages, "https://api.anthropic.com/v1", "on", "", caching.Blocks, false},
		{"Gemini Endpoints get neither", shape.Gemini, "https://generativelanguage.googleapis.com/v1beta", "on", "on", caching.AsBefore, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := caching.For(tc.sh, tc.url, caching.Settings{CacheMarkers: tc.markers, SendPromptCacheKey: tc.key})
			if p.Markers != tc.want || p.PromptCacheKey != tc.wantKey {
				t.Errorf("For(%s, %s, %q, %q) = %+v, want markers %q, key %v", tc.sh, tc.url, tc.markers, tc.key, p, tc.want, tc.wantKey)
			}
		})
	}
}

// When the Owner's on overrides what a host is known to do with markers,
// the summary says so instead of the setting being silently ignored.
func TestTheSummaryWarnsWhenOnGoesAgainstTheHost(t *testing.T) {
	kimi := caching.For(shape.AnthropicMessages, "https://api.moonshot.ai/anthropic", caching.Settings{CacheMarkers: "on"})
	if s := kimi.Describe(shape.AnthropicMessages); !strings.Contains(s, "refuses") || !strings.Contains(s, "top-level") {
		t.Errorf("Kimi with on: %s", s)
	}
	deepseek := caching.For(shape.AnthropicMessages, "https://api.deepseek.com/anthropic", caching.Settings{CacheMarkers: "on"})
	if s := deepseek.Describe(shape.AnthropicMessages); !strings.Contains(s, "ignores") {
		t.Errorf("DeepSeek with on: %s", s)
	}
	for _, url := range []string{"https://api.moonshot.ai/anthropic", "https://relay.example/v1"} {
		if s := caching.For(shape.AnthropicMessages, url, caching.Settings{}).Describe(shape.AnthropicMessages); strings.Contains(s, "refuses") {
			t.Errorf("%s by default: %s", url, s)
		}
	}
}

// Conversation fields go wherever they can be read: always to Anthropic,
// to OpenAI Endpoints with the prompt_cache_key (a strict one refuses both).
func TestFieldsFollowThePromptCacheKeyOnOpenAIEndpoints(t *testing.T) {
	if !caching.For(shape.AnthropicMessages, "https://x.example", caching.Settings{CacheMarkers: "off", SendPromptCacheKey: "off"}).Fields {
		t.Error("Anthropic Endpoints always take metadata.user_id")
	}
	if caching.For(shape.OpenAIChat, "https://api.mistral.ai/v1", caching.Settings{}).Fields || !caching.For(shape.OpenAIChat, "https://api.openai.com/v1", caching.Settings{}).Fields {
		t.Error("OpenAI Endpoints follow send_prompt_cache_key")
	}
	if caching.For(shape.Gemini, "https://x.example", caching.Settings{CacheMarkers: "on", SendPromptCacheKey: "on"}).Fields {
		t.Error("Gemini has no such fields")
	}
}

// A patch sets only the settings it carries, trimmed and lowercased, and
// names the setting it refuses.
func TestSettingsApplyAPatch(t *testing.T) {
	on, off, bad := " ON ", "off", "sometimes"
	s := caching.Settings{CacheMarkers: "off"}
	if err := s.Apply(caching.SettingsPatch{SendPromptCacheKey: &on}); err != nil || s != (caching.Settings{CacheMarkers: "off", SendPromptCacheKey: "on"}) {
		t.Fatalf("%+v, %v", s, err)
	}
	err := s.Apply(caching.SettingsPatch{CacheMarkers: &bad, SendPromptCacheKey: &off})
	if err == nil || !strings.Contains(err.Error(), "cache_markers") || !strings.Contains(err.Error(), "sometimes") {
		t.Fatalf("error %v", err)
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

// A refusal of a field Iroha added is told from any other 400 by what the
// Providers really answer when a field is unknown, with the field named as
// a parameter: the role error naming 'user' and a Provider echoing the
// request body are not refusals.
func TestRefusedFindsTheAddedFieldAnEndpointRefuses(t *testing.T) {
	added := []string{"cache_control", "metadata", "user", "prompt_cache_key"}
	for _, tc := range []struct{ name, body, want string }{
		{"OpenAI-compatible", `{"error":{"message":"Unrecognized request argument supplied: prompt_cache_key","type":"invalid_request_error"}}`, "prompt_cache_key"},
		{"OpenAI-compatible, several", `{"error":{"message":"Unrecognized request arguments supplied: foo, user"}}`, "user"},
		{"OpenAI unknown parameter", `{"error":{"message":"Unknown parameter: 'user'.","type":"invalid_request_error","param":"user","code":"unknown_parameter"}}`, "user"},
		{"unsupported parameter", `{"error":{"message":"Unsupported parameter: 'prompt_cache_key' is not supported with this model."}}`, "prompt_cache_key"},
		{"Go strict decoder", `{"error":"json: unknown field \"prompt_cache_key\""}`, "prompt_cache_key"},
		{"Google", `[{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \"user\": Cannot find field.","status":"INVALID_ARGUMENT"}}]`, "user"},
		{"FastAPI 422", `{"detail":[{"type":"extra_forbidden","loc":["body","prompt_cache_key"],"msg":"Extra inputs are not permitted","input":"0b1c"}]}`, "prompt_cache_key"},
		{"vLLM, pydantic in a message", `{"object":"error","message":"[{'type': 'extra_forbidden', 'loc': ('body', 'user'), 'msg': 'Extra inputs are not permitted', 'input': 'u-1'}]","type":"BadRequestError","code":400}`, "user"},
		{"Mistral", `{"object":"error","message":{"detail":[{"type":"extra_forbidden","loc":["body","metadata"],"msg":"Extra inputs are not permitted","input":{"user_id":"u"}}]},"type":"invalid_request_message_error"}`, "metadata"},
		{"Anthropic, a block's marker", `{"type":"error","error":{"type":"invalid_request_error","message":"system.0.cache_control: Extra inputs are not permitted"}}`, "cache_control"},
		{"Anthropic, metadata", `{"type":"error","error":{"type":"invalid_request_error","message":"metadata.user_id: Extra inputs are not permitted"}}`, "metadata"},
		{"a role error naming user", `{"error":{"message":"Invalid value: 'tool'. Supported values are: 'system', 'assistant', 'user'.","param":"messages[1].role"}}`, ""},
		{"Anthropic role error", `{"type":"error","error":{"type":"invalid_request_error","message":"messages: roles must alternate between \"user\" and \"assistant\""}}`, ""},
		{"a body echo", `{"error":{"message":"Invalid model gpt-x","request":{"model":"gpt-x","user":"u-1","prompt_cache_key":"0b1c","metadata":{"user_id":"u"}}}}`, ""},
		{"an echo beside another unknown field", `{"error":{"message":"Unrecognized request argument supplied: foo","request":{"prompt_cache_key":"0b1c"}}}`, ""},
		{"a pydantic error on another field", `{"detail":[{"type":"extra_forbidden","loc":["body","foo"],"msg":"Extra inputs are not permitted","input":{"prompt_cache_key":"0b1c"}}]}`, ""},
		{"a field Iroha did not add", `{"error":{"message":"Unknown parameter: 'temperature_x'."}}`, ""},
		{"a nested user field is the Caller's", `{"error":{"message":"Unknown parameter: 'messages[0].user'."}}`, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := caching.Refused([]byte(tc.body), added); got != tc.want {
				t.Errorf("Refused = %q, want %q", got, tc.want)
			}
		})
	}
	if got := caching.Refused([]byte(`{"error":{"message":"Unknown parameter: 'user'."}}`), []string{"prompt_cache_key"}); got != "" {
		t.Errorf("a field not added is not a refusal of an addition: %q", got)
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
