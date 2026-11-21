package gateway

import (
	"bytes"
	"net/http"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/shape"
)

type shapeSpec struct {
	bodyHint            string
	op                  func(model string, stream bool) string
	errorEnvelope       func(e *api.Error, requestID string) map[string]any
	stream              streamShape
	echoBody, echoEvent func(p []byte, model string) []byte
	reported            func(p []byte) string
	carriesContent      func(p []byte) bool
	testBody            func(model string) (body map[string]any, header http.Header)
}

var specs = map[shape.Shape]*shapeSpec{
	shape.OpenAIChat: {
		bodyHint:       "Send an OpenAI Chat Completions JSON object with model and messages.",
		op:             func(string, bool) string { return opChat },
		errorEnvelope:  openAIError,
		stream:         openAIChatStream{},
		echoBody:       echoModel,
		echoEvent:      echoModel,
		reported:       func(p []byte) string { return stringField(p, "model") },
		carriesContent: chatToken,
		testBody: func(model string) (map[string]any, http.Header) {
			return map[string]any{"model": model, "max_tokens": 16, "messages": testMessages()}, nil
		},
	},
	shape.AnthropicMessages: {
		bodyHint:       "Send an Anthropic Messages JSON object with model, max_tokens and messages.",
		op:             func(string, bool) string { return opMessages },
		errorEnvelope:  anthropicError,
		stream:         anthropicStream{},
		echoBody:       echoModel,
		echoEvent:      echoMessageStart,
		reported:       reportedAnthropic,
		carriesContent: anthropicToken,
		testBody: func(model string) (map[string]any, http.Header) {
			h := http.Header{}
			h.Set("Anthropic-Version", shape.AnthropicVersion)
			return map[string]any{"model": model, "max_tokens": 16, "messages": testMessages()}, h
		},
	},
	shape.OpenAIResponses: {
		bodyHint:       "Send an OpenAI Responses JSON object with model and input.",
		op:             func(string, bool) string { return opResponses },
		errorEnvelope:  openAIError,
		stream:         responsesStream{},
		echoBody:       echoModel,
		echoEvent:      echoResponsesEvent,
		reported:       reportedResponses,
		carriesContent: responsesToken,
		testBody: func(model string) (map[string]any, http.Header) {
			return map[string]any{"model": model, "input": keyTestPrompt, "max_output_tokens": 16}, nil
		},
	},
	shape.Gemini: {
		bodyHint:       "Send a Gemini generateContent JSON object with contents to .../v1beta/models/{model}:generateContent.",
		op:             geminiOp,
		errorEnvelope:  geminiError,
		stream:         geminiStreamShape{},
		echoBody:       echoModelVersion,
		echoEvent:      echoModelVersion,
		reported:       func(p []byte) string { return stringField(p, "modelVersion") },
		carriesContent: geminiToken,
		testBody: func(string) (map[string]any, http.Header) {
			return map[string]any{"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": keyTestPrompt}}}},
				"generationConfig": map[string]any{"maxOutputTokens": 16}}, nil
		},
	},
}

func specOrChat(sh shape.Shape) *shapeSpec {
	if s := specs[sh]; s != nil {
		return s
	}
	return specs[shape.OpenAIChat]
}

func opFor(sh shape.Shape, model string, stream bool) string { return specOrChat(sh).op(model, stream) }

func errorEnvelope(sh shape.Shape, e *api.Error, requestID string) map[string]any {
	return specOrChat(sh).errorEnvelope(e, requestID)
}

// In an Anthropic stream only message_start names the model, inside its
// message.
func echoMessageStart(p []byte, model string) []byte {
	if msg, ok := field(p, "message"); ok && bytes.Contains(p, []byte(`"message_start"`)) {
		if out, ok := setField(p, "message", echoModel(msg, model)); ok {
			return out
		}
	}
	return p
}

func reportedAnthropic(p []byte) string {
	m := stringField(p, "model")
	if m == "" && bytes.Contains(p, []byte(`"message_start"`)) {
		if msg, ok := field(p, "message"); ok {
			m = stringField(msg, "model")
		}
	}
	return m
}

func reportedResponses(p []byte) string {
	m := stringField(p, "model")
	if m == "" {
		if resp, ok := field(p, "response"); ok {
			m = stringField(resp, "model")
		}
	}
	return m
}
