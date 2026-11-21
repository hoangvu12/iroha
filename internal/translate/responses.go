package translate

import (
	"encoding/json"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/hoangvu12/iroha/internal/shape"
)

var responsesShape = shapeFormat{shape.OpenAIResponses, types.RelayFormatOpenAIResponses}

var responsesEndpoint = &endpointCodec{
	shapeFormat: responsesShape,
	answer:      func() any { return &dto.OpenAIResponsesResponse{} },
	event:       func() any { return &dto.ResponsesStreamResponse{} },
	writeFormat: writeResponsesFormat,

	declaredTools: func(req map[string]any) []string {
		var names []string
		for _, tool := range list(req["tools"]) {
			if tool := obj(tool); namedResponsesTool(tool) {
				names = append(names, str(tool["name"]))
			}
		}
		return names
	},

	prepareRequest: func(req map[string]any, t *Translation) {
		for _, tool := range list(req["tools"]) {
			if tool := obj(tool); namedResponsesTool(tool) {
				rename(tool, "name", t.names.safe)
			}
		}
		if input, ok := req["input"].([]any); ok {
			kept := input[:0]
			for _, item := range input {
				item := obj(item)
				if responsesCall(item) {
					rename(item, "name", t.names.safe)
				}
				// RelayKit converts an assistant turn holding only tool calls to an
				// empty assistant message before the calls.
				if str(item["role"]) == "assistant" && (item["type"] == nil || item["type"] == "message") && zero(item["content"]) {
					continue
				}
				kept = append(kept, item)
			}
			req["input"] = kept
		}
		if tc := obj(req["tool_choice"]); namedResponsesTool(tc) {
			rename(tc, "name", t.names.safe)
		}
		if _, ok := req["store"]; !ok {
			req["store"] = false
		}
	},

	upstream: func(data []byte) upstreamEvent {
		var v struct {
			Type     string `json:"type"`
			Code     any    `json:"code"`
			Message  string `json:"message"`
			Response struct {
				Error json.RawMessage `json:"error"`
			} `json:"response"`
			Error json.RawMessage `json:"error"`
		}
		if json.Unmarshal(data, &v) != nil {
			return upstreamEvent{feed: true}
		}
		switch v.Type {
		case "error":
			if len(v.Error) > 0 && string(v.Error) != "null" {
				return upstreamEvent{err: chatError(v.Error)}
			}
			code, _ := v.Code.(string)
			return upstreamEvent{err: &UpstreamError{Type: code, Message: v.Message}}
		case "response.failed":
			if len(v.Response.Error) > 0 && string(v.Response.Error) != "null" {
				return upstreamEvent{err: chatError(v.Response.Error)}
			}
			return upstreamEvent{err: &UpstreamError{Type: "response_failed", Message: "the response failed"}}
		case "response.completed", "response.incomplete", "response.done":
			return upstreamEvent{feed: true, complete: true}
		case "":
			if len(v.Error) > 0 && string(v.Error) != "null" {
				return upstreamEvent{err: chatError(v.Error)}
			}
		}
		return upstreamEvent{feed: true}
	},

	// RelayKit reads reasoning tokens from the Chat field of a Responses
	// usage only; the Provider reports them in output_tokens_details.
	fixUp: func(v any) {
		var u *dto.Usage
		switch v := v.(type) {
		case *dto.OpenAIResponsesResponse:
			u = v.Usage
		case *dto.ResponsesStreamResponse:
			if v.Response != nil {
				u = v.Response.Usage
			}
		}
		if u != nil && u.OutputTokensDetails != nil && u.CompletionTokenDetails.ReasoningTokens == 0 {
			u.CompletionTokenDetails.ReasoningTokens = u.OutputTokensDetails.ReasoningTokens
		}
	},
}

var responsesCaller = &callerCodec{
	shapeFormat: responsesShape,
	request:     func() any { return &dto.OpenAIResponsesRequest{} },
	setModel:    func(req any, model string) { req.(*dto.OpenAIResponsesRequest).Model = model },
	streamID:    func(t *Translation) string { return "resp_" + t.o.ID },
	readFormat:  readResponsesFormat,

	tidyAnswer: func(m map[string]any, t *Translation, u *dto.Usage) {
		tidyResponse(m, t, u)
	},

	newWriter: func(t *Translation, _ StreamOptions) streamWriter {
		return &responsesWriter{t: t, parts: map[string]partOpener{}}
	},
}

// Built-in Responses tools such as web_search have no name to sanitise.
func namedResponsesTool(tool map[string]any) bool {
	typ := str(tool["type"])
	return tool != nil && (typ == "function" || typ == "custom")
}

func responsesCall(item map[string]any) bool {
	typ := str(item["type"])
	return typ == "function_call" || typ == "custom_tool_call"
}

// RelayKit always writes these response fields, zero when it converted
// the answer from another Shape.
var responsesJunk = []string{"instructions", "max_output_tokens", "parallel_tool_calls", "previous_response_id",
	"reasoning", "store", "temperature", "tool_choice", "tools", "top_p", "truncation", "user", "metadata"}

func tidyResponse(r map[string]any, t *Translation, u *dto.Usage) {
	if r == nil {
		return
	}
	r["id"], r["object"], r["model"], r["created_at"] = "resp_"+t.o.ID, "response", t.o.Model, t.o.Now.Unix()
	for _, k := range responsesJunk {
		if zero(r[k]) {
			delete(r, k)
		}
	}
	for _, k := range []string{"error", "incomplete_details"} {
		if _, ok := r[k]; !ok {
			r[k] = nil
		}
	}
	switch um := obj(r["usage"]); {
	case um != nil:
		r["usage"] = responsesUsage(um)
	case u != nil:
		r["usage"] = responsesUsage(usageMap(u))
	}
	t.writeCacheUsage(obj(r["usage"]))
	if r["output"] == nil {
		r["output"] = []any{}
	}
	for _, item := range list(r["output"]) {
		tidyOutputItem(obj(item), t)
	}
}

// RelayKit writes null content on calls and empty quality, size and role
// on every output item.
func tidyOutputItem(item map[string]any, t *Translation) {
	if item == nil {
		return
	}
	for k, v := range item {
		if v == nil || v == "" && (k == "quality" || k == "size" || k == "role") {
			delete(item, k)
		}
	}
	if responsesCall(item) {
		rename(item, "name", t.names.original)
	}
}

func zero(v any) bool {
	switch v := v.(type) {
	case nil:
		return true
	case bool:
		return !v
	case string:
		return v == ""
	case json.Number:
		f, err := v.Float64()
		return err == nil && f == 0
	case float64:
		return v == 0
	case []any:
		return len(v) == 0
	case map[string]any:
		return len(v) == 0
	}
	return false
}

// RelayKit's usage carries either the Responses or the Chat names.
func responsesUsage(m map[string]any) map[string]any {
	in := firstCount(m["input_tokens"], m["prompt_tokens"])
	out := firstCount(m["output_tokens"], m["completion_tokens"])
	total := firstCount(m["total_tokens"])
	if total == 0 {
		total = in + out
	}
	return map[string]any{
		"input_tokens":          in,
		"input_tokens_details":  map[string]any{"cached_tokens": firstCount(obj(m["input_tokens_details"])["cached_tokens"], obj(m["prompt_tokens_details"])["cached_tokens"])},
		"output_tokens":         out,
		"output_tokens_details": map[string]any{"reasoning_tokens": firstCount(obj(m["output_tokens_details"])["reasoning_tokens"], obj(m["completion_tokens_details"])["reasoning_tokens"])},
		"total_tokens":          total,
	}
}

func firstCount(vs ...any) int64 {
	for _, v := range vs {
		var n int64
		switch v := v.(type) {
		case json.Number:
			n, _ = v.Int64()
		case float64:
			n = int64(v)
		}
		if n != 0 {
			return n
		}
	}
	return 0
}

// The OpenAI SDKs' stream helpers accumulate text from content_part
// events, which RelayKit does not write for message items.
type partOpener int

const (
	openedByConverter partOpener = iota + 1
	openedByWriter
)

type responsesWriter struct {
	t     *Translation
	seq   int
	parts map[string]partOpener
}

func (w *responsesWriter) write(m map[string]any) []byte {
	if p := obj(m["Payload"]); p != nil { // RelayKit's {Type, Payload} wrapper
		m = p
	}
	typ := str(m["type"])
	if typ == "" {
		return nil
	}
	var out []byte
	switch typ {
	case "response.created", "response.in_progress", "response.completed", "response.incomplete", "response.failed":
		tidyResponse(obj(m["response"]), w.t, nil)
	case "response.output_item.added":
		item := obj(m["item"])
		tidyOutputItem(item, w.t)
		out = w.frame(m)
		id := str(item["id"])
		if _, seen := w.parts[id]; str(item["type"]) == "message" && !seen && len(list(item["content"])) == 0 {
			w.parts[id] = openedByWriter
			out = append(out, w.frame(map[string]any{"type": "response.content_part.added", "item_id": id, "output_index": m["output_index"],
				"content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})...)
		}
		return out
	case "response.content_part.added":
		if id := str(m["item_id"]); w.parts[id] != openedByWriter {
			w.parts[id] = openedByConverter
		}
	case "response.output_item.done":
		item := obj(m["item"])
		tidyOutputItem(item, w.t)
		if id := str(item["id"]); w.parts[id] == openedByWriter {
			for i, part := range list(item["content"]) {
				out = append(out, w.frame(map[string]any{"type": "response.content_part.done", "item_id": id, "output_index": m["output_index"],
					"content_index": i, "part": part})...)
			}
		}
	case "response.function_call_arguments.done":
		rename(m, "name", w.t.names.original)
	}
	return append(out, w.frame(m)...)
}

func (w *responsesWriter) frame(m map[string]any) []byte {
	m["sequence_number"] = w.seq
	w.seq++
	b, _ := marshal(m)
	return append(append([]byte("event: "+str(m["type"])+"\ndata: "), b...), "\n\n"...)
}

func (w *responsesWriter) end(*dto.Usage) []byte { return nil }
