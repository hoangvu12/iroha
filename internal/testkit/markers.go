package testkit

import (
	"encoding/json"
	"testing"
)

// CacheMarkers lists the cache_control markers of an Anthropic Messages
// request body in prompt order, each as "<where>=<ttl>" ("5m" when it names
// none): "tool:<name>", "system:<text>", "<role>:<text or block type>", and
// the top-level one last as "top". Tests of prompt caching (gateway and
// translate) assert on it.
func CacheMarkers(t testing.TB, body []byte) []string {
	t.Helper()
	var req map[string]any
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("%v: %s", err, body)
	}
	asMap := func(v any) map[string]any { m, _ := v.(map[string]any); return m }
	asList := func(v any) []any { l, _ := v.([]any); return l }
	asString := func(v any) string { s, _ := v.(string); return s }
	var out []string
	add := func(where string, v any) {
		cc, ok := v.(map[string]any)
		if !ok {
			return
		}
		ttl := asString(cc["ttl"])
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
