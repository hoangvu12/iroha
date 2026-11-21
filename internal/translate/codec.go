package translate

import (
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/hoangvu12/iroha/internal/shape"
)

type shapeFormat struct {
	shape  shape.Shape
	format types.RelayFormat
}

type callerCodec struct {
	shapeFormat

	request     func() any
	setModel    func(req any, model string)
	rewrite     func(body []byte) []byte
	noteRequest func(req any, t *Translation)
	readFormat  func(req any) *outputFormat

	tidyAnswer     func(m map[string]any, t *Translation, u *dto.Usage)
	newWriter      func(t *Translation, o StreamOptions) streamWriter
	streamID       func(t *Translation) string
	answersViaChat bool
}

type endpointCodec struct {
	shapeFormat

	declaredTools  func(req map[string]any) []string
	prepareRequest func(req map[string]any, t *Translation)
	writeFormat    func(req map[string]any, f *outputFormat, t *Translation)

	answer, event func() any
	upstream      func(data []byte) upstreamEvent
	fixUp         func(v any)
}

type shapeCodecs struct {
	caller   *callerCodec
	endpoint *endpointCodec
}

var codecs = map[shape.Shape]shapeCodecs{
	shape.OpenAIChat:        {chatCaller, chatEndpoint},
	shape.AnthropicMessages: {anthropicCaller, anthropicEndpoint},
	shape.OpenAIResponses:   {responsesCaller, responsesEndpoint},
	shape.Gemini:            {geminiCaller, geminiEndpoint},
}

func (c *endpointCodec) fixUpstream(v any) {
	if c.fixUp != nil {
		c.fixUp(v)
	}
}

type upstreamEvent struct {
	feed     bool
	complete bool
	err      *UpstreamError
}

type streamWriter interface {
	write(m map[string]any) []byte
	end(u *dto.Usage) []byte
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

func pick(m map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			out[k] = v
		}
	}
	return out
}
