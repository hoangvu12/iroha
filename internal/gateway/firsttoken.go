package gateway

import (
	"bytes"
	"encoding/json"
	"strings"

	"github.com/hoangvu12/iroha/internal/shape"
)

// The time to first token of a stream (requests.first_byte_ms) is when the
// first upstream event carrying generated content arrived: text, reasoning
// or a tool call. Comments, pings, role-only chunks, message_start and the
// like come before it. It is read in the Endpoint's Shape, so passthrough
// and translated streams measure the same thing. A stream with no such
// event falls back to its first event. The first-byte budget is not this:
// it ends when the upstream's headers arrive.

// tokenEvent reports whether one data payload of a stream in Shape sh
// carries generated content (shapeSpec.token).
func tokenEvent(sh shape.Shape, p []byte) bool {
	if len(p) == 0 || p[0] != '{' {
		return false
	}
	return specOf(sh).token(p)
}

// chatToken: a chunk whose delta holds content, reasoning, a refusal or tool
// calls (OpenAI Chat, and the relays speaking it).
func chatToken(p []byte) bool {
	if !bytes.Contains(p, []byte(`"delta"`)) {
		return false
	}
	var ev struct {
		Choices []struct {
			Delta struct {
				Content          json.RawMessage `json:"content"`
				ReasoningContent json.RawMessage `json:"reasoning_content"`
				Reasoning        json.RawMessage `json:"reasoning"`
				Refusal          json.RawMessage `json:"refusal"`
				ToolCalls        json.RawMessage `json:"tool_calls"`
			} `json:"delta"`
		} `json:"choices"`
	}
	if json.Unmarshal(p, &ev) != nil {
		return false
	}
	for _, c := range ev.Choices {
		d := c.Delta
		for _, v := range []json.RawMessage{d.Content, d.ReasoningContent, d.Reasoning, d.Refusal, d.ToolCalls} {
			if filled(v) {
				return true
			}
		}
	}
	return false
}

// anthropicToken: a content_block_delta (text, thinking, tool input), or the
// start of a tool-use block, which names the tool.
func anthropicToken(p []byte) bool {
	var ev struct {
		Type         string `json:"type"`
		ContentBlock struct {
			Type string `json:"type"`
		} `json:"content_block"`
	}
	if json.Unmarshal(p, &ev) != nil {
		return false
	}
	return ev.Type == "content_block_delta" || (ev.Type == "content_block_start" && strings.HasSuffix(ev.ContentBlock.Type, "tool_use"))
}

// responsesToken: any response.*.delta event (output text, reasoning,
// function call arguments, refusal).
func responsesToken(p []byte) bool {
	var ev struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(p, &ev) == nil && strings.HasPrefix(ev.Type, "response.") && strings.HasSuffix(ev.Type, ".delta")
}

// geminiToken: a chunk with a part holding text or a function call.
func geminiToken(p []byte) bool {
	var ev struct {
		Candidates []struct {
			Content struct {
				Parts []struct {
					Text         string          `json:"text"`
					FunctionCall json.RawMessage `json:"functionCall"`
				} `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
	}
	if json.Unmarshal(p, &ev) != nil {
		return false
	}
	for _, c := range ev.Candidates {
		for _, part := range c.Content.Parts {
			if part.Text != "" || filled(part.FunctionCall) {
				return true
			}
		}
	}
	return false
}

// filled reports whether a JSON value holds anything: not absent, null, an
// empty string, array or object.
func filled(v json.RawMessage) bool {
	switch string(bytes.TrimSpace(v)) {
	case "", "null", `""`, "[]", "{}":
		return false
	}
	return true
}
