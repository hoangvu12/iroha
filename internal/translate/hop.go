package translate

import (
	"context"
	"fmt"

	"github.com/QuantumNous/new-api/relaykit/relayconvert"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/hoangvu12/iroha/internal/shape"
)

// Answers through OpenAI Chat. RelayKit converts answers to some Shapes
// from OpenAI Chat only (it chains the other Shapes through Chat), and its
// converter from Chat drops what such a Shape could carry: for Gemini,
// reasoning as thought parts and the cached and reasoning token counts. A
// codec with chatHop has its answers converted in two steps, the Endpoint's
// Shape to Chat and Chat to the Caller's, and sees each Chat form on the
// way: a whole answer as Translation.chat, each stream chunk through its
// writer's chatReader. That is the chain RelayKit itself would run; only
// the middle is no longer hidden.

// chatReader is a streamWriter that reads each Chat chunk before the
// converted events of that chunk are written. What it returns is sent
// first.
type chatReader interface {
	chat(m map[string]any) []byte
}

// toChat converts a whole Endpoint answer to Chat when the Caller's codec
// hops through Chat, and keeps the Chat form in t.chat.
func (t *Translation) toChat(ctx context.Context, in any) (any, error) {
	if !t.caller.chatHop {
		return in, nil
	}
	if t.endpoint.shape != shape.OpenAIChat {
		res, err := relayconvert.ConvertResponse(ctx, t.metaOrEmpty(), types.RelayFormatOpenAI, in)
		if err != nil {
			return nil, fmt.Errorf("the Provider's answer cannot be translated to %s: %w", shape.OpenAIChat, err)
		}
		in = res.Value
	}
	m, err := toMap(in)
	t.chat = m
	return in, err
}

// streamFrom is the format the Caller's stream converter reads.
func (t *Translation) streamFrom() types.RelayFormat {
	if t.caller.chatHop {
		return types.RelayFormatOpenAI
	}
	return t.endpoint.format
}

// newHop is the Endpoint-to-Chat stream converter of a Caller whose codec
// hops through Chat, nil when none is needed.
func (t *Translation) newHop(o relayconvert.ResponseStreamOptions) (*relayconvert.ResponseStreamState, error) {
	if !t.caller.chatHop || t.endpoint.shape == shape.OpenAIChat {
		return nil, nil
	}
	return relayconvert.NewResponseStreamState(t.endpoint.format, types.RelayFormatOpenAI, o)
}

// convert turns one decoded upstream event into the Caller's events.
func (s *Stream) convert(ctx context.Context, in any) ([]byte, error) {
	if !s.t.caller.chatHop {
		res, err := relayconvert.ConvertStreamResponseChunk(ctx, s.t.metaOrEmpty(), s.st, in)
		if err != nil {
			return nil, fmt.Errorf("a stream event cannot be translated to %s: %w", s.t.caller.shape, err)
		}
		return s.write(res)
	}
	chunks := []any{in}
	if s.hop != nil {
		res, err := relayconvert.ConvertStreamResponseChunk(ctx, s.t.metaOrEmpty(), s.hop, in)
		if err != nil {
			return nil, fmt.Errorf("a stream event cannot be translated to %s: %w", shape.OpenAIChat, err)
		}
		chunks = values(res)
	}
	return s.fromChat(ctx, chunks)
}

// endHop finishes the Endpoint-to-Chat converter and converts what it
// still had.
func (s *Stream) endHop(ctx context.Context) ([]byte, error) {
	if s.hop == nil {
		return nil, nil
	}
	res, err := relayconvert.FinalizeStreamResponse(ctx, s.t.metaOrEmpty(), s.hop)
	if err != nil {
		return nil, fmt.Errorf("the stream cannot be finished in %s: %w", shape.OpenAIChat, err)
	}
	return s.fromChat(ctx, values(res))
}

// fromChat converts Chat chunks to the Caller's Shape, showing each to the
// writer first.
func (s *Stream) fromChat(ctx context.Context, chunks []any) ([]byte, error) {
	var out []byte
	for _, c := range chunks {
		if r, ok := s.w.(chatReader); ok {
			m, err := toMap(c)
			if err != nil {
				return nil, err
			}
			if s.hop != nil && m["usage"] != nil {
				// A chunk carries the usage of its own upstream event; the
				// converter has merged the stream's (Anthropic splits input
				// and output over two events).
				if u := s.hop.Usage(); u != nil {
					m["usage"] = chatUsage(u)
				}
			}
			out = append(out, r.chat(m)...)
		}
		res, err := relayconvert.ConvertStreamResponseChunk(ctx, s.t.metaOrEmpty(), s.st, c)
		if err != nil {
			return nil, fmt.Errorf("a stream event cannot be translated to %s: %w", s.t.caller.shape, err)
		}
		b, err := s.write(res)
		if err != nil {
			return nil, err
		}
		out = append(out, b...)
	}
	return out, nil
}

func values(res []relayconvert.ResponseResult) []any {
	out := make([]any, 0, len(res))
	for _, r := range res {
		out = append(out, r.Value)
	}
	return out
}
