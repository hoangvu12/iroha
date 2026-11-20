// Package caching decides what a translated request gets for the
// Provider's prompt cache (prompt caching 03): which cache markers, and
// whether a prompt_cache_key derived from the conversation is sent. It is
// pure. An Endpoint's two settings (cache_markers, send_prompt_cache_key:
// "" for Iroha's default, "on", "off") meet what each Provider documents,
// known by host like built-in Failure Rules and normalisers (research
// docs/research/prompt-caching.md, section 2):
//
//   - Anthropic's own API takes the automatic top-level cache_control;
//   - Moonshot/Kimi take only the top-level form (block markers get 400);
//   - DeepSeek ignores markers, so none are added;
//   - OpenRouter and Alibaba (Qwen) honour markers on OpenAI Chat;
//   - Gemini's and Mistral's OpenAI APIs refuse fields they don't know.
//
// Same-Shape passthrough never comes here: its body is the Caller's.
package caching

import (
	"crypto/sha1"
	"fmt"
	"strings"

	"github.com/hoangvu12/iroha/internal/hosts"
	"github.com/hoangvu12/iroha/internal/shape"
)

// Values of an Endpoint's cache_markers and send_prompt_cache_key. ""
// means Iroha's default for the Endpoint's Shape and host.
const (
	Default = ""
	On      = "on"
	Off     = "off"
)

// ValidSetting reports whether v is a value of either setting.
func ValidSetting(v string) bool { return v == Default || v == On || v == Off }

// Settings are an Endpoint's two prompt caching settings, as stored and
// shown (embedded in the Endpoint, its audit snapshot and the planner's
// Endpoint, so they travel together).
type Settings struct {
	CacheMarkers       string `json:"cache_markers" enum:",on,off" doc:"Cache markers on requests translated to this Endpoint (prompt caching): \"\" Iroha's default for its Shape and host (see caching), on (markers whatever the host; caching.summary warns where the host refuses or ignores them), or off (none are sent). Same-Shape requests pass through untouched."`
	SendPromptCacheKey string `json:"send_prompt_cache_key" enum:",on,off" doc:"Whether a request translated to this OpenAI-shaped Endpoint is sent a prompt_cache_key derived from its conversation (and user from an Anthropic Caller's metadata.user_id) when it has none: \"\" Iroha's default (on, except hosts known to refuse unknown fields), on, or off."`
}

// SettingsPatch is the settings of a create or update body: only those
// sent change.
type SettingsPatch struct {
	CacheMarkers       *string `json:"cache_markers,omitempty" enum:",on,off" doc:"Cache markers on requests translated to this Endpoint: \"\" (default) Iroha's choice for its Shape and host, on, or off. Endpoint.caching shows the effect."`
	SendPromptCacheKey *string `json:"send_prompt_cache_key,omitempty" enum:",on,off" doc:"Send an OpenAI-shaped Endpoint a prompt_cache_key derived from the conversation on translated requests that have none: \"\" (default) Iroha's choice, on, or off."`
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

// Markers is what a translated request's cache markers become.
type Markers string

const (
	// AsBefore leaves the conversion as it was before prompt caching 03:
	// toward Anthropic no markers, toward OpenAI Chat the markers of an
	// Anthropic Caller's messages but not of its system prompt.
	AsBefore Markers = ""
	// Strip removes every marker.
	Strip Markers = "strip"
	// Keep keeps the Caller's markers where the request still has them
	// (toward Anthropic: at most 4, longer lifetimes first) and adds none.
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

// Policy is what one Endpoint's translated requests get.
type Policy struct {
	Markers Markers
	// PromptCacheKey: an OpenAI Endpoint is sent a prompt_cache_key derived
	// from the conversation when the request carries none.
	PromptCacheKey bool
	// Fields: conversation fields are carried across Shapes (user,
	// safety_identifier, prompt_cache_key <-> Anthropic metadata.user_id).
	// Anthropic Endpoints always take metadata; OpenAI Endpoints follow
	// send_prompt_cache_key, since a strict one refuses user alike.
	Fields bool
	// Note warns when the Owner's setting goes against what the host is known
	// to do (markers on where they are refused or ignored); Describe adds it.
	Note string
}

// Hosts that decide a default (a domain matches itself and its subdomains).
var (
	topLevelHosts  = []string{"anthropic.com"}
	topOnlyHosts   = []string{"moonshot.ai", "moonshot.cn", "kimi.com"}
	ignoreHosts    = []string{"deepseek.com"}
	chatHonourHost = []string{"openrouter.ai", "aliyuncs.com"}
	strictHosts    = []string{"googleapis.com", "mistral.ai"}
)

// For is the policy of an Endpoint speaking sh at url with the Owner's
// settings s. Only the default
// follows the host; an explicit on or off is the Owner's and wins (on
// toward Anthropic is block markers, with a Note where the host refuses or
// ignores them).
func For(sh shape.Shape, url string, s Settings) Policy {
	markers, promptCacheKey := s.CacheMarkers, s.SendPromptCacheKey
	host := hosts.Of(url)
	var p Policy
	switch sh {
	case shape.AnthropicMessages:
		switch {
		case markers == Off:
			p.Markers = Strip
		case markers == On: // the Owner's on wins over what the host is known to do
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
	p.Fields = sh == shape.AnthropicMessages || p.PromptCacheKey
	return p
}

// Describe says in a sentence what p does, for the API and the UI.
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
			parts = append(parts, "a prompt_cache_key made from the conversation is sent when the request has none")
		} else {
			parts = append(parts, "no prompt_cache_key is added")
		}
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

// namespace is Iroha's UUID namespace for derived prompt_cache_keys.
var namespace = [16]byte{0x6f, 0x1c, 0x2b, 0x8e, 0x4d, 0x3a, 0x4e, 0x55, 0x9a, 0x0b, 0x6c, 0x2d, 0x1e, 0x7f, 0x30, 0x41}

// PromptCacheKey is the prompt_cache_key derived from an affinity value
// (affinity.Key: the conversation, its Caller, the Provider and the model),
// as CLIProxyAPI derives its own: a version 5 UUID, 36 characters, within
// OpenAI's 64. "" when there is no conversation.
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
