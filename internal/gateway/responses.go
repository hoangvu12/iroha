package gateway

import (
	"github.com/hoangvu12/iroha/internal/api"
)

const opResponses = "/responses"

type ResponsesRequest struct {
	Model  string `json:"model" doc:"The model, as the Provider names it (or as an Endpoint rename maps it)."`
	Input  any    `json:"input" doc:"A string or a list of input items."`
	Stream bool   `json:"stream,omitempty" doc:"true: the answer streams as Responses server-sent events (response.created ... response.completed)."`
}

const responsesDescription = "OpenAI Responses. Authenticate with \"Authorization: Bearer <Gateway Key>\" (what the OpenAI SDKs and Codex send), or the key in an x-api-key or api-key header; " +
	"Caller credentials are never forwarded. On an Endpoint speaking Responses the body passes through unchanged except the model, " +
	"and the answer passes through with its model (the response's model in stream events) set to the model you asked for. " +
	translationNote +
	"A translated answer has the id resp_<Request ID>, and a request translated to a Responses Endpoint is sent with store: false unless you set store. " +
	"Stateful fields (previous_response_id, conversation, prompt, context_management) cannot be translated: such a request gets 400 untranslatable_request. " +
	"Errors use the OpenAI envelope {\"error\":{\"message\",\"type\",\"code\",\"hint\",\"request_id\"}}. " +
	"A stream with no upstream byte after 10 s is committed (200, keep-alive comments every 15 s of silence); failures after that arrive as an error event, then response.failed."

// The OpenAI SDKs and Codex skip SSE comments. The OpenAI SDKs raise an event
// whose data holds a top-level error object; Codex ignores an error event
// whose code it does not know and reports response.failed with its message.
type responsesStream struct{}

func (responsesStream) keepAlive() []byte { return []byte(": keep-alive\n\n") }

func (responsesStream) errorEvent(e *api.Error, requestID string) []byte {
	env := openAIError(e, requestID)
	inner := env["error"].(map[string]any)
	ev := map[string]any{"type": "error", "code": e.Code, "message": e.Message, "param": nil, "error": inner}
	failed := map[string]any{"type": "response.failed", "response": map[string]any{
		"id": "resp_" + requestID, "object": "response", "status": "failed",
		"error": map[string]any{"code": e.Code, "message": e.Message}, "incomplete_details": nil, "output": []any{},
	}}
	out := append(append([]byte("event: error\ndata: "), compactJSON(ev)...), "\n\n"...)
	out = append(append(out, "event: response.failed\ndata: "...), compactJSON(failed)...)
	return append(out, "\n\n"...)
}

// In a Responses stream only the response object of response.* lifecycle
// events names the model.
func echoResponsesEvent(p []byte, model string) []byte {
	r, ok := field(p, "response")
	if !ok || len(r) == 0 || r[0] != '{' {
		return p
	}
	echoed := echoModel(r, model)
	if len(echoed) == len(r) && string(echoed) == string(r) {
		return p
	}
	if out, ok := setField(p, "response", echoed); ok {
		return out
	}
	return p
}
