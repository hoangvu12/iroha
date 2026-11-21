package translate

import (
	"fmt"
	"strings"
)

// OpenAI and Anthropic accept only tool names matching ^[a-zA-Z0-9_-]{1,64}$.
const maxToolName = 64

type toolNames struct {
	orig  map[string]string
	taken map[string]bool
}

func newToolNames(declared ...string) toolNames {
	n := toolNames{taken: map[string]bool{}, orig: map[string]string{}}
	for _, name := range declared {
		if validToolName(name) {
			n.taken[name] = true
		}
	}
	return n
}

func (n *toolNames) safe(name string) string {
	if validToolName(name) {
		return name
	}
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

func rename(m map[string]any, key string, f func(string) string) {
	if s, ok := m[key].(string); ok && s != "" {
		m[key] = f(s)
	}
}
