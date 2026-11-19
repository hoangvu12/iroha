package gateway

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/shape"
)

// A streaming Caller never waits in silence. Proxies between Iroha and the
// Caller (Cloudflare cuts at 100 s, Bun and nginx idle limits) close quiet
// connections, so:
//
//   - When no upstream answer has arrived StreamCommitAfter after the
//     Request arrived, Iroha commits the response: 200 and stream headers,
//     then a keep-alive. From then on the status cannot change, so a later
//     failure (every Attempt failed, the budget ran out, the stream broke,
//     Iroha shut down) is sent as an error event in the Caller's Shape,
//     carrying the same code, hint and Attempt summary as the HTTP error.
//   - While the stream is open, a keep-alive goes out whenever nothing was
//     written for KeepAliveEvery: before the first upstream byte and during
//     pauses mid-stream alike.
//
// Before commitment failures keep their HTTP status. Non-stream Requests
// are never committed early; their first-byte budget stays under 100 s.
const (
	StreamCommitAfter = 10 * time.Second
	KeepAliveEvery    = 15 * time.Second
)

// streamShape frames Iroha's own events on a stream in one Caller Shape.
// Each Shape the Gateway serves streams in adds an implementation to
// streamShapes.
type streamShape interface {
	// keepAlive is an event the Shape's clients ignore.
	keepAlive() []byte
	// errorEvent is the last event of a stream that failed after the
	// response was committed.
	errorEvent(e *api.Error, requestID string) []byte
}

var streamShapes = map[shape.Shape]streamShape{
	shape.OpenAIChat: openAIChatStream{},
}

// openAIChatStream: SSE comments keep the stream alive; an error is a data
// event holding the OpenAI error envelope, which the OpenAI SDKs raise as
// an API error. No [DONE] follows it: the answer did not complete.
type openAIChatStream struct{}

func (openAIChatStream) keepAlive() []byte { return []byte(": keep-alive\n\n") }

func (openAIChatStream) errorEvent(e *api.Error, requestID string) []byte {
	return append(append([]byte("data: "), compactJSON(openAIError(e, requestID))...), "\n\n"...)
}

// openAIError is the OpenAI error envelope extended with Iroha's hint, the
// Request ID and the details.
func openAIError(e *api.Error, requestID string) map[string]any {
	inner := map[string]any{
		"message":    e.Message,
		"type":       errorType(e.Status),
		"param":      nil,
		"code":       e.Code,
		"hint":       e.Hint,
		"request_id": requestID,
	}
	if e.Details != nil {
		inner["details"] = e.Details
	}
	return map[string]any{"error": inner}
}

func compactJSON(v any) []byte {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

// keepAlive runs the keeper of a streaming Request until the returned stop
// is called: it commits the response at StreamCommitAfter if nothing was
// written yet, then sends a keep-alive after every KeepAliveEvery of
// silence. Every write to the Caller goes through x.mu, so keep-alives
// never land inside a relayed event.
func (x *exchange) keepAlive() (stop func()) {
	frame := streamShapes[x.rec.ShapeIn]
	if frame == nil {
		return func() {}
	}
	t := x.g.clock.NewTimer(StreamCommitAfter - clock.Since(x.g.clock, x.start))
	quit, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		defer t.Stop()
		for {
			select {
			case <-quit:
				return
			case <-t.C():
			}
			if !x.tick(t, frame) {
				return
			}
		}
	}()
	return func() { close(quit); <-done }
}

// tick is one wake-up of the keeper. It re-arms t before writing, so once a
// keep-alive reached the Caller the next one is already scheduled. It
// reports false when the keeper has nothing more to do.
func (x *exchange) tick(t clock.Timer, frame streamShape) bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.ended || (x.wrote && !x.streaming) {
		return false // answered, or a non-stream answer is being written
	}
	now := x.g.clock.Now()
	if !x.wrote {
		t.Reset(KeepAliveEvery)
		h := x.w.Header()
		h.Set("Content-Type", "text/event-stream")
		h.Set("Cache-Control", "no-cache")
		x.w.WriteHeader(http.StatusOK)
		x.wrote, x.streaming, x.committed = true, true, true
		x.sendLocked(frame.keepAlive())
		return true
	}
	if due := x.lastWrite.Add(KeepAliveEvery); now.Before(due) {
		t.Reset(due.Sub(now))
		return true
	}
	t.Reset(KeepAliveEvery)
	x.sendLocked(frame.keepAlive()) // a failed write is noticed by the relay
	return true
}

// send writes b to the Caller and flushes it.
func (x *exchange) send(b []byte) error {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.sendLocked(b)
}

func (x *exchange) sendLocked(b []byte) error {
	x.lastWrite = x.g.clock.Now()
	if _, err := x.w.Write(b); err != nil {
		return err
	}
	if f, ok := x.w.(http.Flusher); ok {
		f.Flush()
	}
	return nil
}

// setHeader sets a response header unless the status line went out (a
// committed stream keeps its headers).
func (x *exchange) setHeader(key, value string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	if !x.wrote {
		x.w.Header().Set(key, value)
	}
}

// isCommitted reports whether Iroha committed the response before any
// upstream answer.
func (x *exchange) isCommitted() bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	return x.committed
}
