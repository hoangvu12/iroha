// Package translate converts a Request and its answer between Shapes, for
// Attempts on an Endpoint that speaks another Shape than the Caller
// (ADR-0004). Same-Shape Attempts never come here: they pass through.
//
// The conversion itself is RelayKit's (github.com/QuantumNous/new-api/relaykit,
// AGPL-3.0); this is the only package that imports it, so the rest of Iroha
// sees bytes in and bytes out. Around it this package does the host work
// RelayKit leaves to its user:
//
//   - tool names that one Shape rejects are sanitised on the way in and
//     restored in the answer (names.go);
//   - image URLs reach Anthropic as URL sources, never downloaded (media.go);
//   - usage objects lose RelayKit's billing fields, and a Chat stream gets
//     usage once, in a final chunk, only when the Caller asked for it;
//   - every stream chunk names the answer's id, the Caller's model and the
//     creation time; streams are framed as server-sent events in the
//     Caller's Shape ("event:" names, "[DONE]");
//   - an upstream error event, or a stream that ends before its answer did,
//     becomes an error for the Gateway, which answers in the Caller's Shape.
//
// Each Shape is one codec (codec.go plus a file per Shape): its RelayKit
// DTOs, the fixes a request converted to it needs, how its stream reads when
// it comes from an Endpoint, and how an answer converted to it is written to
// a Caller. Adding a Shape (tickets 14 and 15) is adding its codec to
// codecs; every pair of Shapes with codecs then translates, and the planner
// offers their Endpoints (Targets).
//
// Normalisers (ticket 16) work on the upstream answer in the Endpoint's
// Shape, before Response or Stream.Event, so passthrough and translated
// answers get them alike.
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
)

func init() {
	// RelayKit keeps these hooks in package globals; they are the same for
	// every Request. Its "data shape" logs could quote content, so they are
	// dropped.
	relayconvert.SetMediaResolver(relayconvert.MediaResolver{GetBase64Data: resolveMedia, DecodeBase64FileData: decodeDataURL})
	quiet := kitutil.LogFunc(func(string) {})
	kitutil.SetLogging(quiet, quiet)
	kitutil.SetSystemErrorLogging(quiet)
}

// Supported reports whether a Request written in from can be served by an
// Endpoint speaking to through translation.
func Supported(from, to shape.Shape) bool {
	return from != to && codecs[from] != nil && codecs[to] != nil
}

// Targets lists the Shapes a Request written in from can be translated to,
// in shape.All order.
func Targets(from shape.Shape) []shape.Shape {
	var out []shape.Shape
	for _, to := range shape.All {
		if Supported(from, to) {
			out = append(out, to)
		}
	}
	return out
}

// Options describe the Request being translated.
type Options struct {
	// Model is the model the Caller asked for; translated answers name it.
	Model string
	// ID names the answer when the upstream gives it none (Iroha's Request ID).
	ID string
	// Now is when the Request is served; Chat answers carry it as created.
	Now time.Time
}

// Translation converts one Attempt: the Caller's request into the
// Endpoint's Shape and the Endpoint's answer back. Use one per Attempt.
type Translation struct {
	caller, endpoint *codec
	o                Options
	meta             *convmeta.Values
	names            toolNames
	// Diagnostics are RelayKit's notes on what the request conversion
	// could not carry across ("code: message"), for the record.
	Diagnostics []string
}

// Error is a Caller's request that cannot be translated; the Caller must
// change it. Other errors are Iroha's or the Provider's.
type Error struct{ Message string }

func (e *Error) Error() string { return e.Message }

// UpstreamError is an error the Provider reported inside a stream that had
// already begun.
type UpstreamError struct {
	Type    string // the Provider's error type or code, if any
	Message string
}

func (e *UpstreamError) Error() string {
	if e.Type == "" {
		return e.Message
	}
	return e.Type + ": " + e.Message
}

// ErrIncomplete is a stream that ended before its answer did.
var ErrIncomplete = errors.New("the stream ended before the answer was complete")

// New prepares the translation of a Request written in from for an
// Endpoint speaking to.
func New(from, to shape.Shape, o Options) (*Translation, error) {
	if !Supported(from, to) {
		return nil, fmt.Errorf("Iroha cannot translate %s to %s", from, to)
	}
	if o.Now.IsZero() {
		return nil, errors.New("translate: Options.Now is required")
	}
	return &Translation{caller: codecs[from], endpoint: codecs[to], o: o, names: toolNames{}}, nil
}

// Request converts the Caller's body into the body for the Endpoint,
// naming wireModel. An *Error means the body itself cannot be translated.
func (t *Translation) Request(ctx context.Context, body []byte, wireModel string) ([]byte, error) {
	in := t.caller.request()
	if err := json.Unmarshal(body, in); err != nil {
		return nil, &Error{Message: fmt.Sprintf("The body is not a valid %s request: %v", t.caller.shape, err)}
	}
	t.caller.setModel(in, wireModel)
	t.meta = &convmeta.Values{OriginModelName: t.o.Model, UpstreamModelName: wireModel, ChannelMetaAttached: true,
		Options: &convmeta.Options{Claude: convmeta.ClaudeOptions{DefaultMaxTokens: defaultMaxTokens}}}
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
	t.endpoint.prepareRequest(m, t)
	return marshal(m)
}

// Response converts a whole answer from the Endpoint into the Caller's Shape.
func (t *Translation) Response(ctx context.Context, body []byte) ([]byte, error) {
	in := t.endpoint.answer()
	if err := json.Unmarshal(body, in); err != nil {
		return nil, fmt.Errorf("the Provider's answer is not a valid %s answer: %w", t.endpoint.shape, err)
	}
	t.endpoint.fixUpstream(in)
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

// StreamOptions describe what the Caller asked of a stream.
type StreamOptions struct {
	// IncludeUsage: an OpenAI Chat Caller asked for the usage chunk
	// (stream_options.include_usage).
	IncludeUsage bool
}

// Stream converts one streamed answer, event by event.
type Stream struct {
	t        *Translation
	st       *relayconvert.ResponseStreamState
	w        streamWriter
	complete bool
}

// Stream starts converting a streamed answer from the Endpoint.
func (t *Translation) Stream(o StreamOptions) (*Stream, error) {
	// EmitSequenceNumber only changes streams written in Responses: the
	// fields its current wire contract requires (text, arguments on .done).
	so := relayconvert.ResponseStreamOptions{Model: t.o.Model, Created: t.o.Now.Unix(), IncludeUsage: true, EmitSequenceNumber: true}
	if t.caller.streamID != nil {
		so.ID = t.caller.streamID(t)
	}
	st, err := relayconvert.NewResponseStreamState(t.endpoint.format, t.caller.format, so)
	if err != nil {
		return nil, err
	}
	return &Stream{t: t, st: st, w: t.caller.newWriter(t, o)}, nil
}

// Event converts the data of one upstream server-sent event. It returns the
// events to send the Caller, framed and ready to write (possibly none). An
// *UpstreamError is an error event from the Provider: the stream is over.
func (s *Stream) Event(ctx context.Context, data []byte) ([]byte, error) {
	ev := s.t.endpoint.upstream(data)
	if ev.err != nil {
		return nil, ev.err
	}
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
	res, err := relayconvert.ConvertStreamResponseChunk(ctx, s.t.metaOrEmpty(), s.st, in)
	if err != nil {
		return nil, fmt.Errorf("a stream event cannot be translated to %s: %w", s.t.caller.shape, err)
	}
	return s.write(res)
}

// End finishes the stream after the upstream's last event and returns the
// closing events. A stream whose answer never completed (no final event
// from the Provider) gets ErrIncomplete and nothing invented.
func (s *Stream) End(ctx context.Context) ([]byte, error) {
	if !s.complete {
		return nil, ErrIncomplete
	}
	// The usage merged over every event and step: a converter that goes
	// through Chat would otherwise close with the last chunk's counts only
	// (Anthropic's input tokens arrive in message_start).
	if u := s.st.Usage(); u != nil {
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
	return append(out, s.w.end(s.st.Usage())...), nil
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

// defaultMaxTokens is the max_tokens a request to Anthropic gets when the
// Caller set none (Anthropic requires it): the model family's usual output
// limit, else a conservative 4096. Model metadata (ticket 11) may refine it.
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

// toMap turns a RelayKit DTO into a JSON object to fix up.
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

// marshal encodes v compactly without HTML escaping.
func marshal(v any) ([]byte, error) {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), nil
}

// usageMap is RelayKit's usage as a JSON object.
func usageMap(u *dto.Usage) map[string]any {
	if u == nil {
		return nil
	}
	m, _ := toMap(u)
	return m
}
