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
	"github.com/hoangvu12/iroha/internal/translate"
)

// Prompt caching 03: what translation adds for the Provider's prompt cache.
// The golden files hold the whole bodies; these tests say what in them is
// the point, so a golden update can't quietly lose it.

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

// markers lists the cache_control objects of an Anthropic request in
// prompt order, each as "<where>=<ttl>" ("5m" when it names none), the
// top-level one last as "top".
func markers(req map[string]any) []string {
	var out []string
	add := func(where string, v any) {
		cc, ok := v.(map[string]any)
		if !ok {
			return
		}
		ttl, _ := cc["ttl"].(string)
		if ttl == "" {
			ttl = "5m"
		}
		out = append(out, where+"="+ttl)
	}
	for _, tool := range asList(req["tools"]) {
		add("tool:"+asString(asMap(tool)["name"]), asMap(tool)["cache_control"])
	}
	for _, b := range asList(req["system"]) {
		add("system:"+asString(asMap(b)["text"]), asMap(b)["cache_control"])
	}
	for _, m := range asList(req["messages"]) {
		for _, b := range asList(asMap(m)["content"]) {
			text := asString(asMap(b)["text"])
			if text == "" {
				text = asString(asMap(b)["type"])
			}
			add(asString(asMap(m)["role"])+":"+text, asMap(b)["cache_control"])
		}
	}
	add("top", req["cache_control"])
	return out
}

func asMap(v any) map[string]any { m, _ := v.(map[string]any); return m }
func asList(v any) []any         { l, _ := v.([]any); return l }
func asString(v any) string      { s, _ := v.(string); return s }

// REQ-93: markers are added for a Chat Caller, and the write they cause is
// reported in OpenAI's names.
func TestMarkersAreAddedOnTheLastToolSystemBlockAndMessage(t *testing.T) {
	_, o := golden(t, "chat-to-anthropic-cache-markers-added")
	req := object(t, o.request)
	got := strings.Join(markers(req), ", ")
	if want := "tool:write_file=5m, system:You are a coding agent.=5m, user:Now explain it.=5m"; got != want {
		t.Errorf("markers %s, want %s", got, want)
	}
	if u := asString(asMap(req["metadata"])["user_id"]); u != "u-42" {
		t.Errorf("metadata.user_id = %q, want the Caller's user", u)
	}
	// The write the markers caused reaches the Chat Caller as OpenAI names it.
	ans := object(t, o.answer)
	if w := asMap(asMap(ans["usage"])["prompt_tokens_details"])["cache_write_tokens"]; w != float64(2048) {
		t.Errorf("answer cache_write_tokens = %v: %s", w, o.answer)
	}
	if !strings.Contains(string(o.stream), `"cache_write_tokens":2048`) {
		t.Errorf("the stream's usage chunk lacks the cache write:\n%s", o.stream)
	}
}

// REQ-109: a Caller's markers survive translation, at most 4 of them, in
// an order of lifetimes Anthropic accepts.
func TestCallerMarkersAreKeptClampedToFourWithLongerLifetimesFirst(t *testing.T) {
	_, o := golden(t, "chat-to-anthropic-caller-markers")
	req := object(t, o.request)
	got := strings.Join(markers(req), ", ")
	// Six Caller markers: the two earliest (the system blocks, one of them
	// 1 h) are dropped, and the 1 h marker after 5 min ones becomes 5 min.
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
	if got := strings.Join(markers(req), ", "); got != "top=5m" {
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
	if got := strings.Join(markers(object(t, o.request)), ", "); got != "top=5m" {
		t.Errorf("markers %s", got)
	}
}

// REQ-51, REQ-95: the system prompt keeps its marker where the Endpoint
// honours it, and the cache write comes back as Anthropic names it.
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

// Translation with no Caching asked adds nothing (the zero value): the
// golden files of tickets 13-16 are unchanged, and so is this.
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

// What Iroha added is listed, so a Provider refusing it can be retried
// without it.
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

// A Gemini request naming a cache stored at Google loses that context in
// any other Shape, so it is refused rather than sent without it.
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
