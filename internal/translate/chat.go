package translate

import (
	"bytes"
	"encoding/json"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/hoangvu12/iroha/internal/shape"
)

var chatShape = shapeFormat{shape.OpenAIChat, types.RelayFormatOpenAI}

var chatEndpoint = &endpointCodec{
	shapeFormat: chatShape,
	answer:      func() any { return &dto.OpenAITextResponse{} },
	event:       func() any { return &dto.ChatCompletionsStreamResponse{} },
	writeFormat: writeChatFormat,

	declaredTools: func(req map[string]any) []string {
		var names []string
		for _, tool := range list(req["tools"]) {
			names = append(names, str(obj(obj(tool)["function"])["name"]))
		}
		return names
	},

	prepareRequest: func(req map[string]any, t *Translation) {
		for _, tool := range list(req["tools"]) {
			rename(obj(obj(tool)["function"]), "name", t.names.safe)
		}
		for _, msg := range list(req["messages"]) {
			msg := obj(msg)
			for _, call := range list(msg["tool_calls"]) {
				rename(obj(obj(call)["function"]), "name", t.names.safe)
			}
			if str(msg["role"]) == "tool" {
				rename(msg, "name", t.names.safe)
			}
		}
		rename(obj(obj(req["tool_choice"])["function"]), "name", t.names.safe)
		// Strict Chat Providers refuse store, which a Responses Caller may
		// send.
		delete(req, "store")
		if req["stream"] == true {
			// OpenAI streams usage only when include_usage is set.
			opts := obj(req["stream_options"])
			if opts == nil {
				opts = map[string]any{}
			}
			opts["include_usage"] = true
			req["stream_options"] = opts
		}
	},

	upstream: func(data []byte) upstreamEvent {
		if string(bytes.TrimSpace(data)) == "[DONE]" {
			return upstreamEvent{complete: true}
		}
		var v struct {
			Error   json.RawMessage `json:"error"`
			Choices []struct {
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
		}
		if json.Unmarshal(data, &v) != nil {
			return upstreamEvent{feed: true}
		}
		if len(v.Error) > 0 && string(v.Error) != "null" {
			return upstreamEvent{err: chatError(v.Error)}
		}
		ev := upstreamEvent{feed: true}
		for _, c := range v.Choices {
			if c.FinishReason != nil && *c.FinishReason != "" {
				ev.complete = true
			}
		}
		return ev
	},
}

var chatCaller = &callerCodec{
	shapeFormat: chatShape,
	request:     func() any { return &dto.GeneralOpenAIRequest{} },
	setModel:    func(req any, model string) { req.(*dto.GeneralOpenAIRequest).Model = model },
	readFormat:  readChatFormat,

	tidyAnswer: func(m map[string]any, t *Translation, u *dto.Usage) {
		m["model"] = t.o.Model
		if str(m["id"]) == "" {
			m["id"] = "chatcmpl-" + t.o.ID
		}
		m["created"] = t.o.Now.Unix()
		if m["system_fingerprint"] == nil {
			delete(m, "system_fingerprint")
		}
		if u != nil {
			m["usage"] = chatUsage(u)
		}
		t.writeCacheUsage(obj(m["usage"]))
		for _, c := range list(m["choices"]) {
			restoreChatCalls(obj(obj(c)["message"]), t)
			if c := obj(c); c["finish_reason"] != nil {
				c["finish_reason"] = chatFinish(c["finish_reason"], len(list(obj(c["message"])["tool_calls"])) > 0)
			}
		}
	},

	newWriter: func(t *Translation, o StreamOptions) streamWriter { return &chatWriter{t: t, o: o} },
}

var chatFinishReasons = map[string]bool{"stop": true, "length": true, "tool_calls": true, "content_filter": true, "function_call": true}

// Clients run tools only on tool_calls, but Anthropic can say end_turn
// after tool_use blocks.
func chatFinish(v any, called bool) any {
	v = knownReason(v, chatFinishReasons, "stop")
	if called && v == "stop" {
		return "tool_calls"
	}
	return v
}

func chatError(raw json.RawMessage) *UpstreamError {
	var e struct {
		Message string `json:"message"`
		Type    string `json:"type"`
		Code    any    `json:"code"`
	}
	if json.Unmarshal(raw, &e) != nil {
		return &UpstreamError{Message: string(raw)}
	}
	typ := e.Type
	if c, ok := e.Code.(string); ok && c != "" {
		typ = c
	}
	return &UpstreamError{Type: typ, Message: e.Message}
}

func chatUsage(u *dto.Usage) map[string]any {
	m := usageMap(u)
	out := pick(m, "prompt_tokens", "completion_tokens", "total_tokens")
	if d := pick(obj(m["prompt_tokens_details"]), "cached_tokens"); len(d) > 0 {
		out["prompt_tokens_details"] = d
	}
	if d := pick(obj(m["completion_tokens_details"]), "reasoning_tokens"); len(d) > 0 {
		out["completion_tokens_details"] = d
	}
	return out
}

func restoreChatCalls(msg map[string]any, t *Translation) {
	for _, call := range list(msg["tool_calls"]) {
		rename(obj(obj(call)["function"]), "name", t.names.original)
	}
}

type chatWriter struct {
	t      *Translation
	o      StreamOptions
	id     string
	sent   bool
	called bool
}

func (w *chatWriter) write(m map[string]any) []byte {
	if w.id == "" {
		w.id = str(m["id"])
		if w.id == "" {
			w.id = "chatcmpl-" + w.t.o.ID
		}
	}
	m["id"], m["object"], m["model"], m["created"] = w.id, "chat.completion.chunk", w.t.o.Model, w.t.o.Now.Unix()
	delete(m, "usage")
	if m["system_fingerprint"] == nil {
		delete(m, "system_fingerprint")
	}
	keep := !w.sent // the first chunk names the role
	for _, c := range list(m["choices"]) {
		c := obj(c)
		if c["logprobs"] == nil {
			delete(c, "logprobs")
		}
		delta := obj(c["delta"])
		restoreChatCalls(delta, w.t)
		if len(list(delta["tool_calls"])) > 0 {
			w.called = true
		}
		if c["finish_reason"] != nil {
			c["finish_reason"] = chatFinish(c["finish_reason"], w.called)
			keep = true
		}
		if saysSomething(delta) {
			keep = true
		}
	}
	if !keep {
		return nil
	}
	w.sent = true
	return w.frame(m)
}

func saysSomething(delta map[string]any) bool {
	for k, v := range delta {
		if k == "role" || v == nil || v == "" {
			continue
		}
		return true
	}
	return false
}

func (w *chatWriter) end(u *dto.Usage) []byte {
	var out []byte
	if w.o.IncludeUsage {
		id := w.id
		if id == "" {
			id = "chatcmpl-" + w.t.o.ID
		}
		cu := chatUsage(u)
		w.t.writeCacheUsage(cu)
		out = w.frame(map[string]any{"id": id, "object": "chat.completion.chunk", "created": w.t.o.Now.Unix(), "model": w.t.o.Model,
			"choices": []any{}, "usage": cu})
	}
	return append(out, "data: [DONE]\n\n"...)
}

func (w *chatWriter) frame(m map[string]any) []byte {
	b, _ := marshal(m)
	return append(append([]byte("data: "), b...), "\n\n"...)
}
