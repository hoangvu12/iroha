package translate_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/testkit"
	"github.com/hoangvu12/iroha/internal/translate"
)

func golden(t *testing.T, name string) (goldenCase, output) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "golden", name+".in.json"))
	if err != nil {
		t.Fatal(err)
	}
	var gc goldenCase
	if err := json.Unmarshal(raw, &gc); err != nil {
		t.Fatal(err)
	}
	return gc, run(t, gc)
}

func object(t *testing.T, b []byte) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatalf("%v: %s", err, b)
	}
	return m
}

func asMap(v any) map[string]any { m, _ := v.(map[string]any); return m }
func asList(v any) []any         { l, _ := v.([]any); return l }
func asString(v any) string      { s, _ := v.(string); return s }

func TestMarkersAreAddedOnTheLastToolSystemBlockAndMessage(t *testing.T) {
	_, o := golden(t, "chat-to-anthropic-cache-markers-added")
	req := object(t, o.request)
	got := strings.Join(testkit.CacheMarkers(t, o.request), ", ")
	if want := "tool:write_file=5m, system:You are a coding agent.=5m, user:Now explain it.=5m"; got != want {
		t.Errorf("markers %s, want %s", got, want)
	}
	if u := asString(asMap(req["metadata"])["user_id"]); u != "u-42" {
		t.Errorf("metadata.user_id = %q, want the Caller's user", u)
	}
	ans := object(t, o.answer)
	if w := asMap(asMap(ans["usage"])["prompt_tokens_details"])["cache_write_tokens"]; w != float64(2048) {
		t.Errorf("answer cache_write_tokens = %v: %s", w, o.answer)
	}
	if !strings.Contains(string(o.stream), `"cache_write_tokens":2048`) {
		t.Errorf("the stream's usage chunk lacks the cache write:\n%s", o.stream)
	}
}

func TestCallerMarkersAreKeptClampedToFourWithLongerLifetimesFirst(t *testing.T) {
	_, o := golden(t, "chat-to-anthropic-caller-markers")
	req := object(t, o.request)
	got := strings.Join(testkit.CacheMarkers(t, o.request), ", ")
	want := "user:First question=5m, assistant:First answer=5m, user:Second question=5m, user:with a long file=5m"
	if got != want {
		t.Errorf("markers %s, want %s", got, want)
	}
	if u := asString(asMap(req["metadata"])["user_id"]); u != "pck-7" {
		t.Errorf("metadata.user_id = %q, want the Caller's prompt_cache_key", u)
	}
}

func TestTopLevelMarkerForAnthropicsOwnAPI(t *testing.T) {
	_, o := golden(t, "responses-to-anthropic-cache-top-level")
	req := object(t, o.request)
	if got := strings.Join(testkit.CacheMarkers(t, o.request), ", "); got != "top=5m" {
		t.Errorf("markers %s, want only the top-level one", got)
	}
	if u := asString(asMap(req["metadata"])["user_id"]); u != "hashed-user-9" {
		t.Errorf("metadata.user_id = %q, want safety_identifier", u)
	}
	d := asMap(asMap(object(t, o.answer)["usage"])["input_tokens_details"])
	if d["cache_write_tokens"] != float64(1200) || d["cached_tokens"] != float64(800) {
		t.Errorf("Responses usage details %v", d)
	}
}

func TestTopOnlyEndpointsGetOneTopLevelMarker(t *testing.T) {
	_, o := golden(t, "gemini-to-anthropic-cache-top-only")
	if got := strings.Join(testkit.CacheMarkers(t, o.request), ", "); got != "top=5m" {
		t.Errorf("markers %s", got)
	}
}

func TestAnthropicToChatKeepsTheSystemPromptsMarker(t *testing.T) {
	_, o := golden(t, "anthropic-to-chat-cache-system-marker")
	req := object(t, o.request)
	sys := asMap(asList(req["messages"])[0])
	parts := asList(sys["content"])
	if asString(sys["role"]) != "system" || len(parts) != 2 || asString(asMap(asMap(parts[1])["cache_control"])["ttl"]) != "1h" || asMap(parts[0])["cache_control"] != nil {
		t.Errorf("system message %v", sys)
	}
	if req["user"] != "user-7" || req["prompt_cache_key"] != "c1a6f3b0-0000-5000-8000-000000000002" {
		t.Errorf("user %v, prompt_cache_key %v", req["user"], req["prompt_cache_key"])
	}
	u := asMap(object(t, o.answer)["usage"])
	if u["input_tokens"] != float64(10) || u["cache_read_input_tokens"] != float64(1000) || u["cache_creation_input_tokens"] != float64(1990) {
		t.Errorf("Anthropic usage %v", u)
	}
}

func TestMarkersOffStripsThemAndAClaudeCodeSessionIsNoUser(t *testing.T) {
	_, o := golden(t, "anthropic-to-chat-cache-strip")
	if strings.Contains(string(o.request), "cache_control") {
		t.Errorf("markers left: %s", o.request)
	}
	req := object(t, o.request)
	if _, ok := req["user"]; ok {
		t.Errorf("Claude Code's session JSON sent as user: %v", req["user"])
	}
	if req["prompt_cache_key"] != "c1a6f3b0-0000-5000-8000-000000000003" {
		t.Errorf("prompt_cache_key %v", req["prompt_cache_key"])
	}
}

func TestDerivedPromptCacheKeyOnlyWhenTheRequestHasNone(t *testing.T) {
	_, o := golden(t, "gemini-to-chat-cache-derived-key")
	if k := object(t, o.request)["prompt_cache_key"]; k != "c1a6f3b0-0000-5000-8000-000000000004" {
		t.Errorf("derived key %v", k)
	}
	_, o = golden(t, "chat-to-responses-cache-caller-key")
	if k := object(t, o.request)["prompt_cache_key"]; k != "the-callers-own" {
		t.Errorf("the Caller's key was replaced: %v", k)
	}
}

func TestAnthropicToResponsesMapsAPlainUserID(t *testing.T) {
	send := func(userID string, c translate.Caching) (map[string]any, []string) {
		t.Helper()
		tr, err := translate.New(shape.AnthropicMessages, shape.OpenAIResponses, translate.Options{Model: "m", ID: "r", Now: now, Caching: c})
		if err != nil {
			t.Fatal(err)
		}
		body, _ := json.Marshal(map[string]any{"model": "m", "max_tokens": 10, "metadata": map[string]any{"user_id": userID},
			"messages": []any{map[string]any{"role": "user", "content": "hi"}}})
		out, err := tr.Request(context.Background(), body, "m")
		if err != nil {
			t.Fatal(err)
		}
		return object(t, out), tr.Added
	}
	on := translate.Caching{Fields: true, PromptCacheKey: "c1a6f3b0-0000-5000-8000-000000000009"}
	if req, added := send("user-7", on); req["user"] != "user-7" || req["prompt_cache_key"] != on.PromptCacheKey || strings.Join(added, ",") != "user,prompt_cache_key" {
		t.Errorf("user %v, prompt_cache_key %v, added %v", req["user"], req["prompt_cache_key"], added)
	}
	if req, _ := send(`{"device_id":"d","session_id":"s-1"}`, on); req["user"] != nil {
		t.Errorf("Claude Code's session sent as user: %v", req["user"])
	}
	if req, added := send("user-7", translate.Caching{}); req["user"] != nil || len(added) != 0 {
		t.Errorf("no Caching, yet user %v, added %v", req["user"], added)
	}
}

func TestNoCachingAddsNothing(t *testing.T) {
	gc, _ := golden(t, "chat-to-anthropic-cache-markers-added")
	tr, err := translate.New(gc.From, gc.To, translate.Options{Model: gc.Model, ID: "r", Now: now})
	if err != nil {
		t.Fatal(err)
	}
	out, err := tr.Request(context.Background(), gc.Request, gc.WireModel)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "cache_control") || strings.Contains(string(out), "metadata") || len(tr.Added) != 0 {
		t.Errorf("added %v: %s", tr.Added, out)
	}
}

func TestAddedNamesWhatIrohaAdded(t *testing.T) {
	gc, _ := golden(t, "chat-to-anthropic-cache-markers-added")
	tr, _ := translate.New(gc.From, gc.To, translate.Options{Model: gc.Model, ID: "r", Now: now,
		Caching: translate.Caching{Markers: gc.Caching.Markers, Fields: true}})
	if _, err := tr.Request(context.Background(), gc.Request, gc.WireModel); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(tr.Added, ","); got != "cache_control,metadata" {
		t.Errorf("Added = %s", got)
	}
}

func TestGeminiCachedContentIsRefusedInTranslation(t *testing.T) {
	for _, to := range translate.Targets(shape.Gemini) {
		tr, _ := translate.New(shape.Gemini, to, translate.Options{Model: "m", ID: "r", Now: now})
		_, err := tr.Request(context.Background(), []byte(`{"cachedContent":"cachedContents/abc","contents":[{"role":"user","parts":[{"text":"hi"}]}]}`), "m")
		var te *translate.Error
		if !errors.As(err, &te) || !strings.Contains(te.Message, "cachedContent") || te.Hint == "" {
			t.Errorf("to %s: %v", to, err)
		}
	}
}
