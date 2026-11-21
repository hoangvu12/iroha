package translate

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/QuantumNous/new-api/relaykit/dto"
	"github.com/QuantumNous/new-api/relaykit/relayconvert"
	"github.com/QuantumNous/new-api/relaykit/relayconvert/convmeta"
	"github.com/QuantumNous/new-api/relaykit/relayconvert/kitutil"

	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/usage"
)

func init() {
	// RelayKit's hooks are package globals, and its logs can quote request content.
	relayconvert.SetMediaResolver(relayconvert.MediaResolver{GetBase64Data: resolveMedia, DecodeBase64FileData: decodeDataURL})
	quiet := kitutil.LogFunc(func(string) {})
	kitutil.SetLogging(quiet, quiet)
	kitutil.SetSystemErrorLogging(quiet)
}

func Supported(from, to shape.Shape) bool {
	return from != to && codecs[from].caller != nil && codecs[to].endpoint != nil
}

func Targets(from shape.Shape) []shape.Shape {
	var out []shape.Shape
	for _, to := range shape.All {
		if Supported(from, to) {
			out = append(out, to)
		}
	}
	return out
}

type Options struct {
	Model   string
	ID      string
	Now     time.Time
	Stream  bool
	Caching Caching
}

type Translation struct {
	caller      *callerCodec
	endpoint    *endpointCodec
	o           Options
	meta        *convmeta.Values
	names       toolNames
	chat        map[string]any
	thoughts    bool
	Diagnostics []string
	Added       []string
	usage       *usage.Reader
}

type Error struct{ Message, Hint string }

func (e *Error) Error() string { return e.Message }

type UpstreamError struct {
	Type    string
	Message string
}

func (e *UpstreamError) Error() string {
	if e.Type == "" {
		return e.Message
	}
	return e.Type + ": " + e.Message
}

var ErrIncomplete = errors.New("the stream ended before the answer was complete")

func New(from, to shape.Shape, o Options) (*Translation, error) {
	if !Supported(from, to) {
		return nil, fmt.Errorf("Iroha cannot translate %s to %s", from, to)
	}
	if o.Now.IsZero() {
		return nil, errors.New("translate: Options.Now is required")
	}
	return &Translation{caller: codecs[from].caller, endpoint: codecs[to].endpoint, o: o, usage: usage.NewReader(to)}, nil
}

func (t *Translation) Request(ctx context.Context, body []byte, wireModel string) ([]byte, error) {
	fields := readCallerFields(body)
	if err := t.refuseStored(fields); err != nil {
		return nil, err
	}
	if t.caller.rewrite != nil {
		body = t.caller.rewrite(body)
	}
	in := t.caller.request()
	if err := json.Unmarshal(body, in); err != nil {
		return nil, &Error{Message: fmt.Sprintf("The body is not a valid %s request: %v", t.caller.shape, err)}
	}
	t.caller.setModel(in, wireModel)
	if t.caller.noteRequest != nil {
		t.caller.noteRequest(in, t)
	}
	format := t.caller.readFormat(in)
	t.meta = &convmeta.Values{OriginModelName: t.o.Model, UpstreamModelName: wireModel, ChannelMetaAttached: true, IsStream: t.o.Stream,
		Options: &convmeta.Options{Claude: convmeta.ClaudeOptions{DefaultMaxTokens: defaultMaxTokens},
			// Gemini 3 refuses replayed model turns whose function calls lack
			// the thought signature only Gemini can make; history from another
			// Shape gets Google's documented bypass value instead.
			Gemini: convmeta.GeminiOptions{FunctionCallThoughtSignatureEnabled: true}}}
	res, err := relayconvert.ConvertRequest(ctx, t.meta, t.endpoint.format, in)
	if err != nil {
		return nil, &Error{Message: fmt.Sprintf("The request cannot be translated from %s to %s: %v", t.caller.shape, t.endpoint.shape, err)}
	}
	for _, d := range res.Diagnostics {
		t.Diagnostics = append(t.Diagnostics, d.Code+": "+d.Message)
	}
	m, err := toMap(res.Value)
	if err != nil {
		return nil, err
	}
	if format != nil {
		t.endpoint.writeFormat(m, format, t)
	}
	t.names = newToolNames(t.endpoint.declaredTools(m)...)
	t.endpoint.prepareRequest(m, t)
	t.applyCaching(m, fields)
	return marshal(m)
}

func (t *Translation) Response(ctx context.Context, body []byte) ([]byte, error) {
	in := t.endpoint.answer()
	if err := json.Unmarshal(body, in); err != nil {
		return nil, fmt.Errorf("the Provider's answer is not a valid %s answer: %w", t.endpoint.shape, err)
	}
	t.usage.Body(body)
	t.endpoint.fixUpstream(in)
	in, err := t.toChat(ctx, in)
	if err != nil {
		return nil, err
	}
	res, err := relayconvert.ConvertResponse(ctx, t.metaOrEmpty(), t.caller.format, in)
	if err != nil {
		return nil, fmt.Errorf("the Provider's answer cannot be translated to %s: %w", t.caller.shape, err)
	}
	m, err := toMap(res.Value)
	if err != nil {
		return nil, err
	}
	t.caller.tidyAnswer(m, t, res.Usage)
	return marshal(m)
}

func (t *Translation) metaOrEmpty() *convmeta.Values {
	if t.meta == nil {
		t.meta = &convmeta.Values{OriginModelName: t.o.Model, ChannelMetaAttached: true}
	}
	return t.meta
}

type StreamOptions struct {
	IncludeUsage bool
}

type Stream struct {
	t        *Translation
	st       *relayconvert.ResponseStreamState
	hop      *relayconvert.ResponseStreamState
	w        streamWriter
	complete bool
}

func (t *Translation) Stream(o StreamOptions) (*Stream, error) {
	so := relayconvert.ResponseStreamOptions{Model: t.o.Model, Created: t.o.Now.Unix(), IncludeUsage: true, EmitSequenceNumber: true}
	if t.caller.streamID != nil {
		so.ID = t.caller.streamID(t)
	}
	st, err := relayconvert.NewResponseStreamState(t.streamFrom(), t.caller.format, so)
	if err != nil {
		return nil, err
	}
	hop, err := t.newHop(so)
	if err != nil {
		return nil, err
	}
	return &Stream{t: t, st: st, hop: hop, w: t.caller.newWriter(t, o)}, nil
}

func (s *Stream) Event(ctx context.Context, data []byte) ([]byte, error) {
	ev := s.t.endpoint.upstream(data)
	if ev.err != nil {
		return nil, ev.err
	}
	s.t.usage.Event(data)
	if ev.complete {
		s.complete = true
	}
	if !ev.feed {
		return nil, nil
	}
	in := s.t.endpoint.event()
	if err := json.Unmarshal(data, in); err != nil {
		return nil, fmt.Errorf("the Provider sent a stream event that is not a valid %s event: %w", s.t.endpoint.shape, err)
	}
	s.t.endpoint.fixUpstream(in)
	return s.convert(ctx, in)
}

func (s *Stream) End(ctx context.Context) ([]byte, error) {
	if !s.complete {
		return nil, ErrIncomplete
	}
	pre, err := s.endHop(ctx)
	if err != nil {
		return nil, err
	}
	// The usage merged over every event and step: a converter that goes
	// through Chat would otherwise close with the last chunk's counts only
	// (Anthropic's input tokens arrive in message_start).
	if u := s.st.Usage(); u != nil {
		// A step that already wrote the usage in Responses names (Chat ->
		// Responses) converts it again from the Chat names when given it back,
		// so the cache counts must be under both or they come out 0.
		if u.InputTokensDetails != nil && u.PromptTokensDetails == (dto.InputTokenDetails{}) {
			u.PromptTokensDetails = u.InputTokensDetails.Clone()
		}
		s.st.SetUsage(u)
	}
	res, err := relayconvert.FinalizeStreamResponse(ctx, s.t.metaOrEmpty(), s.st)
	if err != nil {
		return nil, fmt.Errorf("the stream cannot be finished in %s: %w", s.t.caller.shape, err)
	}
	out, err := s.write(res)
	if err != nil {
		return nil, err
	}
	return append(append(pre, out...), s.w.end(s.st.Usage())...), nil
}

func (s *Stream) write(res []relayconvert.ResponseResult) ([]byte, error) {
	var out []byte
	for _, r := range res {
		m, err := toMap(r.Value)
		if err != nil {
			return nil, err
		}
		out = append(out, s.w.write(m)...)
	}
	return out, nil
}

// Anthropic requires max_tokens.
func defaultMaxTokens(model string) int {
	m := strings.ToLower(model)
	switch {
	case strings.Contains(m, "opus"):
		return 32000
	case strings.Contains(m, "sonnet"):
		return 64000
	case strings.Contains(m, "haiku"):
		return 8192
	}
	return 4096
}

func toMap(v any) (map[string]any, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	if err := dec.Decode(&m); err != nil {
		return nil, err
	}
	return m, nil
}

func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

func usageMap(u *dto.Usage) map[string]any {
	if u == nil {
		return nil
	}
	m, _ := toMap(u)
	return m
}
