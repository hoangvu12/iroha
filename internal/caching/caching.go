// Package caching follows what each Provider documents about its prompt
// cache (docs/research/prompt-caching.md, section 2):
//
//   - Anthropic's own API takes the automatic top-level cache_control;
//   - Moonshot/Kimi take only the top-level form (block markers get 400);
//   - DeepSeek ignores markers;
//   - OpenRouter and Alibaba (Qwen) honour markers on OpenAI Chat;
//   - Gemini's and Mistral's OpenAI APIs refuse fields they don't know.
package caching

import (
	"crypto/sha1"
	"fmt"
	"net/http"
	"strings"

	"github.com/hoangvu12/iroha/internal/hosts"
	"github.com/hoangvu12/iroha/internal/shape"
)

const (
	Default = ""
	On      = "on"
	Off     = "off"
)

func ValidSetting(v string) bool { return v == Default || v == On || v == Off }

type Settings struct {
	CacheMarkers       string `json:"cache_markers" enum:",on,off" doc:"Cache markers on requests translated to this Endpoint (prompt caching): \"\" Iroha's default for its Shape and host (see caching), on (markers whatever the host; caching.summary warns where the host refuses or ignores them), or off (none are sent). Same-Shape requests pass through untouched."`
	SendPromptCacheKey string `json:"send_prompt_cache_key" enum:",on,off" doc:"Whether requests to this Endpoint carry their conversation's ID (a UUID derived from it, scoped to the Gateway Key, Provider and model; never the Caller's raw session): on an OpenAI-shaped Endpoint a prompt_cache_key when the request has none, passthrough or translated (and user from an Anthropic Caller's metadata.user_id when translated); on every Endpoint the x-session-affinity, x-session-id and session_id headers the Caller did not send. \"\" Iroha's default (on, except no body field to hosts known to refuse unknown fields; they still get the headers), on, or off (nothing, headers included)."`
}

type SettingsPatch struct {
	CacheMarkers       *string `json:"cache_markers,omitempty" enum:",on,off" doc:"Cache markers on requests translated to this Endpoint: \"\" (default) Iroha's choice for its Shape and host, on, or off. Endpoint.caching shows the effect."`
	SendPromptCacheKey *string `json:"send_prompt_cache_key,omitempty" enum:",on,off" doc:"Send the conversation's derived ID: a prompt_cache_key to an OpenAI-shaped Endpoint on requests that have none (passthrough too), and session headers (x-session-affinity, x-session-id, session_id) to any Endpoint: \"\" (default) Iroha's choice, on, or off (neither)."`
}

// Apply sets the settings p carries, trimmed and lowercased; a value that
// is not "", on or off is an error naming the setting, and changes nothing.
func (s *Settings) Apply(p SettingsPatch) error {
	next := *s
	for _, f := range []struct {
		name    string
		in, out *string
	}{{"cache_markers", p.CacheMarkers, &next.CacheMarkers}, {"send_prompt_cache_key", p.SendPromptCacheKey, &next.SendPromptCacheKey}} {
		if f.in == nil {
			continue
		}
		v := strings.ToLower(strings.TrimSpace(*f.in))
		if !ValidSetting(v) {
			return fmt.Errorf("%s %q is not a value it takes", f.name, *f.in)
		}
		*f.out = v
	}
	*s = next
	return nil
}

type Markers string

const (
	// AsConverted: toward Anthropic no markers, toward OpenAI Chat the markers
	// of an Anthropic Caller's messages but not of its system prompt.
	AsConverted Markers = ""
	Strip       Markers = "strip"
	// Keep keeps the Caller's markers where the request still has them and
	// adds none. Anthropic takes at most 4: longer lifetimes are kept first.
	Keep Markers = "keep"
	// Blocks keeps the Caller's markers, and when it sent none marks the
	// last tool, the last system block and the last message.
	Blocks Markers = "blocks"
	// TopLevel keeps the Caller's markers, and when it sent none adds
	// Anthropic's automatic top-level cache_control.
	TopLevel Markers = "top_level"
	// TopOnly is for Endpoints that take only the top-level form: the
	// Caller's markers become one top-level marker with their longest
	// lifetime, or one is added.
	TopOnly Markers = "top_only"
)

// Policy is what one Endpoint's requests get. Markers and Fields apply to
// translated requests only; PromptCacheKey and SessionHeaders to every
// request that belongs to a conversation, passthrough included.
type Policy struct {
	Markers Markers
	// PromptCacheKey: send a prompt_cache_key derived from the conversation
	// when the request carries none.
	PromptCacheKey bool
	// SessionHeaders: the same derived value goes in SessionHeaderNames the
	// Caller did not send. Strict hosts refuse unknown body fields, not
	// headers, so they get these too.
	SessionHeaders bool
	// Fields: conversation fields are carried across Shapes (user,
	// safety_identifier, prompt_cache_key <-> Anthropic metadata.user_id).
	// A strict OpenAI host refuses user as it refuses prompt_cache_key.
	Fields bool
	Note   string
}

var (
	topLevelHosts  = []string{"anthropic.com"}
	topOnlyHosts   = []string{"moonshot.ai", "moonshot.cn", "kimi.com"}
	ignoreHosts    = []string{"deepseek.com"}
	chatHonourHost = []string{"openrouter.ai", "aliyuncs.com"}
	strictHosts    = []string{"googleapis.com", "mistral.ai"}
)

func For(sh shape.Shape, url string, s Settings) Policy {
	markers, promptCacheKey := s.CacheMarkers, s.SendPromptCacheKey
	host := hosts.Of(url)
	var p Policy
	switch sh {
	case shape.AnthropicMessages:
		switch {
		case markers == Off:
			p.Markers = Strip
		case markers == On:
			p.Markers = Blocks
			switch {
			case matches(host, topOnlyHosts):
				p.Note = "This host refuses cache markers other than one top-level cache_control, so with on its translated Requests may be refused (or, when the refusal names the field, asked again without markers); the default sends the top-level one."
			case matches(host, ignoreHosts):
				p.Note = "This host ignores cache markers (it caches on its own), so they change nothing there."
			}
		case matches(host, topOnlyHosts):
			p.Markers = TopOnly
		case matches(host, topLevelHosts):
			p.Markers = TopLevel
		case matches(host, ignoreHosts):
			p.Markers = Keep
		default:
			p.Markers = Blocks
		}
	case shape.OpenAIChat:
		switch {
		case markers == Off:
			p.Markers = Strip
		case markers == On || matches(host, chatHonourHost):
			p.Markers = Keep
		}
	}
	if sh == shape.OpenAIChat || sh == shape.OpenAIResponses {
		p.PromptCacheKey = promptCacheKey == On || (promptCacheKey == Default && !matches(host, strictHosts))
	}
	p.SessionHeaders = promptCacheKey != Off
	p.Fields = sh == shape.AnthropicMessages || p.PromptCacheKey
	return p
}

// SessionHeaderNames are the headers relays and Providers route a session
// by: x-session-affinity (Fireworks and others; Pi's default form),
// x-session-id (OpenRouter), session_id (Codex-style backends and relays
// built for them).
var SessionHeaderNames = []string{"x-session-affinity", "x-session-id", "session_id"}

// sameSlot are header spellings that fill the same slot: a Caller sending
// Codex's session-id is not also sent session_id.
var sameSlot = map[string][]string{"session_id": {"session-id"}}

// SetSessionHeaders puts v in each of SessionHeaderNames that h lacks; a
// header the Caller sent is left as it is. Nothing when v is "".
func SetSessionHeaders(h http.Header, v string) {
	if v == "" {
		return
	}
	for _, n := range SessionHeaderNames {
		if h.Get(n) != "" {
			continue
		}
		taken := false
		for _, alt := range sameSlot[n] {
			taken = taken || h.Get(alt) != ""
		}
		if !taken {
			h.Set(n, v)
		}
	}
}

func (p Policy) Describe(sh shape.Shape) string {
	var parts []string
	switch p.Markers {
	case Strip:
		parts = append(parts, "Cache markers are removed")
	case Keep:
		if sh == shape.OpenAIChat {
			parts = append(parts, "Cache markers an Anthropic Caller sends are kept, its system prompt's included")
		} else {
			parts = append(parts, "Callers' cache markers are kept; none are added (the Provider ignores them)")
		}
	case Blocks:
		parts = append(parts, "Callers' cache markers are kept; when there are none, the last tool, system block and message are marked")
	case TopLevel:
		parts = append(parts, "Callers' cache markers are kept; when there are none, Anthropic's automatic cache_control is added")
	case TopOnly:
		parts = append(parts, "One top-level cache_control is sent (the Provider takes no other form)")
	default:
		if sh == shape.OpenAIChat {
			parts = append(parts, "Cache markers of an Anthropic Caller's messages are kept, its system prompt's are not")
		}
	}
	if sh == shape.OpenAIChat || sh == shape.OpenAIResponses {
		if p.PromptCacheKey {
			parts = append(parts, "a prompt_cache_key made from the conversation is sent when the request has none, passthrough included")
		} else {
			parts = append(parts, "no prompt_cache_key is added")
		}
	}
	if p.SessionHeaders {
		parts = append(parts, "the conversation's ID goes in the x-session-affinity, x-session-id and session_id headers the Caller did not send")
	}
	s := "Nothing is added for the prompt cache."
	if len(parts) > 0 {
		s = strings.Join(parts, "; ")
		s = strings.ToUpper(s[:1]) + s[1:] + "."
	}
	if p.Note != "" {
		s += " " + p.Note
	}
	return s
}

func matches(host string, domains []string) bool { return hosts.Matches(host, domains...) }

var namespace = [16]byte{0x6f, 0x1c, 0x2b, 0x8e, 0x4d, 0x3a, 0x4e, 0x55, 0x9a, 0x0b, 0x6c, 0x2d, 0x1e, 0x7f, 0x30, 0x41}

// PromptCacheKey is a version 5 UUID, 36 characters, within OpenAI's 64-character
// limit on prompt_cache_key. "" when affinityValue is "".
func PromptCacheKey(affinityValue string) string {
	if affinityValue == "" {
		return ""
	}
	h := sha1.New()
	h.Write(namespace[:])
	h.Write([]byte(affinityValue))
	s := h.Sum(nil)
	s[6] = s[6]&0x0f | 0x50
	s[8] = s[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", s[0:4], s[4:6], s[6:8], s[8:10], s[10:16])
}
