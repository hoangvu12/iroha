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

type Source string

const (
	Header         Source = "header"
	ClaudeCode     Source = "claude_code"
	Codex          Source = "codex"
	SessionID      Source = "session_id"
	OpenCode       Source = "opencode"
	PromptCacheKey Source = "prompt_cache_key"
	Prefix         Source = "prefix"
	None           Source = "none"
)

var Sources = []Source{Header, ClaudeCode, Codex, SessionID, OpenCode, PromptCacheKey, Prefix, None}

const SessionHeader = "Iroha-Session"

const PrefixBytes = 4 << 10

const maxSession = 256

type Conversation struct {
	Source Source
	ID     string
}

func Identify(h http.Header, body []byte) Conversation {
	var b fields
	_ = json.Unmarshal(body, &b)

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

func (c Conversation) For(gatewayKeyID string) Conversation {
	if c.ID == "" {
		return c
	}
	return Conversation{Source: c.Source, ID: digest("caller", gatewayKeyID, c.ID)}
}

func (c Conversation) Control() bool {
	if c.ID == "" {
		return false
	}
	last := c.ID[len(c.ID)-1]
	return strings.IndexByte("13579bdf", last) >= 0
}

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

// Claude Code's older metadata.user_id is user_<hash>_account_<uuid>_session_<uuid>.
var legacyUserID = regexp.MustCompile(`_session_([A-Fa-f0-9-]+)$`)

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

func MetadataUserID(raw json.RawMessage) (user, sessionID string) {
	var inner struct {
		SessionID json.RawMessage `json:"session_id"`
	}
	u := strings.TrimSpace(str(raw))
	switch {
	case u == "":
		if json.Unmarshal(raw, &inner) == nil {
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

func str(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

type fields struct {
	Metadata           json.RawMessage `json:"metadata"`
	SessionID          json.RawMessage `json:"session_id"`
	PromptCacheKey     json.RawMessage `json:"prompt_cache_key"`
	Messages           json.RawMessage `json:"messages"`
	System             json.RawMessage `json:"system"`
	Instructions       json.RawMessage `json:"instructions"`
	Input              json.RawMessage `json:"input"`
	SystemInstruction  json.RawMessage `json:"systemInstruction"`
	SystemInstruction2 json.RawMessage `json:"system_instruction"`
	Contents           json.RawMessage `json:"contents"`
	Tools              json.RawMessage `json:"tools"`
}

type message struct {
	Type    string          `json:"type"`
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	Parts   json.RawMessage `json:"parts"`
}

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
	if user == "" {
		user = str(b.Input)
	}
	tools := cut(strings.Join(toolNames(b.Tools), "\n"))
	system, user = cut(system), cut(user)
	if system == "" && tools == "" && user == "" {
		return ""
	}
	return system + "\x00" + tools + "\x00" + user
}

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

func text(raw json.RawMessage) string {
	if s := str(raw); s != "" {
		return s
	}
	return parts(raw)
}

func parts(raw json.RawMessage) string {
	var ps []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &ps) != nil {
		var one struct {
			Parts json.RawMessage `json:"parts"`
		}
		if json.Unmarshal(raw, &one) == nil && len(one.Parts) > 0 {
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
