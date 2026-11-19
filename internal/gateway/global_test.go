package gateway_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/testkit"
)

func chatBody(model string) map[string]any {
	return map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
}

func TestGlobalChatNamesTheProviderInTheModelAndEchoesIt(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(testkit.JSON(200, map[string]any{
		"id": "chatcmpl-1", "object": "chat.completion", "model": "gpt-x-2026-01-01",
		"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "hello"}, "finish_reason": "stop"}},
	}))
	body := `{"model":"acme/gpt-x", "messages":[{"role":"user","content":"hi"}], "vendor_extra":{"a":[1,2]}}`
	resp := caller.Post("/v1/chat/completions", body).Expect(200)

	// The Provider gets its own model ID; every other byte is the Caller's.
	got := up.Last()
	if want := strings.Replace(body, `"acme/gpt-x"`, `"gpt-x"`, 1); string(got.Body) != want || got.Path != "/v1/chat/completions" || got.Bearer() != "sk-test-one" {
		t.Fatalf("upstream got %s bearer %q body %s", got.Path, got.Bearer(), got.Body)
	}
	if m := resp.Map(); m["model"] != "acme/gpt-x" {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Route != "/v1/chat/completions" || r.Model != "acme/gpt-x" || r.WireModel != "gpt-x" || r.Provider != "acme" || r.Status != 200 {
		t.Fatalf("request = %+v", r)
	}

	// Streamed: every chunk names the qualified model.
	st := chatBody("acme/gpt-x")
	st["stream"] = true
	events := caller.Post("/v1/chat/completions", st).Expect(200).Events()
	n := 0
	for _, e := range events {
		if e.Data == "[DONE]" {
			continue
		}
		var c struct{ Model string }
		if json.Unmarshal([]byte(e.Data), &c) != nil || c.Model != "acme/gpt-x" {
			t.Fatalf("chunk = %s", e.Data)
		}
		n++
	}
	if n == 0 || up.Last().Model != "gpt-x" {
		t.Fatalf("events = %+v, upstream model %q", events, up.Last().Model)
	}
}

func TestGlobalModelIDsKeepTheirSlashesAfterTheHandle(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "router", up.URL(), "sk-test-one")
	// A scope narrowed to the Provider's own model ID (slashes included).
	caller := srv.Client(issue(t, srv, "narrow", map[string]any{"providers": []any{
		map[string]any{"provider": "router", "models": []string{"meta-llama/llama-3.3-70b"}}}}))

	resp := caller.Post("/v1/chat/completions", chatBody("router/meta-llama/llama-3.3-70b")).Expect(200)
	if got := up.Last().Model; got != "meta-llama/llama-3.3-70b" {
		t.Fatalf("upstream model = %q", got)
	}
	if m := resp.Map(); m["model"] != "router/meta-llama/llama-3.3-70b" {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Model != "router/meta-llama/llama-3.3-70b" || r.WireModel != "meta-llama/llama-3.3-70b" {
		t.Fatalf("request = %+v", r)
	}

	// An Endpoint rename applies to the Provider's model ID.
	srv.Admin.Patch("/api/providers/router/endpoints/default", map[string]any{"renames": map[string]string{"meta-llama/llama-3.3-70b": "llama-3.3-70b-fp8"}}).OK()
	resp = caller.Post("/v1/chat/completions", chatBody("router/meta-llama/llama-3.3-70b")).Expect(200)
	if up.Last().Model != "llama-3.3-70b-fp8" || resp.Map()["model"] != "router/meta-llama/llama-3.3-70b" {
		t.Fatalf("renamed: upstream %q answer %s", up.Last().Model, resp.Body)
	}

	// The narrowed scope still holds: the qualified name is not a scope entry.
	if e := caller.Post("/v1/chat/completions", chatBody("router/meta-llama")).Expect(403).Err(); e.Code != "model_not_allowed" {
		t.Fatalf("out of scope = %+v", e)
	}
}

func TestGlobalRoutesRefuseUnqualifiedNamesWithAHint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	for _, model := range []string{"gpt-x", "/gpt-x", "acme/"} {
		resp := caller.Post("/v1/chat/completions", chatBody(model)).Expect(400)
		e := resp.Err()
		if e.Code != "invalid_model_id" || !strings.Contains(e.Hint, "<provider handle>/<model ID>") || !strings.Contains(e.Hint, "/v1/models") {
			t.Fatalf("%q: error = %+v", model, e)
		}
		r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
		if r.Model != model || r.Error == nil || r.Error.Code != "invalid_model_id" || r.AttemptCount != 0 {
			t.Fatalf("%q: request = %+v", model, r)
		}
	}
	// Messages refuses in its own envelope.
	resp := claudeCaller(t, srv).Post("/v1/messages", messages("claude-x")).Expect(400)
	if m := resp.Map(); m["type"] != "error" || resp.Err().Code != "invalid_model_id" {
		t.Fatalf("messages = %s", resp.Body)
	}
	if up.Count() != 0 {
		t.Fatalf("an unqualified model reached the Provider")
	}
}

func TestGlobalRoutesRefuseEveryProviderOutOfReachAlike(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	addProvider(t, srv, "off", up.URL(), "sk-test-two")
	addProvider(t, srv, "gone", up.URL(), "sk-test-three")
	addProvider(t, srv, "other", up.URL(), "sk-test-four")
	srv.Admin.Patch("/api/providers/off", map[string]any{"enabled": false}).OK()
	srv.Admin.Patch("/api/providers/gone", map[string]any{"archived": true}).OK()
	caller := srv.Client(issue(t, srv, "narrow", map[string]any{"providers": []any{
		map[string]any{"provider": "acme", "models": []string{"gpt-x"}}, map[string]any{"provider": "off"}, map[string]any{"provider": "gone"}}}))

	// Unknown, out of scope, disabled, archived and impossible handles.
	for _, h := range []string{"nope", "other", "off", "gone", "ACME"} {
		e := caller.Post("/v1/chat/completions", chatBody(h+"/gpt-x")).Expect(403).Err()
		want := `This Gateway Key may not use a Provider named "` + h + `", or there is none.`
		if e.Code != "provider_not_allowed" || e.Message != want || !strings.Contains(e.Hint, "before the slash") {
			t.Fatalf("%s: error = %+v", h, e)
		}
	}
	if e := caller.Post("/v1/chat/completions", chatBody("acme/gpt-y")).Expect(403).Err(); e.Code != "model_not_allowed" {
		t.Fatalf("model out of scope = %+v", e)
	}
	// A hidden model is refused as on the provider-scoped route.
	srv.Admin.Post("/api/providers/acme/models", map[string]any{"model": "gpt-x", "hidden": true}).Expect(201)
	if e := caller.Post("/v1/chat/completions", chatBody("acme/gpt-x")).Expect(404).Err(); e.Code != "model_not_found" {
		t.Fatalf("hidden = %+v", e)
	}
	if up.Count() != 0 {
		t.Fatalf("a refused Request reached a Provider")
	}
}

func TestGlobalResponsesEchoTheQualifiedName(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIResponses(t)
	addEndpointProvider(t, srv, "acme", "openai-responses", up.URL(), "sk-test-oai")
	caller := srv.Client(issue(t, srv, "codex", all))

	resp := caller.Post("/v1/responses", responsesReq("acme/openai/gpt-5")).Expect(200)
	if up.Last().Model != "openai/gpt-5" || resp.Map()["model"] != "acme/openai/gpt-5" {
		t.Fatalf("upstream %q answer %s", up.Last().Model, resp.Body)
	}
	st := responsesReq("acme/openai/gpt-5")
	st["stream"] = true
	evs, _ := readResponses(t, caller.Post("/v1/responses", st).Expect(200).Events())
	n := 0
	for _, e := range evs {
		if e.Response != nil {
			if e.Response.Model != "acme/openai/gpt-5" {
				t.Fatalf("%s names model %q", e.Type, e.Response.Model)
			}
			n++
		}
	}
	if n == 0 {
		t.Fatalf("no event named a model: %+v", evs)
	}
	if e := caller.Post("/v1/responses", responsesReq("gpt-5")).Expect(400).Err(); e.Code != "invalid_model_id" {
		t.Fatalf("unqualified = %+v", e)
	}
}

func TestGlobalMessagesPassThroughAndTranslateEchoingTheQualifiedName(t *testing.T) {
	srv := testkit.Start(t)
	ant := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "claude", "anthropic-messages", ant.URL(), "sk-test-ant")
	oai := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "glm", "openai-chat", oai.URL(), "sk-test-oai")
	caller := claudeCaller(t, srv)

	// Passthrough, buffered and streamed.
	resp := caller.Post("/v1/messages", messages("claude/claude-x")).Expect(200)
	if ant.Last().Model != "claude-x" || resp.Map()["model"] != "claude/claude-x" {
		t.Fatalf("passthrough: upstream %q answer %s", ant.Last().Model, resp.Body)
	}
	st := messages("claude/claude-x")
	st["stream"] = true
	events := caller.Post("/v1/messages", st).Expect(200).Events()
	if len(events) == 0 || events[0].Event != "message_start" || !strings.Contains(events[0].Data, `"model":"claude/claude-x"`) {
		t.Fatalf("passthrough stream = %+v", events)
	}

	// Translated to OpenAI Chat, buffered and streamed.
	resp = caller.Post("/v1/messages", messages("glm/glm-4.6")).Expect(200)
	if oai.Last().Model != "glm-4.6" || resp.Map()["model"] != "glm/glm-4.6" {
		t.Fatalf("translated: upstream %q answer %s", oai.Last().Model, resp.Body)
	}
	st = messages("glm/glm-4.6")
	st["stream"] = true
	events = caller.Post("/v1/messages", st).Expect(200).Events()
	if len(events) == 0 || events[0].Event != "message_start" || !strings.Contains(events[0].Data, `"model":"glm/glm-4.6"`) {
		t.Fatalf("translated stream = %+v", events)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Route != "/v1/messages" || r.Model != "glm/glm-4.6" || r.WireModel != "glm-4.6" || r.ShapeIn != "anthropic-messages" || r.ShapeOut != "openai-chat" {
		t.Fatalf("request = %+v", r)
	}
}
