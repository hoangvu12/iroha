package main

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/hoangvu12/iroha/internal/fakeupstream"
	"github.com/hoangvu12/iroha/internal/shape"
)

type Seeded struct {
	Providers   []string          `json:"providers"`
	KeyStates   map[string]string `json:"key_states" doc:"provider/key -> state, for the keys not active"`
	Pools       []string          `json:"pools"`
	GatewayKeys []string          `json:"gateway_keys"`
	Requests    int               `json:"requests"`
	Failed      int               `json:"failed_requests"`
}

type demoEndpoint struct {
	name      string
	shape     shape.Shape
	authStyle string
	authParam string
}

type demoProvider struct {
	handle, name string
	endpoints    []demoEndpoint
	models       []string
	keys         int
}

var demoProviders = []demoProvider{
	{"groq", "Groq", []demoEndpoint{{shape: shape.OpenAIChat}}, []string{"llama-3.3-70b", "qwen3-32b"}, 4},
	{"zai", "Z.ai", []demoEndpoint{{shape: shape.OpenAIChat}}, []string{"glm-4.6", "glm-4.5-air"}, 3},
	{"openrouter", "OpenRouter", []demoEndpoint{{shape: shape.OpenAIChat}}, []string{"z-ai/glm-4.6", "meta-llama/llama-3.3-70b-instruct", "anthropic/claude-sonnet-4.5"}, 6},
	{"deepseek", "DeepSeek", []demoEndpoint{{shape: shape.OpenAIChat}, {name: "anthropic", shape: shape.AnthropicMessages, authStyle: "x-api-key"}}, []string{"deepseek-chat", "deepseek-reasoner"}, 2},
	{"anthropic", "Anthropic", []demoEndpoint{{shape: shape.AnthropicMessages, authStyle: "x-api-key"}}, []string{"claude-sonnet-4-5", "claude-haiku-4-5"}, 2},
	{"mistral", "Mistral", []demoEndpoint{{shape: shape.OpenAIChat}}, []string{"mistral-large-latest", "mistral-small-latest"}, 1},
	{"openai", "OpenAI", []demoEndpoint{{shape: shape.OpenAIResponses}}, []string{"gpt-5", "gpt-5-mini"}, 2},
	{"gemini", "Google Gemini", []demoEndpoint{{shape: shape.Gemini, authStyle: "header", authParam: "x-goog-api-key"}}, []string{"gemini-2.5-pro", "gemini-2.5-flash"}, 2},
}

var demoKeyOverrides = map[string]struct {
	fakesAnswer int
	state       string
}{
	"openrouter/key-3": {http.StatusTooManyRequests, "cooling"},
	"openrouter/key-5": {http.StatusUnauthorized, "invalid"},
	"openrouter/key-6": {0, "disabled"},
	"groq/key-4":       {0, "disabled"},
}

func secretFakesAlwaysAnswer(secret string, status int) string {
	return fmt.Sprintf("%s-fail%d", secret, status)
}

func seedDemo(ctx context.Context, admin *client, fakes map[shape.Shape]*fakeupstream.Upstream) (*Seeded, map[string]string, error) {
	out := &Seeded{KeyStates: map[string]string{}}
	for _, p := range demoProviders {
		if err := admin.do(ctx, "PUT", "/api/providers/"+p.handle, map[string]any{"name": p.name, "discovery": "none"}, nil); err != nil {
			return nil, nil, err
		}
		for _, e := range p.endpoints {
			body := map[string]any{"url": fakes[e.shape].URL(), "shape": string(e.shape)}
			name := e.name
			if name == "" {
				name = "default"
			}
			if e.authStyle != "" {
				body["auth_style"] = e.authStyle
			}
			if e.authParam != "" {
				body["auth_param"] = e.authParam
			}
			if err := admin.do(ctx, "PUT", "/api/providers/"+p.handle+"/endpoints/"+name, body, nil); err != nil {
				return nil, nil, err
			}
		}
		for _, m := range p.models {
			if err := admin.do(ctx, "POST", "/api/providers/"+p.handle+"/models", map[string]any{"model": m}, nil); err != nil {
				return nil, nil, err
			}
		}
		for i := 1; i <= p.keys; i++ {
			name := fmt.Sprintf("key-%d", i)
			secret := fmt.Sprintf("sk-demo-%s-%d", p.handle, i)
			if o, ok := demoKeyOverrides[p.handle+"/"+name]; ok && o.fakesAnswer != 0 {
				secret = secretFakesAlwaysAnswer(secret, o.fakesAnswer)
			}
			if err := admin.do(ctx, "PUT", "/api/providers/"+p.handle+"/keys/"+name, map[string]any{"secret": secret}, nil); err != nil {
				return nil, nil, err
			}
		}
		out.Providers = append(out.Providers, p.handle)
	}

	for _, ref := range sortedKeys(demoKeyOverrides) {
		o := demoKeyOverrides[ref]
		handle, key, _ := strings.Cut(ref, "/")
		path := "/api/providers/" + handle + "/keys/" + key
		tested := "none"
		if o.state == "disabled" {
			if err := admin.do(ctx, "POST", path+"/disable", nil, nil); err != nil {
				return nil, nil, err
			}
		} else {
			for _, m := range modelsOf(handle) {
				var res struct {
					Outcome string `json:"outcome"`
					Reason  string `json:"reason"`
				}
				if err := admin.do(ctx, "POST", path+"/test?model="+url.QueryEscape(m), nil, &res); err != nil {
					return nil, nil, err
				}
				tested = res.Outcome + ": " + res.Reason
				if o.state == "invalid" {
					break
				}
			}
		}
		var k struct {
			State struct {
				State string `json:"state"`
			} `json:"state"`
		}
		if err := admin.do(ctx, "GET", path, nil, &k); err != nil {
			return nil, nil, err
		}
		if k.State.State != o.state {
			return nil, nil, fmt.Errorf("%s is %q after seeding, want %q (key test: %s)", ref, k.State.State, o.state, tested)
		}
		out.KeyStates[ref] = k.State.State
	}

	pools := []struct {
		name    string
		members [][2]string
	}{
		{"glm-4.6", [][2]string{{"zai", "glm-4.6"}, {"openrouter", "z-ai/glm-4.6"}}},
		{"llama-3.3-70b", [][2]string{{"groq", "llama-3.3-70b"}, {"openrouter", "meta-llama/llama-3.3-70b-instruct"}}},
	}
	for _, p := range pools {
		var ms []any
		for _, m := range p.members {
			ms = append(ms, map[string]any{"provider": m[0], "model": m[1]})
		}
		if err := admin.do(ctx, "PUT", "/api/pools/"+p.name, map[string]any{"members": ms}, nil); err != nil {
			return nil, nil, err
		}
		out.Pools = append(out.Pools, p.name)
	}

	keys := map[string]string{}
	gks := []struct {
		name  string
		scope map[string]any
	}{
		{"laptop", map[string]any{"all": true}},
		{"ci", map[string]any{"providers": []any{
			map[string]any{"provider": "openrouter"}, map[string]any{"provider": "deepseek"}, map[string]any{"provider": "anthropic"},
		}, "pools": []string{"glm-4.6"}}},
		{"friend", map[string]any{"providers": []any{
			map[string]any{"provider": "groq", "models": []string{"llama-3.3-70b"}},
		}, "pools": []string{"llama-3.3-70b"}}},
	}
	for _, g := range gks {
		var res struct {
			GatewayKey struct {
				Secret string `json:"secret"`
			} `json:"gateway_key"`
		}
		if err := admin.do(ctx, "PUT", "/api/gateway-keys/"+g.name, map[string]any{"scope": g.scope}, &res); err != nil {
			return nil, nil, err
		}
		keys[g.name] = res.GatewayKey.Secret
		out.GatewayKeys = append(out.GatewayKeys, g.name)
	}

	n, failed, err := demoTraffic(ctx, admin, keys, fakes)
	out.Requests, out.Failed = n, failed
	return out, keys, err
}

func modelsOf(handle string) []string {
	for _, p := range demoProviders {
		if p.handle == handle {
			return p.models
		}
	}
	return nil
}

func demoTraffic(ctx context.Context, admin *client, keys map[string]string, fakes map[shape.Shape]*fakeupstream.Upstream) (sent, failed int, err error) {
	chat := fakes[shape.OpenAIChat]
	laptop, ci, friend := admin.as(keys["laptop"]), admin.as(keys["ci"]), admin.as(keys["friend"])

	type call struct {
		c     *client
		path  string
		body  map[string]any
		usage *fakeupstream.Usage
		queue []fakeupstream.Responder
		fail  bool
	}
	chatBody := func(model, prompt string) map[string]any {
		return map[string]any{"model": model, "messages": []any{
			map[string]any{"role": "system", "content": "You are a concise assistant for the demo."},
			map[string]any{"role": "user", "content": prompt}}}
	}
	msgBody := func(model, prompt string) map[string]any {
		return map[string]any{"model": model, "max_tokens": 256, "system": "You are a concise assistant for the demo.",
			"messages": []any{map[string]any{"role": "user", "content": prompt}}}
	}
	cached := func(in, read int) *fakeupstream.Usage {
		return &fakeupstream.Usage{Input: in, Output: 180, CacheRead: read}
	}
	fresh := &fakeupstream.Usage{Input: 1200, Output: 240}

	calls := []call{
		{c: laptop, path: "/v1/chat/completions", body: chatBody("groq/llama-3.3-70b", "Summarise the release notes."), usage: fresh},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("groq/llama-3.3-70b", "Summarise the release notes."), usage: cached(1400, 1100)},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("groq/qwen3-32b", "Write a haiku about queues.")},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("zai/glm-4.6", "Refactor this function."), usage: fresh},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("zai/glm-4.6", "Refactor this function."), usage: cached(2600, 2048)},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("zai/glm-4.5-air", "Name three sorting algorithms.")},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("zai/glm-4.6", "Plan the sprint."),
			queue: []fakeupstream.Responder{chat.ErrorCode(429, "rate_limit_exceeded", "Rate limit reached for requests").Header("Retry-After", "60")}},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("deepseek/deepseek-chat", "Explain rendezvous hashing."), usage: fresh},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("deepseek/deepseek-chat", "Explain rendezvous hashing."), usage: cached(1800, 1536)},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("mistral/mistral-small-latest", "Translate 'good morning' to French.")},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("mistral/mistral-large-latest", "Draft the incident report."), fail: true,
			queue: []fakeupstream.Responder{chat.Error(500, "internal error"), chat.Error(500, "internal error"), chat.Error(500, "internal error")}},
		{c: laptop, path: "/v1/chat/completions", body: map[string]any{"model": "openrouter/anthropic/claude-sonnet-4.5", "stream": true,
			"messages": []any{map[string]any{"role": "user", "content": "Stream a short poem."}}}},
		{c: laptop, path: "/v1/messages", body: msgBody("anthropic/claude-sonnet-4-5", "Review this pull request."), usage: fresh},
		{c: laptop, path: "/v1/messages", body: msgBody("anthropic/claude-sonnet-4-5", "Review this pull request."), usage: cached(5200, 4800)},
		{c: laptop, path: "/v1/messages", body: map[string]any{"model": "anthropic/claude-haiku-4-5", "max_tokens": 128, "stream": true,
			"messages": []any{map[string]any{"role": "user", "content": "One sentence on SQLite."}}}},
		{c: laptop, path: "/v1/chat/completions", body: chatBody("anthropic/claude-haiku-4-5", "What is a Model Pool?")},
		{c: laptop, path: "/v1/messages", body: msgBody("deepseek/deepseek-reasoner", "Prove that 17 is prime.")},
		{c: laptop, path: "/v1/responses", body: map[string]any{"model": "openai/gpt-5", "input": "Outline a migration plan."}, usage: fresh},
		{c: laptop, path: "/v1/responses", body: map[string]any{"model": "openai/gpt-5", "input": "Outline a migration plan."}, usage: cached(3000, 2560)},
		{c: laptop, path: "/v1/responses", body: map[string]any{"model": "openai/gpt-5-mini", "input": "Classify this ticket."}},
		{c: laptop, path: "/providers/gemini/v1beta/models/gemini-2.5-flash:generateContent", body: map[string]any{
			"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "Describe the weather in Hanoi."}}}}}},
		{c: laptop, path: "/providers/gemini/v1beta/models/gemini-2.5-pro:generateContent", body: map[string]any{
			"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": "Compare two databases."}}}}}, usage: cached(4000, 3072)},
		{c: ci, path: "/v1/chat/completions", body: chatBody("glm-4.6", "Run the lint summary."), usage: fresh},
		{c: ci, path: "/v1/chat/completions", body: chatBody("glm-4.6", "Run the lint summary."), usage: cached(1500, 1280)},
		{c: ci, path: "/v1/chat/completions", body: chatBody("glm-4.6", "Summarise the test failures.")},
		{c: ci, path: "/v1/chat/completions", body: chatBody("openrouter/z-ai/glm-4.6", "Write the changelog entry.")},
		{c: ci, path: "/v1/chat/completions", body: chatBody("openrouter/meta-llama/llama-3.3-70b-instruct", "Label this issue.")},
		{c: ci, path: "/v1/messages", body: msgBody("deepseek/deepseek-chat", "Check this diff for bugs.")},
		{c: ci, path: "/v1/messages", body: msgBody("anthropic/claude-haiku-4-5", "Triage these logs.")},
		{c: friend, path: "/v1/chat/completions", body: chatBody("llama-3.3-70b", "Recommend a book.")},
		{c: friend, path: "/v1/chat/completions", body: chatBody("llama-3.3-70b", "Recommend a film.")},
		{c: friend, path: "/v1/chat/completions", body: chatBody("groq/llama-3.3-70b", "Plan a weekend trip.")},
	}
	for _, c := range calls {
		for _, u := range fakes {
			u.SetUsage(1000, 200)
			if c.usage != nil {
				u.SetUsageWith(*c.usage)
			}
		}
		if len(c.queue) > 0 {
			chat.Enqueue(c.queue...)
		}
		status, err := c.c.send(ctx, "POST", c.path, c.body, nil)
		if err != nil {
			return sent, failed, fmt.Errorf("POST %s: %w", c.path, err)
		}
		sent++
		ok := status >= 200 && status < 300
		if !ok {
			failed++
		}
		if ok == c.fail {
			return sent, failed, fmt.Errorf("demo Request POST %s %v answered %d, want it to %s", c.path, c.body["model"], status, map[bool]string{true: "fail", false: "succeed"}[c.fail])
		}
		if c.fail {
			chat.Reset()
		} else if q := chat.Queued(); q > 0 {
			return sent, failed, fmt.Errorf("demo Request POST %s left %d queued replies on the fake", c.path, q)
		}
	}
	return sent, failed, nil
}
