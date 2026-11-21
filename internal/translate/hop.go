package translate

import (
	"context"
	"fmt"

	"github.com/QuantumNous/new-api/relaykit/relayconvert"
	"github.com/QuantumNous/new-api/relaykit/types"

	"github.com/hoangvu12/iroha/internal/shape"
)

// RelayKit converts answers to some Shapes only from OpenAI Chat, and its
// chained converter drops what the target could carry (for Gemini:
// reasoning as thought parts, cached and reasoning token counts). A Caller
// codec that answersViaChat runs both steps itself so it can see the Chat form in between.

type chatReader interface {
	chat(m map[string]any) []byte
}

func (t *Translation) toChat(ctx context.Context, in any) (any, error) {
	if !t.caller.answersViaChat {
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

func (t *Translation) streamFrom() types.RelayFormat {
	if t.caller.answersViaChat {
		return types.RelayFormatOpenAI
	}
	return t.endpoint.format
}

func (t *Translation) newHop(o relayconvert.ResponseStreamOptions) (*relayconvert.ResponseStreamState, error) {
	if !t.caller.answersViaChat || t.endpoint.shape == shape.OpenAIChat {
		return nil, nil
	}
	return relayconvert.NewResponseStreamState(t.endpoint.format, types.RelayFormatOpenAI, o)
}

func (s *Stream) convert(ctx context.Context, in any) ([]byte, error) {
	if !s.t.caller.answersViaChat {
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
