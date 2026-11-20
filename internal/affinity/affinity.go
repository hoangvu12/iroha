// Package affinity identifies the conversation a Request belongs to, so the
// planner can keep its turns on one Upstream Key (conversation affinity,
// prompt-caching ticket 02). It is pure: Identify reads what the Caller
// already sends (session headers of Iroha, Claude Code, Codex and OpenCode,
// a session in the body, prompt_cache_key) and falls back to a hash of the
// prompt's start. For scopes the conversation to one Gateway Key, Key to
// one Provider and model, so Callers never steer each other and Pool
// members rank their keys independently.
package affinity

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"unicode"
)

// Source says where a conversation's identity came from.
type Source string

// Sources, in the order Identify tries them.
const (
	Header         Source = "header"           // Iroha-Session
	ClaudeCode     Source = "claude_code"      // x-claude-code-session-id, or the session in metadata.user_id
	Codex          Source = "codex"            // session_id, session-id or thread-id header (Codex, pi and others send them)
	SessionID      Source = "session_id"       // x-session-id header, or session_id in the body
	OpenCode       Source = "opencode"         // x-session-affinity header (OpenCode, pi and others)
	PromptCacheKey Source = "prompt_cache_key" // the body's prompt_cache_key
	Prefix         Source = "prefix"           // hash of the system prompt, tool names and first user message
	None           Source = "none"             // nothing to go by (an empty prompt)
)

// Sources lists every Source, for enums and filters.
var Sources = []Source{Header, ClaudeCode, Codex, SessionID, OpenCode, PromptCacheKey, Prefix, None}

// SessionHeader is the header a Caller sends to name its conversation
// itself. Like every iroha- header it is never forwarded.
const SessionHeader = "Iroha-Session"

// PrefixBytes is how much of each part of the prompt's start the prefix
// hash reads: the system prompt, the tool names and the first user message.
const PrefixBytes = 4 << 10

// maxSession is the longest session value taken; a longer one is ignored.
const maxSession = 256

// Conversation is the conversation a Request belongs to.
type Conversation struct {
	Source Source
	// ID is a hex digest naming the conversation; "" when Source is None.
	// Session values are hashed alone, so one session sent in two places
	// (the Claude Code header and metadata.user_id) is one conversation.
	ID string
}

// Identify finds the conversation of a Caller's Request from its headers
// and body (any Shape). Plain user is never a session: it would put one
// person's parallel conversations on one key.
func Identify(h http.Header, body []byte) Conversation {
	var b fields
	_ = json.Unmarshal(body, &b) // a field of another type reads as absent

	if v := session(h.Get(SessionHeader)); v != "" {
		return sessionOf(Header, v)
	}
	if v := session(h.Get("X-Claude-Code-Session-Id")); v != "" {
		return sessionOf(ClaudeCode, v)
	}
	if v := claudeCodeSession(b.Metadata); v != "" {
		return sessionOf(ClaudeCode, v)
	}
	for _, name := range []string{"Session_id", "Session-Id", "Thread-Id", "Thread_id"} {
		if v := session(h.Get(name)); v != "" {
			return sessionOf(Codex, v)
		}
	}
	if v := session(h.Get("X-Session-Id")); v != "" {
		return sessionOf(SessionID, v)
	}
	if v := session(h.Get("X-Session-Affinity")); v != "" {
		return sessionOf(OpenCode, v)
	}
	if v := session(str(b.SessionID)); v != "" {
		return sessionOf(SessionID, v)
	}
	if v := session(str(b.PromptCacheKey)); v != "" {
		return sessionOf(PromptCacheKey, v)
	}
	if p := b.prefix(); p != "" {
		return Conversation{Source: Prefix, ID: digest("prefix", p)}
	}
	return Conversation{Source: None}
}

// For is c scoped to one Gateway Key (empty for test sends without one).
func (c Conversation) For(gatewayKeyID string) Conversation {
	if c.ID == "" {
		return c
	}
	return Conversation{Source: c.Source, ID: digest("caller", gatewayKeyID, c.ID)}
}

// Control reports whether the conversation falls in the experiment's
// round-robin half (affinity.experiment half): about one in two do.
func (c Conversation) Control() bool {
	if c.ID == "" {
		return false
	}
	last := c.ID[len(c.ID)-1]
	return strings.IndexByte("13579bdf", last) >= 0
}

// Key is the affinity value of a conversation (scoped to its Caller) on
// one Provider and model: what the planner ranks that Provider's keys by,
// and what a derived prompt_cache_key is made from. "" when there is no
// conversation.
func Key(conversation, providerID, model string) string {
	if conversation == "" {
		return ""
	}
	return digest("key", conversation, providerID, model)
}

func digest(kind string, parts ...string) string {
	h := sha256.New()
	h.Write([]byte("iroha-affinity-v1\x00" + kind))
	for _, p := range parts {
		h.Write([]byte{0})
		h.Write([]byte(p))
	}
	return hex.EncodeToString(h.Sum(nil))
}

func sessionOf(s Source, v string) Conversation {
	return Conversation{Source: s, ID: digest("session", v)}
}

// session is a usable session value: trimmed, printable, at most 256 bytes.
func session(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || len(v) > maxSession {
		return ""
	}
	for _, r := range v {
		if unicode.IsControl(r) {
			return ""
		}
	}
	return v
}

// legacyUserID is Claude Code's older metadata.user_id:
// user_<hash>_account_<uuid>_session_<uuid>.
var legacyUserID = regexp.MustCompile(`_session_([A-Fa-f0-9-]+)$`)

// claudeCodeSession is the session inside Claude Code's metadata.user_id.
func claudeCodeSession(metadata json.RawMessage) string {
	var m struct {
		UserID json.RawMessage `json:"user_id"`
	}
	if json.Unmarshal(metadata, &m) != nil {
		return ""
	}
	_, s := MetadataUserID(m.UserID)
	return s
}

// MetadataUserID reads an Anthropic metadata.user_id (raw JSON): either
// Claude Code's value, which names a session (its JSON form, a string
// holding {"session_id": ...}, or the legacy
// user_<hash>_account_<uuid>_session_<uuid>; an object with session_id from
// some Callers), or a plain user. At most one of user and sessionID is set;
// neither when the value is empty, of another type, or Claude Code's form
// without a usable session. Translation sends only a plain user on.
func MetadataUserID(raw json.RawMessage) (user, sessionID string) {
	var inner struct {
		SessionID json.RawMessage `json:"session_id"`
	}
	u := strings.TrimSpace(str(raw))
	switch {
	case u == "":
		if json.Unmarshal(raw, &inner) == nil { // an object, from some Callers
			return "", session(str(inner.SessionID))
		}
		return "", ""
	case strings.HasPrefix(u, "{"):
		if json.Unmarshal([]byte(u), &inner) == nil {
			return "", session(str(inner.SessionID))
		}
		return "", ""
	case strings.Contains(u, "_session_"):
		if s := legacyUserID.FindStringSubmatch(u); s != nil {
			return "", session(s[1])
		}
		return "", ""
	}
	return u, ""
}

// str is a JSON string's value; "" for anything else.
func str(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

// fields are the parts of a body, in any Shape, that identify a
// conversation. Each is read on its own, so one of an unexpected type
// leaves the others usable.
type fields struct {
	Metadata       json.RawMessage `json:"metadata"`
	SessionID      json.RawMessage `json:"session_id"`
	PromptCacheKey json.RawMessage `json:"prompt_cache_key"`
	// The prompt's start: Chat and Anthropic messages, Anthropic system,
	// Responses instructions and input, Gemini systemInstruction and contents.
	Messages           json.RawMessage `json:"messages"`
	System             json.RawMessage `json:"system"`
	Instructions       json.RawMessage `json:"instructions"`
	Input              json.RawMessage `json:"input"`
	SystemInstruction  json.RawMessage `json:"systemInstruction"`
	SystemInstruction2 json.RawMessage `json:"system_instruction"`
	Contents           json.RawMessage `json:"contents"`
	Tools              json.RawMessage `json:"tools"`
}

// message is one turn in messages, input or contents.
type message struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Parts   json.RawMessage `json:"parts"`
}

// prefix is the prompt's start as one string: the system prompt, the tool
// names and the first user message, each cut at PrefixBytes; "" when all
// three are empty (an empty prefix would put every such Request in one
// conversation).
func (b fields) prefix() string {
	turns := b.turns()
	system := firstText(text(b.System), text(b.Instructions), parts(b.SystemInstruction), parts(b.SystemInstruction2))
	var user string
	for _, m := range turns {
		r := strings.ToLower(m.Role)
		if system == "" && (r == "system" || r == "developer") {
			system = firstText(text(m.Content), parts(m.Parts))
		}
		if user == "" && (r == "user" || (r == "" && m.Type == "" && len(m.Parts) > 0)) {
			user = firstText(text(m.Content), parts(m.Parts))
		}
	}
	if user == "" { // Responses input as a plain string
		user = str(b.Input)
	}
	tools := cut(strings.Join(toolNames(b.Tools), "\n"))
	system, user = cut(system), cut(user)
	if system == "" && tools == "" && user == "" {
		return ""
	}
	return system + "\x00" + tools + "\x00" + user
}

// turns are the conversation's messages in whichever field the Shape uses.
func (b fields) turns() []message {
	for _, raw := range []json.RawMessage{b.Messages, b.Input, b.Contents} {
		var ms []message
		if json.Unmarshal(raw, &ms) == nil && len(ms) > 0 {
			return ms
		}
	}
	return nil
}

func firstText(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func cut(s string) string {
	if len(s) > PrefixBytes {
		return s[:PrefixBytes]
	}
	return s
}

// text is the text of a content value: a string, or the text of its
// parts (cache markers and other part fields are left out, since Callers
// move them between turns).
func text(raw json.RawMessage) string {
	if s := str(raw); s != "" {
		return s
	}
	return parts(raw)
}

// parts is the text of a list of content parts (Chat, Anthropic, Responses
// and Gemini parts all carry it in text); a part without text counts by its
// type, so an image-only message is not empty. It stops after PrefixBytes.
func parts(raw json.RawMessage) string {
	var ps []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &ps) != nil {
		var one struct {
			Parts json.RawMessage `json:"parts"`
		}
		if json.Unmarshal(raw, &one) == nil && len(one.Parts) > 0 { // Gemini systemInstruction
			return parts(one.Parts)
		}
		return ""
	}
	var sb strings.Builder
	for _, p := range ps {
		if sb.Len() > PrefixBytes {
			break
		}
		switch {
		case p.Text != "":
			sb.WriteString(p.Text)
		case p.Type != "":
			sb.WriteString("[" + p.Type + "]")
		}
		sb.WriteByte('\n')
	}
	return strings.TrimRight(sb.String(), "\n")
}

// toolNames lists the tools' names: Chat function.name, Anthropic and
// Responses name, Gemini functionDeclarations[].name.
func toolNames(raw json.RawMessage) []string {
	var tools []struct {
		Name     string `json:"name"`
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
		Decls  []struct{ Name string } `json:"functionDeclarations"`
		Decls2 []struct{ Name string } `json:"function_declarations"`
	}
	if json.Unmarshal(raw, &tools) != nil {
		return nil
	}
	var out []string
	for _, t := range tools {
		if t.Name != "" {
			out = append(out, t.Name)
		}
		if t.Function.Name != "" {
			out = append(out, t.Function.Name)
		}
		for _, d := range append(t.Decls, t.Decls2...) {
			out = append(out, d.Name)
		}
	}
	return out
}
