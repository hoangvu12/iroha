package translate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/hoangvu12/iroha/internal/affinity"
	"github.com/hoangvu12/iroha/internal/caching"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/usage"
)

type Caching struct {
	Markers        caching.Markers
	Fields         bool
	PromptCacheKey string
}

// maxMarkers is Anthropic's limit of cache_control markers per request.
const maxMarkers = 4

// RelayKit's request DTOs drop these fields.
type callerFields struct {
	User             json.RawMessage `json:"user"`
	SafetyIdentifier json.RawMessage `json:"safety_identifier"`
	PromptCacheKey   json.RawMessage `json:"prompt_cache_key"`
	Metadata         struct {
		UserID json.RawMessage `json:"user_id"`
	} `json:"metadata"`
	CacheControl   json.RawMessage `json:"cache_control"`
	CachedContent  json.RawMessage `json:"cachedContent"`
	CachedContent2 json.RawMessage `json:"cached_content"`
	Messages       []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"messages"`
	System json.RawMessage `json:"system"`
	Tools  []struct {
		CacheControl json.RawMessage `json:"cache_control"`
	} `json:"tools"`
}

func readCallerFields(body []byte) callerFields {
	var f callerFields
	_ = json.Unmarshal(body, &f)
	return f
}

// RelayKit already refuses Responses' stateful fields.
func (t *Translation) refuseStored(f callerFields) error {
	if t.caller.shape == shape.Gemini && (rawString(f.CachedContent) != "" || rawString(f.CachedContent2) != "") {
		return &Error{
			Message: "cachedContent names a cache stored at Google, which an Endpoint speaking " + string(t.endpoint.shape) + " cannot read; translating the request would silently leave that context out.",
			Hint:    "Send the cached contents in the request itself (contents and systemInstruction), or ask for a model of a Provider with a Gemini Endpoint, where cachedContent passes through.",
		}
	}
	return nil
}

func (t *Translation) applyCaching(m map[string]any, f callerFields) {
	c := t.o.Caching
	switch t.endpoint.shape {
	case shape.AnthropicMessages:
		t.anthropicMarkers(m, f, c.Markers)
		if c.Fields {
			if v := firstNonEmpty(rawString(f.User), rawString(f.SafetyIdentifier), rawString(f.PromptCacheKey)); v != "" {
				md := obj(m["metadata"])
				if md == nil {
					md = map[string]any{}
				}
				if _, ok := md["user_id"]; !ok {
					md["user_id"] = bounded(v, 256)
					m["metadata"] = md
					t.added("metadata")
				}
			}
		}
	case shape.OpenAIChat:
		if t.caller.shape == shape.AnthropicMessages {
			t.chatMarkers(m, f, c.Markers)
		}
		t.userFromMetadata(m, f)
		t.promptCacheKey(m, c.PromptCacheKey)
	case shape.OpenAIResponses:
		t.userFromMetadata(m, f)
		t.promptCacheKey(m, c.PromptCacheKey)
	}
}

func (t *Translation) userFromMetadata(m map[string]any, f callerFields) {
	if !t.o.Caching.Fields || t.caller.shape != shape.AnthropicMessages || !zero(m["user"]) {
		return
	}
	if v, _ := affinity.MetadataUserID(f.Metadata.UserID); v != "" { // Claude Code's value is a session, not a user
		m["user"] = bounded(v, 64)
		t.added("user")
	}
}

func (t *Translation) promptCacheKey(m map[string]any, key string) {
	if key != "" && zero(m["prompt_cache_key"]) {
		m["prompt_cache_key"] = key
		t.added("prompt_cache_key")
	}
}

func (t *Translation) added(name string) {
	for _, n := range t.Added {
		if n == name {
			return
		}
	}
	t.Added = append(t.Added, name)
}

func bounded(v string, n int) string {
	if len(v) <= n {
		return v
	}
	s := sha256.Sum256([]byte(v))
	return hex.EncodeToString(s[:])
}

func firstNonEmpty(vs ...string) string {
	for _, v := range vs {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}

func rawString(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

func rawObject(raw json.RawMessage) map[string]any {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

type marker struct {
	holder map[string]any
	top    bool
}

func (mk marker) cc() map[string]any { return obj(mk.holder["cache_control"]) }

func (t *Translation) anthropicMarkers(m map[string]any, f callerFields, p caching.Markers) {
	if p == caching.AsConverted {
		return
	}
	if p == caching.Strip {
		for _, mk := range anthropicMarkerList(m) {
			delete(mk.holder, "cache_control")
		}
		return
	}
	if t.caller.shape == shape.OpenAIChat {
		placeChatMarkers(m, f)
	}
	switch p {
	case caching.Blocks:
		if len(anthropicMarkerList(m)) == 0 {
			addBlockMarkers(m)
		}
	case caching.TopLevel:
		if len(anthropicMarkerList(m)) == 0 {
			m["cache_control"] = map[string]any{"type": "ephemeral"}
		}
	case caching.TopOnly:
		top := map[string]any{"type": "ephemeral"}
		for _, mk := range anthropicMarkerList(m) {
			if str(mk.cc()["ttl"]) == "1h" {
				top["ttl"] = "1h"
			}
			delete(mk.holder, "cache_control")
		}
		m["cache_control"] = top
	}
	clampMarkers(m)
	if len(anthropicMarkerList(m)) > 0 {
		t.added("cache_control")
	}
}

func anthropicMarkerList(m map[string]any) []marker {
	var out []marker
	add := func(h map[string]any) {
		if h != nil && obj(h["cache_control"]) != nil {
			out = append(out, marker{holder: h})
		}
	}
	for _, tool := range list(m["tools"]) {
		add(obj(tool))
	}
	for _, b := range list(m["system"]) {
		add(obj(b))
	}
	for _, msg := range list(m["messages"]) {
		for _, b := range list(obj(msg)["content"]) {
			add(obj(b))
			for _, inner := range list(obj(b)["content"]) {
				add(obj(inner))
			}
		}
	}
	if obj(m["cache_control"]) != nil {
		out = append(out, marker{holder: m, top: true})
	}
	return out
}

// Anthropic refuses a 1 h marker after a 5 min one.
func clampMarkers(m map[string]any) {
	list := anthropicMarkerList(m)
	for i := 0; len(list) > maxMarkers && i < len(list); i++ {
		if !list[i].top {
			delete(list[i].holder, "cache_control")
			list = append(list[:i], list[i+1:]...)
			i--
		}
	}
	short := false
	for _, mk := range list {
		cc := mk.cc()
		if str(cc["ttl"]) == "1h" {
			if short {
				delete(cc, "ttl")
			}
			continue
		}
		short = true
	}
}

func addBlockMarkers(m map[string]any) {
	mark := func(h map[string]any) { h["cache_control"] = map[string]any{"type": "ephemeral"} }
	if tools := list(m["tools"]); len(tools) > 0 {
		if tool := obj(tools[len(tools)-1]); tool != nil {
			mark(tool)
		}
	}
	if s, ok := m["system"].(string); ok && s != "" {
		m["system"] = []any{map[string]any{"type": "text", "text": s}}
	}
	if sys := list(m["system"]); len(sys) > 0 {
		if b := obj(sys[len(sys)-1]); markable(b) {
			mark(b)
		}
	}
	msgs := list(m["messages"])
	if len(msgs) == 0 {
		return
	}
	last := obj(msgs[len(msgs)-1])
	if s, ok := last["content"].(string); ok {
		if s != "" {
			last["content"] = []any{map[string]any{"type": "text", "text": s, "cache_control": map[string]any{"type": "ephemeral"}}}
		}
		return
	}
	blocks := list(last["content"])
	for i := len(blocks) - 1; i >= 0; i-- {
		if b := obj(blocks[i]); markable(b) {
			mark(b)
			return
		}
	}
}

// Anthropic refuses a marker on thinking blocks and empty text.
func markable(b map[string]any) bool {
	switch str(b["type"]) {
	case "", "thinking", "redacted_thinking":
		return false
	case "text":
		return str(b["text"]) != ""
	}
	return true
}

// RelayKit drops the cache_control a Chat Caller writes in OpenRouter's
// style (on content parts, tools and the request).
func placeChatMarkers(m map[string]any, f callerFields) {
	if cc := rawObject(f.CacheControl); cc != nil {
		m["cache_control"] = cc
	}
	if tools := list(m["tools"]); len(tools) == len(f.Tools) {
		for i, tool := range f.Tools {
			if cc := rawObject(tool.CacheControl); cc != nil {
				if t := obj(tools[i]); t != nil {
					t["cache_control"] = cc
				}
			}
		}
	}
	cur := cursor{msgs: list(m["messages"])}
	for _, msg := range f.Messages {
		var parts []struct {
			Text         string          `json:"text"`
			CacheControl json.RawMessage `json:"cache_control"`
		}
		if json.Unmarshal(msg.Content, &parts) != nil {
			continue
		}
		for _, p := range parts {
			cc := rawObject(p.CacheControl)
			if cc == nil || p.Text == "" {
				continue
			}
			if r := strings.ToLower(msg.Role); r == "system" || r == "developer" {
				for _, b := range list(m["system"]) {
					if b := obj(b); strings.Contains(str(b["text"]), p.Text) {
						b["cache_control"] = cc
						break
					}
				}
				continue
			}
			if b := cur.find(p.Text); b != nil {
				b["cache_control"] = cc
			}
		}
	}
}

type cursor struct {
	msgs     []any
	msg, blk int
}

func (c *cursor) find(text string) map[string]any {
	for ; c.msg < len(c.msgs); c.msg, c.blk = c.msg+1, 0 {
		msg := obj(c.msgs[c.msg])
		if s, ok := msg["content"].(string); ok && s == text {
			b := map[string]any{"type": "text", "text": s}
			msg["content"] = []any{b}
			c.blk = 1
			return b
		}
		blocks := list(msg["content"])
		for ; c.blk < len(blocks); c.blk++ {
			b := obj(blocks[c.blk])
			if str(b["text"]) == text || str(b["type"]) == "tool_result" && blockText(b["content"]) == text {
				c.blk++
				return b
			}
		}
	}
	return nil
}

func blockText(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	var sb strings.Builder
	for _, p := range list(v) {
		sb.WriteString(str(obj(p)["text"]))
	}
	return sb.String()
}

// RelayKit flattens an Anthropic Caller's system blocks into one string;
// OpenRouter and Qwen honour markers on the system message's text parts.
func (t *Translation) chatMarkers(m map[string]any, f callerFields, p caching.Markers) {
	msgs := list(m["messages"])
	switch p {
	case caching.Strip:
		for _, msg := range msgs {
			for _, part := range list(obj(msg)["content"]) {
				delete(obj(part), "cache_control")
			}
		}
		delete(m, "cache_control")
	case caching.Keep:
		var blocks []struct {
			Text         string          `json:"text"`
			CacheControl json.RawMessage `json:"cache_control"`
		}
		if json.Unmarshal(f.System, &blocks) != nil || len(msgs) == 0 || str(obj(msgs[0])["role"]) != "system" {
			return
		}
		marked := false
		parts := make([]any, 0, len(blocks))
		for _, b := range blocks {
			part := map[string]any{"type": "text", "text": b.Text}
			if cc := rawObject(b.CacheControl); cc != nil {
				part["cache_control"] = cc
				marked = true
			}
			parts = append(parts, part)
		}
		if marked {
			obj(msgs[0])["content"] = parts
			t.added("cache_control")
		}
	}
}

// RelayKit's usage conversion leaves out the cache counts.
func (t *Translation) cacheUsage() usage.Usage {
	if t.usage == nil {
		return usage.Usage{}
	}
	if u := t.usage.Usage(); u != nil {
		return *u
	}
	return usage.Usage{}
}

func (t *Translation) writeCacheUsage(u map[string]any) {
	cu := t.cacheUsage()
	if u == nil || cu.CacheWrite == 0 {
		return
	}
	details := func(name string) map[string]any {
		d := obj(u[name])
		if d == nil {
			d = map[string]any{}
			u[name] = d
		}
		return d
	}
	switch t.caller.shape {
	case shape.OpenAIChat:
		details("prompt_tokens_details")["cache_write_tokens"] = cu.CacheWrite
	case shape.OpenAIResponses:
		details("input_tokens_details")["cache_write_tokens"] = cu.CacheWrite
	case shape.AnthropicMessages:
		u["cache_creation_input_tokens"] = cu.CacheWrite
		u["cache_read_input_tokens"] = cu.CacheRead
		if _, ok := u["input_tokens"]; ok {
			u["input_tokens"] = max(cu.Input-cu.CacheRead-cu.CacheWrite, 0)
		}
	}
}
