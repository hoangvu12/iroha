package testkit

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/hoangvu12/iroha/internal/shape"
)

// Shape-aware Responders. Each writes the realistic body of the fake's
// Shape, echoing the model the request named.

// Text replies with a complete answer. If the request asked for a stream,
// the text is streamed in that Shape's stream format (one chunk per word).
func (u *Upstream) Text(text string) Responder { return u.text(text) }

// Stream replies with a stream of the given text pieces, whether or not the
// request asked for one. Use the Chunk-level fields of Reply for pauses.
func (u *Upstream) Stream(pieces ...string) Responder {
	return func(r *Received) Reply { return u.streamReply(r, pieces) }
}

// Error replies with status and the Shape's error envelope.
func (u *Upstream) Error(status int, message string) Responder {
	return u.errorReply(status, "", message)
}

// ErrorCode is Error with a provider error code (OpenAI "code", Anthropic
// error "type", Gemini "status").
func (u *Upstream) ErrorCode(status int, code, message string) Responder {
	return u.errorReply(status, code, message)
}

func (u *Upstream) text(text string) Responder {
	return func(r *Received) Reply {
		if r.Stream {
			return u.streamReply(r, splitWords(text))
		}
		return u.completeReply(r, text)
	}
}

func (u *Upstream) currentUsage() Usage {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.usage
}

func splitWords(text string) []string {
	var out []string
	start := 0
	for i := 1; i < len(text); i++ {
		if text[i] == ' ' {
			out = append(out, text[start:i])
			start = i
		}
	}
	return append(out, text[start:])
}

func (u *Upstream) completeReply(r *Received, text string) Reply {
	us := u.currentUsage()
	id := fmt.Sprintf("fake-%d", r.Seq)
	var body any
	switch u.Shape {
	case shape.OpenAIChat:
		body = map[string]any{
			"id": "chatcmpl-" + id, "object": "chat.completion", "created": 1767225600, "model": r.Model,
			"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": text}, "finish_reason": "stop"}},
			"usage":   map[string]any{"prompt_tokens": us.Input, "completion_tokens": us.Output, "total_tokens": us.Input + us.Output},
		}
	case shape.OpenAIResponses:
		body = responsesObject(id, r.Model, "completed", text, us)
	case shape.AnthropicMessages:
		body = map[string]any{
			"id": "msg_" + id, "type": "message", "role": "assistant", "model": r.Model,
			"content":     []any{map[string]any{"type": "text", "text": text}},
			"stop_reason": "end_turn", "stop_sequence": nil,
			"usage": map[string]any{"input_tokens": us.Input, "output_tokens": us.Output},
		}
	case shape.Gemini:
		body = geminiChunk(r.Model, text, "STOP", &us)
	}
	return Reply{Status: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: []byte(compactJSON(body))}
}

func responsesObject(id, model, status, text string, us Usage) map[string]any {
	output := []any{}
	if status == "completed" {
		output = append(output, map[string]any{
			"type": "message", "id": "msg_" + id, "role": "assistant", "status": "completed",
			"content": []any{map[string]any{"type": "output_text", "text": text, "annotations": []any{}}},
		})
	}
	obj := map[string]any{"id": "resp_" + id, "object": "response", "created_at": 1767225600, "status": status, "model": model, "output": output}
	if status == "completed" {
		obj["usage"] = map[string]any{"input_tokens": us.Input, "output_tokens": us.Output, "total_tokens": us.Input + us.Output}
	}
	return obj
}

func geminiChunk(model, text, finish string, us *Usage) map[string]any {
	cand := map[string]any{"content": map[string]any{"role": "model", "parts": []any{map[string]any{"text": text}}}, "index": 0}
	if finish != "" {
		cand["finishReason"] = finish
	}
	out := map[string]any{"candidates": []any{cand}, "modelVersion": model}
	if us != nil {
		out["usageMetadata"] = map[string]any{"promptTokenCount": us.Input, "candidatesTokenCount": us.Output, "totalTokenCount": us.Input + us.Output}
	}
	return out
}

func sse(event string, data any) string {
	var b strings.Builder
	if event != "" {
		b.WriteString("event: " + event + "\n")
	}
	if s, ok := data.(string); ok {
		b.WriteString("data: " + s + "\n\n")
	} else {
		b.WriteString("data: " + compactJSON(data) + "\n\n")
	}
	return b.String()
}

func (u *Upstream) streamReply(r *Received, pieces []string) Reply {
	us := u.currentUsage()
	id := fmt.Sprintf("fake-%d", r.Seq)
	var events []string
	switch u.Shape {
	case shape.OpenAIChat:
		chunk := func(delta map[string]any, finish any) map[string]any {
			return map[string]any{"id": "chatcmpl-" + id, "object": "chat.completion.chunk", "created": 1767225600, "model": r.Model,
				"choices": []any{map[string]any{"index": 0, "delta": delta, "finish_reason": finish}}}
		}
		events = append(events, sse("", chunk(map[string]any{"role": "assistant", "content": ""}, nil)))
		for _, p := range pieces {
			events = append(events, sse("", chunk(map[string]any{"content": p}, nil)))
		}
		events = append(events, sse("", chunk(map[string]any{}, "stop")))
		var req struct {
			StreamOptions struct {
				IncludeUsage bool `json:"include_usage"`
			} `json:"stream_options"`
		}
		_ = json.Unmarshal(r.Body, &req)
		if req.StreamOptions.IncludeUsage { // like OpenAI, usage only when asked for
			events = append(events, sse("", map[string]any{"id": "chatcmpl-" + id, "object": "chat.completion.chunk", "created": 1767225600, "model": r.Model,
				"choices": []any{}, "usage": map[string]any{"prompt_tokens": us.Input, "completion_tokens": us.Output, "total_tokens": us.Input + us.Output}}))
		}
		events = append(events, sse("", "[DONE]"))
	case shape.OpenAIResponses:
		seq := 0
		ev := func(typ string, fields map[string]any) string {
			fields["type"] = typ
			fields["sequence_number"] = seq
			seq++
			return sse(typ, fields)
		}
		events = append(events, ev("response.created", map[string]any{"response": responsesObject(id, r.Model, "in_progress", "", us)}))
		for _, p := range pieces {
			events = append(events, ev("response.output_text.delta", map[string]any{"item_id": "msg_" + id, "output_index": 0, "content_index": 0, "delta": p}))
		}
		events = append(events, ev("response.completed", map[string]any{"response": responsesObject(id, r.Model, "completed", strings.Join(pieces, ""), us)}))
	case shape.AnthropicMessages:
		events = append(events,
			sse("message_start", map[string]any{"type": "message_start", "message": map[string]any{
				"id": "msg_" + id, "type": "message", "role": "assistant", "model": r.Model, "content": []any{},
				"stop_reason": nil, "stop_sequence": nil, "usage": map[string]any{"input_tokens": us.Input, "output_tokens": 1}}}),
			sse("content_block_start", map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text", "text": ""}}),
		)
		for _, p := range pieces {
			events = append(events, sse("content_block_delta", map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": p}}))
		}
		events = append(events,
			sse("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0}),
			sse("message_delta", map[string]any{"type": "message_delta", "delta": map[string]any{"stop_reason": "end_turn", "stop_sequence": nil}, "usage": map[string]any{"output_tokens": us.Output}}),
			sse("message_stop", map[string]any{"type": "message_stop"}),
		)
	case shape.Gemini:
		sseMode := r.Query.Get("alt") == "sse"
		var parts []string
		for i, p := range pieces {
			var c map[string]any
			if i == len(pieces)-1 {
				c = geminiChunk(r.Model, p, "STOP", &us)
			} else {
				c = geminiChunk(r.Model, p, "", nil)
			}
			if sseMode {
				parts = append(parts, sse("", c))
			} else {
				parts = append(parts, compactJSON(c))
			}
		}
		if sseMode {
			events = parts
		} else { // without alt=sse Gemini streams one JSON array
			for i, p := range parts {
				switch {
				case i == 0 && len(parts) == 1:
					events = append(events, "["+p+"]")
				case i == 0:
					events = append(events, "["+p)
				case i == len(parts)-1:
					events = append(events, ",\n"+p+"]")
				default:
					events = append(events, ",\n"+p)
				}
			}
			rep := SSE(events...)(r)
			rep.Header.Set("Content-Type", "application/json")
			return rep
		}
	}
	return SSE(events...)(r)
}

func (u *Upstream) errorReply(status int, code, message string) Responder {
	return func(r *Received) Reply {
		var body any
		switch u.Shape {
		case shape.AnthropicMessages:
			if code == "" {
				code = anthropicErrorType(status)
			}
			body = map[string]any{"type": "error", "error": map[string]any{"type": code, "message": message}}
		case shape.Gemini:
			if code == "" {
				code = geminiStatus(status)
			}
			body = map[string]any{"error": map[string]any{"code": status, "message": message, "status": code}}
		default:
			var c any
			if code != "" {
				c = code
			}
			body = map[string]any{"error": map[string]any{"message": message, "type": openAIErrorType(status), "param": nil, "code": c}}
		}
		return Reply{Status: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: []byte(compactJSON(body))}
	}
}

func (u *Upstream) modelList(ids []string) Responder {
	return func(r *Received) Reply {
		var body any
		switch u.Shape {
		case shape.AnthropicMessages:
			data := []any{}
			for _, id := range ids {
				data = append(data, map[string]any{"type": "model", "id": id, "display_name": id, "created_at": "2026-01-01T00:00:00Z"})
			}
			body = map[string]any{"data": data, "has_more": false}
		case shape.Gemini:
			models := []any{}
			for _, id := range ids {
				models = append(models, map[string]any{"name": "models/" + id, "displayName": id, "supportedGenerationMethods": []string{"generateContent"}})
			}
			body = map[string]any{"models": models}
		default:
			data := []any{}
			for _, id := range ids {
				data = append(data, map[string]any{"id": id, "object": "model", "created": 1767225600, "owned_by": "fake"})
			}
			body = map[string]any{"object": "list", "data": data}
		}
		return Reply{Status: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: []byte(compactJSON(body))}
	}
}

func openAIErrorType(status int) string {
	switch {
	case status == 401:
		return "authentication_error"
	case status == 403:
		return "permission_error"
	case status == 404:
		return "not_found_error"
	case status == 429:
		return "rate_limit_error"
	case status >= 500:
		return "server_error"
	}
	return "invalid_request_error"
}

func anthropicErrorType(status int) string {
	switch {
	case status == 401:
		return "authentication_error"
	case status == 403:
		return "permission_error"
	case status == 404:
		return "not_found_error"
	case status == 413:
		return "request_too_large"
	case status == 429:
		return "rate_limit_error"
	case status == 529:
		return "overloaded_error"
	case status >= 500:
		return "api_error"
	}
	return "invalid_request_error"
}

func geminiStatus(status int) string {
	switch {
	case status == 401:
		return "UNAUTHENTICATED"
	case status == 403:
		return "PERMISSION_DENIED"
	case status == 404:
		return "NOT_FOUND"
	case status == 429:
		return "RESOURCE_EXHAUSTED"
	case status == 503:
		return "UNAVAILABLE"
	case status >= 500:
		return "INTERNAL"
	}
	return "INVALID_ARGUMENT"
}
