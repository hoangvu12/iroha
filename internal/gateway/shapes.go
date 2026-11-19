package gateway

import (
	"bytes"
	"net/http"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/shape"
)

// shapeSpec is what the Gateway knows of one Shape beyond translation
// (internal/translate), usage (internal/usage) and stream reassembly
// (internal/requests): one entry in specs per Shape, so adding a Shape means
// filling in one value here instead of a branch in each switch.
type shapeSpec struct {
	// bodyHint says what a Caller's body in this Shape must hold.
	bodyHint string
	// op is the operation path appended to an Endpoint's URL.
	op func(model string, stream bool) string
	// errorEnvelope is an Iroha error in the Shape's own envelope.
	errorEnvelope func(e *api.Error, requestID string) map[string]any
	// stream frames Iroha's own events (keep-alive, error) on a stream to
	// a Caller of this Shape (stream.go).
	stream streamShape
	// echoBody and echoEvent name the Caller's model in a passed-through
	// whole answer and stream event.
	echoBody, echoEvent func(p []byte, model string) []byte
	// reported is the model an answer or stream event says served it, ""
	// when it names none (reported.go).
	reported func(p []byte) string
	// token reports whether a stream event carries generated content
	// (firsttoken.go).
	token func(p []byte) bool
	// testBody is the tiny chat call of a key test, and any header the
	// Shape needs (keytest.go).
	testBody func(model string) (body map[string]any, header http.Header)
}

var specs = map[shape.Shape]*shapeSpec{
	shape.OpenAIChat: {
		bodyHint:      "Send an OpenAI Chat Completions JSON object with model and messages.",
		op:            func(string, bool) string { return opChat },
		errorEnvelope: openAIError,
		stream:        openAIChatStream{},
		echoBody:      echoModel,
		echoEvent:     echoModel,
		reported:      func(p []byte) string { return stringField(p, "model") },
		token:         chatToken,
		testBody: func(model string) (map[string]any, http.Header) {
			return map[string]any{"model": model, "max_tokens": 16, "messages": testMessages()}, nil
		},
	},
	shape.AnthropicMessages: {
		bodyHint:      "Send an Anthropic Messages JSON object with model, max_tokens and messages.",
		op:            func(string, bool) string { return opMessages },
		errorEnvelope: anthropicError,
		stream:        anthropicStream{},
		echoBody:      echoModel,
		echoEvent:     echoMessageStart,
		reported:      reportedAnthropic,
		token:         anthropicToken,
		testBody: func(model string) (map[string]any, http.Header) {
			h := http.Header{}
			h.Set("Anthropic-Version", shape.AnthropicVersion)
			return map[string]any{"model": model, "max_tokens": 16, "messages": testMessages()}, h
		},
	},
	shape.OpenAIResponses: {
		bodyHint:      "Send an OpenAI Responses JSON object with model and input.",
		op:            func(string, bool) string { return opResponses },
		errorEnvelope: openAIError,
		stream:        responsesStream{},
		echoBody:      echoModel,
		echoEvent:     echoResponsesEvent,
		reported:      reportedResponses,
		token:         responsesToken,
		testBody: func(model string) (map[string]any, http.Header) {
			return map[string]any{"model": model, "input": keyTestPrompt, "max_output_tokens": 16}, nil
		},
	},
	shape.Gemini: {
		bodyHint:      "Send a Gemini generateContent JSON object with contents to .../v1beta/models/{model}:generateContent.",
		op:            geminiOp,
		errorEnvelope: geminiError,
		stream:        geminiStreamShape{},
		echoBody:      echoModelVersion,
		echoEvent:     echoModelVersion,
		reported:      func(p []byte) string { return stringField(p, "modelVersion") },
		token:         geminiToken,
		testBody: func(string) (map[string]any, http.Header) {
			return map[string]any{"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": keyTestPrompt}}}},
				"generationConfig": map[string]any{"maxOutputTokens": 16}}, nil
		},
	},
}

// specOf is the spec of Shape sh; OpenAI Chat's for a Shape with none.
func specOf(sh shape.Shape) *shapeSpec {
	if s := specs[sh]; s != nil {
		return s
	}
	return specs[shape.OpenAIChat]
}

// opFor is the operation path of an inference call in Shape sh for model
// (a Gemini URL names the model and whether it streams).
func opFor(sh shape.Shape, model string, stream bool) string { return specOf(sh).op(model, stream) }

// errorEnvelope is e in the error envelope of Shape sh: Anthropic's for
// Anthropic Messages, Google's for Gemini, OpenAI's otherwise.
func errorEnvelope(sh shape.Shape, e *api.Error, requestID string) map[string]any {
	return specOf(sh).errorEnvelope(e, requestID)
}

// echoMessageStart names the Caller's model in a passed-through Anthropic
// stream event: only message_start names it, inside its message.
func echoMessageStart(p []byte, model string) []byte {
	if msg, ok := field(p, "message"); ok && bytes.Contains(p, []byte(`"message_start"`)) {
		if out, ok := setField(p, "message", echoModel(msg, model)); ok {
			return out
		}
	}
	return p
}

// reportedAnthropic reads the model of a Messages body, or of the message
// of message_start.
func reportedAnthropic(p []byte) string {
	m := stringField(p, "model")
	if m == "" && bytes.Contains(p, []byte(`"message_start"`)) {
		if msg, ok := field(p, "message"); ok {
			m = stringField(msg, "model")
		}
	}
	return m
}

// reportedResponses reads the model of a Responses body, or of the
// response of response.* events.
func reportedResponses(p []byte) string {
	m := stringField(p, "model")
	if m == "" {
		if resp, ok := field(p, "response"); ok {
			m = stringField(resp, "model")
		}
	}
	return m
}
