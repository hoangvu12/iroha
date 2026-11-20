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

// Prompt caching across Shapes (prompt caching 03). RelayKit drops cache
// markers and conversation fields between Shapes; this file puts back what
// the Endpoint can use, as the Gateway's caching.Policy for it says:
//
//   - toward Anthropic Messages: the markers a Chat Caller sends in
//     OpenRouter's style (on content parts, tools, the request), else
//     Iroha's own (the last tool, system block and message, or Anthropic's
//     automatic top-level one); never more than 4 (the earliest dropped),
//     never a 1 h marker after a 5 min one; and metadata.user_id from the
//     Caller's user, safety_identifier or prompt_cache_key;
//   - toward OpenAI Chat from Anthropic: the system prompt's markers where
//     the Endpoint honours them, or no markers at all;
//   - toward OpenAI Chat and Responses from Anthropic: the Caller's plain
//     metadata.user_id as user (Claude Code's session JSON is a session, not
//     a user);
//   - toward OpenAI Chat and Responses: a prompt_cache_key derived from the
//     conversation when the request carries none.
//
// The Caller's own markers are never moved or re-derived, only clamped and
// put in TTL order where Anthropic would otherwise refuse the request.

// Caching is what a Translation adds for the Provider's prompt cache. The
// zero value adds nothing: the conversion is as before prompt caching 03.
type Caching struct {
	Markers caching.Markers
	// Fields: carry the conversation fields across (user, safety_identifier,
	// prompt_cache_key <-> metadata.user_id).
	Fields bool
	// PromptCacheKey is sent to an OpenAI Endpoint whose request has none
	// (caching.PromptCacheKey of the conversation); "" sends none.
	PromptCacheKey string
}

// maxMarkers is Anthropic's limit of cache_control markers per request.
const maxMarkers = 4

// callerFields are the parts of the Caller's raw body this file reads,
// since RelayKit's request DTOs drop them.
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
	_ = json.Unmarshal(body, &f) // a field of another type reads as absent; decoding the DTO reports bad JSON
	return f
}

// refuseStored refuses what names state kept at the Provider, which no other
// Shape can refer to (Responses' stateful fields are refused by RelayKit).
func (t *Translation) refuseStored(f callerFields) error {
	if t.caller.shape == shape.Gemini && (rawString(f.CachedContent) != "" || rawString(f.CachedContent2) != "") {
		return &Error{
			Message: "cachedContent names a cache stored at Google, which an Endpoint speaking " + string(t.endpoint.shape) + " cannot read; translating the request would silently leave that context out.",
			Hint:    "Send the cached contents in the request itself (contents and systemInstruction), or ask for a model of a Provider with a Gemini Endpoint, where cachedContent passes through.",
		}
	}
	return nil
}

// applyCaching adds what t.o.Caching asks to the converted request m.
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

// userFromMetadata sends an Anthropic Caller's plain metadata.user_id as
// OpenAI's user (Chat and Responses), unless the request already has one.
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

// bounded is v, or its SHA-256 when longer than n bytes.
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

// rawObject is a raw JSON object as a map; nil for anything else.
func rawObject(raw json.RawMessage) map[string]any {
	var m map[string]any
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}

// --- Toward Anthropic Messages ---

// marker is one cache_control in an Anthropic request, in prompt order.
type marker struct {
	holder map[string]any // the block, tool or request holding it
	top    bool           // the request's automatic marker
}

func (mk marker) cc() map[string]any { return obj(mk.holder["cache_control"]) }

// anthropicMarkers sets the converted request's markers per policy p.
func (t *Translation) anthropicMarkers(m map[string]any, f callerFields, p caching.Markers) {
	if p == caching.AsBefore {
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

// anthropicMarkerList lists the markers of an Anthropic request in prompt
// order: tools, system, messages, then the top-level one.
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
			for _, inner := range list(obj(b)["content"]) { // a tool_result's content
				add(obj(inner))
			}
		}
	}
	if obj(m["cache_control"]) != nil {
		out = append(out, marker{holder: m, top: true})
	}
	return out
}

// clampMarkers keeps at most maxMarkers markers, dropping the earliest
// (the top-level one is kept: it moves with the conversation), then makes
// lifetimes non-increasing: Anthropic refuses a 1 h marker after a 5 min
// one, so such a marker becomes a 5 min one (the cheaper write).
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

// addBlockMarkers marks the last tool, the last system block and the last
// block of the last message that can hold a marker, as CLIProxyAPI and
// LiteLLM do for translated Callers.
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

// markable: Anthropic refuses a marker on thinking blocks and empty text.
func markable(b map[string]any) bool {
	switch str(b["type"]) {
	case "", "thinking", "redacted_thinking":
		return false
	case "text":
		return str(b["text"]) != ""
	}
	return true
}

// placeChatMarkers puts the cache_control a Chat Caller wrote in
// OpenRouter's style (on content parts, on tools, on the request) on the
// converted Anthropic request, which RelayKit leaves without them. A part's
// marker goes on the block holding its text: system and developer parts on
// the system block that took their text, the others on the first block, in
// order, with that text. A marker on a part with no text (an image) has no
// block to go to and is left out.
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

// cursor walks the blocks of the converted messages in order.
type cursor struct {
	msgs     []any
	msg, blk int
}

// find returns the next block (from the cursor on) whose text, or whose
// tool_result content, is text, and moves past it.
func (c *cursor) find(text string) map[string]any {
	for ; c.msg < len(c.msgs); c.msg, c.blk = c.msg+1, 0 {
		msg := obj(c.msgs[c.msg])
		if s, ok := msg["content"].(string); ok && s == text { // a string message: make it a block to mark
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

// --- Toward OpenAI Chat from Anthropic ---

// chatMarkers keeps (Keep) the markers of an Anthropic Caller's system
// blocks, which RelayKit flattens into one string, as text parts of the
// system message (OpenRouter and Qwen honour them there), or removes every
// marker (Strip). AsBefore leaves RelayKit's result: message parts keep
// theirs, the system prompt loses its.
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

// --- Cache writes reported to the Caller ---

// cacheUsage is the usage the Endpoint reported so far, in Iroha's one
// convention (internal/usage), for the cache counts RelayKit's usage
// conversion leaves out.
func (t *Translation) cacheUsage() usage.Usage {
	if t.usage == nil {
		return usage.Usage{}
	}
	if u := t.usage.Usage(); u != nil {
		return *u
	}
	return usage.Usage{}
}

// writeCacheUsage puts the cache writes the Endpoint reported in a usage
// object written in the Caller's Shape: OpenAI's cache_write_tokens for
// Chat (prompt_tokens_details) and Responses (input_tokens_details);
// Anthropic's cache_creation_input_tokens, input_tokens then being only the
// uncached part. Nothing changes when the Endpoint reported no writes.
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
