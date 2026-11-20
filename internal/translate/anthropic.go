package translate

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/hoangvu12/iroha/internal/shape"
)

// anthropicCodec is Anthropic Messages.
var anthropicCodec = &codec{
	shape:       shape.AnthropicMessages,
	format:      types.RelayFormatClaude,
	request:     func() any { return &dto.ClaudeRequest{} },
	answer:      func() any { return &dto.ClaudeResponse{} },
	event:       func() any { return &dto.ClaudeResponse{} },
	setModel:    func(req any, model string) { req.(*dto.ClaudeRequest).Model = model },
	readFormat:  readAnthropicFormat,
	writeFormat: writeAnthropicFormat,
	rewrite:     searchResultsAsText,

	prepareRequest: func(req map[string]any, t *Translation) {
		tools := list(req["tools"])
		for _, tool := range tools {
			if isCustomTool(obj(tool)) {
				t.names.reserve(str(obj(tool)["name"]))
			}
		}
		for _, tool := range tools {
			if tool := obj(tool); isCustomTool(tool) {
				rename(tool, "name", t.names.safe)
			}
		}
		if tc := obj(req["tool_choice"]); str(tc["type"]) == "tool" {
			rename(tc, "name", t.names.safe)
		}
		for _, msg := range list(req["messages"]) {
			for _, block := range list(obj(msg)["content"]) {
				block := obj(block)
				if str(block["type"]) == "tool_use" {
					rename(block, "name", t.names.safe)
				}
				urlSources(block)
				for _, inner := range list(block["content"]) { // a tool_result's content
					urlSources(obj(inner))
				}
			}
		}
	},

	upstream: func(data []byte) upstreamEvent {
		var v struct {
			Type  string `json:"type"`
			Delta struct {
				StopReason *string `json:"stop_reason"`
			} `json:"delta"`
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(data, &v) != nil {
			return upstreamEvent{feed: true} // the converter reports it
		}
		switch v.Type {
		case "ping":
			return upstreamEvent{}
		case "error":
			return upstreamEvent{err: &UpstreamError{Type: v.Error.Type, Message: v.Error.Message}}
		case "message_stop":
			return upstreamEvent{feed: true, complete: true}
		case "message_delta":
			return upstreamEvent{feed: true, complete: v.Delta.StopReason != nil && *v.Delta.StopReason != ""}
		}
		return upstreamEvent{feed: true}
	},

	tidyAnswer: func(m map[string]any, t *Translation, _ *dto.Usage) {
		m["model"] = t.o.Model
		if str(m["id"]) == "" {
			m["id"] = "msg_" + t.o.ID
		}
		if u := obj(m["usage"]); u != nil {
			m["usage"] = anthropicUsage(u)
		}
		if _, ok := m["stop_sequence"]; !ok {
			m["stop_sequence"] = nil
		}
		m["stop_reason"] = knownReason(m["stop_reason"], anthropicStopReasons, "end_turn")
		for i, block := range list(m["content"]) {
			if block := obj(block); str(block["type"]) == "tool_use" {
				rename(block, "name", t.names.original)
				if str(block["id"]) == "" { // the Caller answers a tool call by its id
					block["id"] = fmt.Sprintf("toolu_%s_%d", t.o.ID, i)
				}
			}
		}
	},

	newWriter: func(t *Translation, _ StreamOptions) streamWriter { return &anthropicWriter{t: t} },
}

// isCustomTool reports whether an Anthropic tool is one the Caller defined
// (no type, or "custom"), as opposed to a server tool whose name is fixed.
func isCustomTool(tool map[string]any) bool {
	typ := str(tool["type"])
	return tool != nil && (typ == "" || typ == "custom")
}

// urlSources turns a URL carried through RelayKit (media.go) back into an
// Anthropic URL source.
func urlSources(block map[string]any) {
	src := obj(block["source"])
	if src == nil || str(src["type"]) != "base64" {
		return
	}
	if u, ok := urlFromMarker(str(src["data"])); ok {
		block["source"] = map[string]any{"type": "url", "url": u}
	}
}

// searchResultsAsText turns every search_result block of an Anthropic
// request (in a message or in a tool_result's content) into a text block
// naming its title and source, ahead of its text: RelayKit's request DTO
// cannot hold the block (its source is a string), and no other Shape has
// one, but the model should still read the RAG context. Citations of it
// exist only in Anthropic answers, so nothing is lost there. Only the
// messages are re-encoded; the rest of the body keeps its bytes.
func searchResultsAsText(body []byte) []byte {
	if !bytes.Contains(body, []byte(`"search_result"`)) {
		return body
	}
	var top map[string]json.RawMessage
	if json.Unmarshal(body, &top) != nil {
		return body // decoding reports it
	}
	dec := json.NewDecoder(bytes.NewReader(top["messages"]))
	dec.UseNumber()
	var msgs []any
	if dec.Decode(&msgs) != nil {
		return body
	}
	changed := false
	textOf := func(blocks []any) {
		for i, b := range blocks {
			if b := obj(b); str(b["type"]) == "search_result" {
				blocks[i] = searchResultText(b)
				changed = true
			}
		}
	}
	for _, msg := range msgs {
		blocks := list(obj(msg)["content"])
		textOf(blocks)
		for _, b := range blocks {
			if b := obj(b); str(b["type"]) == "tool_result" {
				textOf(list(b["content"]))
			}
		}
	}
	if !changed {
		return body
	}
	raw, err := marshal(msgs)
	if err != nil {
		return body
	}
	top["messages"] = raw
	out, err := marshal(top)
	if err != nil {
		return body
	}
	return out
}

func searchResultText(b map[string]any) map[string]any {
	var head, texts []string
	if t := str(b["title"]); t != "" {
		head = append(head, "Search result: "+t)
	} else {
		head = append(head, "Search result")
	}
	if s := str(b["source"]); s != "" {
		head = append(head, "Source: "+s)
	}
	for _, c := range list(b["content"]) {
		if t := str(obj(c)["text"]); t != "" {
			texts = append(texts, t)
		}
	}
	text := strings.Join(head, "\n")
	if len(texts) > 0 {
		text += "\n\n" + strings.Join(texts, "\n\n")
	}
	out := map[string]any{"type": "text", "text": text}
	if cc, ok := b["cache_control"]; ok {
		out["cache_control"] = cc
	}
	return out
}

// anthropicStopReasons are the stop reasons Anthropic's SDKs know.
var anthropicStopReasons = map[string]bool{"end_turn": true, "max_tokens": true, "stop_sequence": true, "tool_use": true,
	"pause_turn": true, "refusal": true, "model_context_window_exceeded": true}

// knownReason is a stop or finish reason the Caller's Shape knows: another
// Shape's reason the converter passed on unmapped becomes def. Absent (nil)
// stays absent.
func knownReason(v any, known map[string]bool, def string) any {
	if s, ok := v.(string); ok && !known[s] {
		return def
	}
	return v
}

// anthropicUsage is a usage object as Anthropic reports it, without
// new-api's billing fields.
func anthropicUsage(u map[string]any) map[string]any {
	return pick(u, "input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
}

// anthropicWriter writes Anthropic events with their event names, naming
// the Caller's model in message_start.
type anthropicWriter struct{ t *Translation }

func (w *anthropicWriter) write(m map[string]any) []byte {
	typ := str(m["type"])
	switch typ {
	case "message_start":
		msg := obj(m["message"])
		if msg == nil {
			break
		}
		msg["model"] = w.t.o.Model
		if str(msg["id"]) == "" {
			msg["id"] = "msg_" + w.t.o.ID
		}
		for _, k := range []string{"stop_reason", "stop_sequence"} {
			if _, ok := msg[k]; !ok {
				msg[k] = nil
			}
		}
		if msg["content"] == nil {
			msg["content"] = []any{}
		}
		msg["usage"] = anthropicUsage(obj(msg["usage"]))
	case "message_delta":
		// The SDKs read usage.output_tokens from every message_delta, so it
		// is there even when the upstream reported no usage.
		u := anthropicUsage(obj(m["usage"]))
		if _, ok := u["output_tokens"]; !ok {
			u["output_tokens"] = 0
		}
		w.t.writeCacheUsage(u)
		m["usage"] = u
		if d := obj(m["delta"]); d != nil {
			if _, ok := d["stop_sequence"]; !ok {
				d["stop_sequence"] = nil
			}
			d["stop_reason"] = knownReason(d["stop_reason"], anthropicStopReasons, "end_turn")
		}
	case "content_block_start":
		if cb := obj(m["content_block"]); str(cb["type"]) == "tool_use" {
			rename(cb, "name", w.t.names.original)
		}
	}
	b, _ := marshal(m)
	return append(append([]byte("event: "+typ+"\ndata: "), b...), "\n\n"...)
}

func (w *anthropicWriter) end(*dto.Usage) []byte { return nil }
