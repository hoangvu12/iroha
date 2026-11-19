// Package normalise rewrites the content of requests and answers for
// Provider quirks that a Failure Rule cannot express (ADR-0005): reasoning
// written inline as <think> text, non-standard content blocks, fields a
// Provider rejects on replayed turns, streams that end without a finish
// reason.
//
// Normalisers work in the Endpoint's Shape. Request normalisers run on the
// body sent to the Endpoint (the Caller's bytes on passthrough, the
// translated body otherwise); response normalisers run on the Endpoint's
// answer before it is passed through or translated, so both paths get them.
// A normaliser that finds nothing to change leaves the bytes exactly as
// they were: passthrough stays byte-preserving.
//
// Which normalisers apply to an Attempt follows from its Endpoint: the
// Shape it speaks and, for a quirk of one service's API, its host (the rule
// ticket 07 chose for built-in Failure Rules). Quirks of a model rather than
// a service (DeepSeek, Qwen and MiniMax writing <think> text, GLM's content
// blocks) apply on every host, since relays, OpenRouter and self-hosted
// servers pass them on unchanged; each such rewrite acts only when the
// non-standard construct is present.
package normalise

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/hoangvu12/iroha/internal/hosts"
	"github.com/hoangvu12/iroha/internal/shape"
)

// Sides a normaliser works on.
const (
	Request  = "request"
	Response = "response"
)

// Normaliser describes one built-in normaliser.
type Normaliser struct {
	Name        string      `json:"name"`
	Side        string      `json:"side" enum:"request,response" doc:"request: the body sent to the Endpoint; response: the Endpoint's answer, whole or streamed."`
	Shape       shape.Shape `json:"shape" doc:"The Endpoint Shape it applies to."`
	Host        string      `json:"host,omitempty" doc:"Endpoint hosts it is limited to (comma-separated, subdomains included); absent for every host."`
	Description string      `json:"description"`
	Cases       []string    `json:"cases" doc:"Cases of the v1 case catalog it covers."`
}

// Names of the built-in normalisers.
const (
	ChatReasoningTags  = "chat-reasoning-tags"
	ChatContentBlocks  = "chat-content-blocks"
	ChatVendorFields   = "chat-vendor-fields"
	ChatFinishReason   = "chat-finish-reason"
	ZaiFinishReasons   = "zai-finish-reasons"
	ChatReplayedFields = "chat-replayed-fields"
)

const hostZai = "z.ai,bigmodel.cn"

// Builtin are the normalisers that ship with Iroha.
var Builtin = []Normaliser{
	{
		Name: ChatReasoningTags, Side: Response, Shape: shape.OpenAIChat,
		Description: "Moves a <think>, <thinking> or <budget:thinking> block that opens the answer text into reasoning_content, whole or streamed (a tag split across chunks included), and blanks text that repeats the answer's own reasoning field. Answers that carry reasoning_content already are left alone.",
		Cases:       []string{"REQ-37", "REQ-85", "REQ-86", "REQ-87", "REQ-88"},
	},
	{
		Name: ChatContentBlocks, Side: Response, Shape: shape.OpenAIChat,
		Description: "Flattens a content array of thinking and text blocks (GLM) into text content plus reasoning_content, so the message is not empty to Callers and translation.",
		Cases:       []string{"REQ-24", "REQ-61"},
	},
	{
		Name: ChatVendorFields, Side: Response, Shape: shape.OpenAIChat,
		Description: "Drops audio_content and the name a model fills with its own brand (MiniMax) from messages and deltas; strict OpenAI SDKs reject them.",
		Cases:       []string{"REQ-23"},
	},
	{
		Name: ChatFinishReason, Side: Response, Shape: shape.OpenAIChat,
		Description: "Closes a stream the Provider ended ([DONE] or the end of its body) without a finish_reason: a last chunk with finish_reason stop (tool_calls after tool calls), then [DONE]. A stream that breaks off is still reported as broken.",
		Cases:       []string{},
	},
	{
		Name: ZaiFinishReasons, Side: Response, Shape: shape.OpenAIChat, Host: hostZai,
		Description: "Z.ai's own finish reasons: sensitive becomes content_filter, model_context_window_exceeded becomes length, and network_error (the answer failed midway) ends the Request with an error instead of a normal finish.",
		Cases:       []string{"FAIL-22"},
	},
	{
		Name: ChatReplayedFields, Side: Request, Shape: shape.OpenAIChat,
		Description: "Drops the id of a replayed message (an Anthropic message id); no Chat Provider reads it and strict ones (Mistral) answer 422 extra_forbidden, so every turn after the first would fail.",
		Cases:       []string{"REQ-53", "FAIL-33"},
	},
}

// Set is the normalisers that apply to one Endpoint.
type Set struct {
	shape shape.Shape
	on    map[string]bool
}

// For returns the normalisers applying to an Endpoint at endpointURL
// speaking sh.
func For(endpointURL string, sh shape.Shape) Set {
	s := Set{shape: sh}
	host := hosts.Of(endpointURL)
	for _, n := range Builtin {
		if n.Shape == sh && matchesHost(n.Host, host) {
			if s.on == nil {
				s.on = map[string]bool{}
			}
			s.on[n.Name] = true
		}
	}
	return s
}

// Applying lists the built-in normalisers that apply to an Endpoint.
func Applying(endpointURL string, sh shape.Shape) []Normaliser {
	var out []Normaliser
	host := hosts.Of(endpointURL)
	for _, n := range Builtin {
		if n.Shape == sh && matchesHost(n.Host, host) {
			out = append(out, n)
		}
	}
	return out
}

func (s Set) has(name string) bool { return s.on[name] }

// Empty reports whether no normaliser applies.
func (s Set) Empty() bool { return len(s.on) == 0 }

// Failure is a failure the Provider reported inside an answer it sent as a
// success (Z.ai's finish_reason network_error).
type Failure struct{ Message string }

func (f *Failure) Error() string { return f.Message }

// RequestBody returns the body to send to the Endpoint: body itself when no
// normaliser changes it.
func (s Set) RequestBody(body []byte) []byte {
	if s.shape != shape.OpenAIChat || !s.has(ChatReplayedFields) {
		return body
	}
	m, ok := decodeObject(body)
	if !ok {
		return body
	}
	changed := false
	for _, msg := range list(m["messages"]) {
		if msg := obj(msg); msg != nil {
			if _, ok := msg["id"]; ok {
				delete(msg, "id")
				changed = true
			}
		}
	}
	if !changed {
		return body
	}
	return encode(m, body)
}

// Body returns a whole answer for the Caller (or for translation): body
// itself when no normaliser changes it. A *Failure means the answer is a
// failure the Provider sent as a success.
func (s Set) Body(body []byte) ([]byte, error) {
	if s.shape != shape.OpenAIChat || s.Empty() {
		return body, nil
	}
	return s.chatBody(body)
}

// Stream returns the normaliser of one streamed answer, nil when none
// applies to streams.
func (s Set) Stream() *Stream {
	if s.shape != shape.OpenAIChat || s.Empty() {
		return nil
	}
	return &Stream{set: s, choices: map[int]*choiceState{}}
}

// matchesHost reports whether host is one of hosts (comma-separated) or a
// subdomain of one; an empty list matches every host.
func matchesHost(hosts, host string) bool {
	if strings.TrimSpace(hosts) == "" {
		return true
	}
	for _, d := range strings.Split(hosts, ",") {
		d = strings.ToLower(strings.TrimSpace(d))
		if d != "" && (host == d || strings.HasSuffix(host, "."+d)) {
			return true
		}
	}
	return false
}

// JSON helpers. Numbers are kept as written (json.Number), and encoding
// never escapes HTML characters, so a rewritten body differs from the
// original only where a normaliser changed it (and in key order).

func decodeObject(b []byte) (map[string]any, bool) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var m map[string]any
	if dec.Decode(&m) != nil || m == nil {
		return nil, false
	}
	return m, true
}

// encode marshals v; on failure (which a decoded value cannot cause) it
// returns orig.
func encode(v any, orig []byte) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if enc.Encode(v) != nil {
		return orig
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func list(v any) []any {
	l, _ := v.([]any)
	return l
}

func str(v any) string {
	s, _ := v.(string)
	return s
}
