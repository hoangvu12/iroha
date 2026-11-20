package translate

import (
	"encoding/json"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/hoangvu12/iroha/internal/shape"
)

// responsesCodec is OpenAI Responses.
//
// As the Caller's Shape, an answer always has the id resp_<Request ID>
// (buffered and streamed alike, so the Caller can find the Request), the
// Caller's model and the time the Request was served. A stream gets its own
// sequence_number on every event and the content_part events the SDKs'
// stream helpers need to accumulate a message.
//
// As the Endpoint's Shape, a request translated from another Shape is sent
// with store: false unless the Caller said otherwise: such a Caller cannot
// refer to a stored response later, so nothing is kept at the Provider.
var responsesCodec = &codec{
	shape:       shape.OpenAIResponses,
	format:      types.RelayFormatOpenAIResponses,
	request:     func() any { return &dto.OpenAIResponsesRequest{} },
	answer:      func() any { return &dto.OpenAIResponsesResponse{} },
	event:       func() any { return &dto.ResponsesStreamResponse{} },
	setModel:    func(req any, model string) { req.(*dto.OpenAIResponsesRequest).Model = model },
	streamID:    func(t *Translation) string { return "resp_" + t.o.ID },
	readFormat:  readResponsesFormat,
	writeFormat: writeResponsesFormat,

	prepareRequest: func(req map[string]any, t *Translation) {
		tools := list(req["tools"])
		for _, tool := range tools {
			if tool := obj(tool); namedResponsesTool(tool) {
				t.names.reserve(str(tool["name"]))
			}
		}
		for _, tool := range tools {
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
				// A Chat or Anthropic assistant turn holding only tool calls
				// converts to an empty assistant message before the calls.
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
			return upstreamEvent{feed: true} // the converter reports it
		}
		switch v.Type {
		case "error":
			if len(v.Error) > 0 && string(v.Error) != "null" { // an OpenAI envelope inside the event
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

	tidyAnswer: func(m map[string]any, t *Translation, u *dto.Usage) {
		tidyResponse(m, t, u)
	},

	newWriter: func(t *Translation, _ StreamOptions) streamWriter {
		return &responsesWriter{t: t, parts: map[string]bool{}}
	},
}

// namedResponsesTool reports whether a Responses tool or tool_choice names
// a tool the Caller defined (function or custom), whose name may need
// sanitising, as opposed to a built-in tool such as web_search.
func namedResponsesTool(tool map[string]any) bool {
	typ := str(tool["type"])
	return tool != nil && (typ == "function" || typ == "custom")
}

// responsesCall reports whether an input or output item calls a Caller's tool.
func responsesCall(item map[string]any) bool {
	typ := str(item["type"])
	return typ == "function_call" || typ == "custom_tool_call"
}

// responsesJunk are response fields RelayKit always writes, zero when the
// answer was converted from another Shape; they are dropped while zero,
// since the Caller's request, not the converter, knows their real values.
var responsesJunk = []string{"instructions", "max_output_tokens", "parallel_tool_calls", "previous_response_id",
	"reasoning", "store", "temperature", "tool_choice", "tools", "top_p", "truncation", "user", "metadata"}

// tidyResponse fixes a response object converted to Responses: Iroha's id,
// the Caller's model, the served time, clean usage, no zero-valued fields
// the conversion invented, and the Caller's tool names.
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

// tidyOutputItem drops the empty fields RelayKit writes on every output item
// (null content on a call, "" quality and size) and restores the Caller's
// tool name on a call.
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

// zero reports whether a JSON value is absent, null, false, 0, "" or empty.
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

// responsesUsage is a usage object as OpenAI Responses reports it, read from
// RelayKit's usage (which carries either the Responses or the Chat names).
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

// firstCount is the first non-zero token count among vs, else 0.
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

// responsesWriter writes Responses stream events with their event names.
// Every event gets the next sequence_number; every response object is
// tidied like a whole answer; message items get the content_part events the
// OpenAI SDKs' stream helpers accumulate text into (the converter does not
// write them); calls get the Caller's tool names back.
type responsesWriter struct {
	t   *Translation
	seq int
	// parts: message item id -> true when this writer announced its content
	// part (and so must close it), false when the converter did.
	parts map[string]bool
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
			w.parts[id] = true
			out = append(out, w.frame(map[string]any{"type": "response.content_part.added", "item_id": id, "output_index": m["output_index"],
				"content_index": 0, "part": map[string]any{"type": "output_text", "text": "", "annotations": []any{}}})...)
		}
		return out
	case "response.content_part.added":
		if id := str(m["item_id"]); !w.parts[id] {
			w.parts[id] = false
		}
	case "response.output_item.done":
		item := obj(m["item"])
		tidyOutputItem(item, w.t)
		if id := str(item["id"]); w.parts[id] {
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

// end: the converter's response.completed (or response.incomplete) closes
// a Responses stream; nothing follows it.
func (w *responsesWriter) end(*dto.Usage) []byte { return nil }
