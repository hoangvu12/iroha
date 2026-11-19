package translate

import (
	"fmt"
	"strings"
)

// Tool names. OpenAI and Anthropic both accept only ^[a-zA-Z0-9_-]{1,64}$,
// but Callers send names from MCP servers and OpenAPI specs such as
// "fs.read" or "mcp:git status", which some upstreams accept and others
// refuse. A request translated to another Shape gets safe names; the answer
// gets the Caller's names back (buffered and streamed tool calls alike), so
// the Caller never sees the change. Names already safe are left alone.

const maxToolName = 64

// toolNames remembers the names changed for one request.
type toolNames struct {
	orig  map[string]string // sanitised name -> the Caller's name
	taken map[string]bool   // names in use upstream
}

// reserve marks the Caller's names that are already safe, so no sanitised
// name collides with one of them. Call it with every name before safe.
func (n *toolNames) reserve(names ...string) {
	if n.taken == nil {
		n.taken, n.orig = map[string]bool{}, map[string]string{}
	}
	for _, name := range names {
		if validToolName(name) {
			n.taken[name] = true
		}
	}
}

// safe returns the name to send for the Caller's name, recording the change.
func (n *toolNames) safe(name string) string {
	if validToolName(name) {
		return name
	}
	n.reserve()
	for s, orig := range n.orig {
		if orig == name {
			return s
		}
	}
	base := sanitize(name)
	s := base
	for i := 2; n.taken[s]; i++ {
		suffix := fmt.Sprintf("_%d", i)
		s = base[:min(len(base), maxToolName-len(suffix))] + suffix
	}
	n.taken[s], n.orig[s] = true, name
	return s
}

// original returns the Caller's name for a name the upstream used.
func (n *toolNames) original(name string) string {
	if orig, ok := n.orig[name]; ok {
		return orig
	}
	return name
}

func validToolName(name string) bool {
	if name == "" || len(name) > maxToolName {
		return false
	}
	for _, r := range name {
		if !safeRune(r) {
			return false
		}
	}
	return true
}

func safeRune(r rune) bool {
	return r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-'
}

// sanitize replaces every unsafe character with _ and truncates.
func sanitize(name string) string {
	var b strings.Builder
	for _, r := range name {
		if safeRune(r) {
			b.WriteRune(r)
		} else {
			b.WriteByte('_')
		}
	}
	s := b.String()
	if len(s) > maxToolName {
		s = s[:maxToolName]
	}
	if s == "" {
		s = "tool"
	}
	return s
}

// rename applies f to the string at m[key], if there is one.
func rename(m map[string]any, key string, f func(string) string) {
	if s, ok := m[key].(string); ok && s != "" {
		m[key] = f(s)
	}
}
