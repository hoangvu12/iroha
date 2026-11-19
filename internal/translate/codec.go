package translate

import (
	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/hoangvu12/iroha/internal/shape"
)

// codec is everything translation knows about one Shape. A Shape is
// translatable once it has a codec in codecs.
type codec struct {
	shape  shape.Shape
	format types.RelayFormat // RelayKit's name for the Shape

	// The RelayKit DTOs a request, a whole answer and one stream event of
	// this Shape decode into (pointers).
	request, answer, event func() any
	// setModel names the model in a decoded request of this Shape.
	setModel func(req any, model string)

	// As the Endpoint's Shape:

	// prepareRequest fixes a request converted to this Shape before it is
	// sent: sanitised tool names, what the stream must include.
	prepareRequest func(req map[string]any, t *Translation)
	// upstream reads one stream event of this Shape from an Endpoint.
	upstream func(data []byte) upstreamEvent
	// fixUp, if set, corrects a decoded answer or stream event from an
	// Endpoint (a DTO from answer or event) before it is converted.
	fixUp func(v any)

	// As the Caller's Shape:

	// tidyAnswer fixes a whole answer converted to this Shape: the
	// Caller's model, restored tool names, clean usage (u is RelayKit's).
	tidyAnswer func(m map[string]any, t *Translation, u *dto.Usage)
	// newWriter writes a stream converted to this Shape to the Caller.
	newWriter func(t *Translation, o StreamOptions) streamWriter
	// streamID, if set, names a stream converted to this Shape (and the
	// items the converter derives from it); otherwise the converter does.
	streamID func(t *Translation) string
}

// codecs are the translatable Shapes. Tickets 14 (OpenAI Responses) and 15
// (Gemini) add theirs here.
var codecs = map[shape.Shape]*codec{
	shape.OpenAIChat:        chatCodec,
	shape.AnthropicMessages: anthropicCodec,
	shape.OpenAIResponses:   responsesCodec,
}

func (c *codec) fixUpstream(v any) {
	if c.fixUp != nil {
		c.fixUp(v)
	}
}

// upstreamEvent is what one upstream stream event means.
type upstreamEvent struct {
	feed     bool           // convert it
	complete bool           // the answer is complete (a final event arrived)
	err      *UpstreamError // the Provider reported an error: the stream is over
}

// streamWriter writes one converted stream to the Caller.
type streamWriter interface {
	// write tidies and frames one converted event; nil drops it.
	write(m map[string]any) []byte
	// end is what closes a complete stream, given the stream's usage.
	end(u *dto.Usage) []byte
}

// JSON object helpers for the fix-ups.

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

// pick returns the named keys of m that are present and not null.
func pick(m map[string]any, keys ...string) map[string]any {
	out := map[string]any{}
	for _, k := range keys {
		if v, ok := m[k]; ok && v != nil {
			out[k] = v
		}
	}
	return out
}
