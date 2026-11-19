package gateway

import (
	"net/http"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/providers"
)

// A non-stream Caller never waits past Cloudflare's 100 s either. The
// first-byte budget (at most 95 s) bounds the wait for an upstream answer to
// begin, but once a 2xx answer's headers arrived Iroha reads its whole body
// before anything reaches the Caller (embedded errors, normalisers and
// translation need it), and a Provider can take minutes to write it
// (OpenRouter sends its headers at once and generates behind them). So,
// while an upstream 2xx answer is being read for a non-stream Request:
//
//   - When the Caller has got nothing AnswerCommitAfter after the Request
//     arrived and AnswerGrace after the upstream headers (never later than
//     the 95 s first-byte ceiling, measured from arrival), Iroha commits the
//     response: 200 and Content-Type application/json, no body yet.
//   - From then on a newline goes out after every KeepAliveEvery of silence.
//     Whitespace before a JSON value is valid JSON, so every client parses
//     the answer that follows, which is written as it would have been.
//   - A failure after the commit (every later Attempt failed, the body broke
//     off, Iroha shut down) is the JSON error body in the Caller's Shape,
//     under the 200 already sent; the Request records status 200 with the
//     error code, as a committed stream does.
//
// An answer whose body follows its headers in time is untouched, and while
// Iroha waits for an upstream answer to begin nothing is committed, so
// failures before that keep their HTTP status.
const (
	AnswerCommitAfter = StreamCommitAfter
	AnswerGrace       = 5 * time.Second
)

// padding keeps a committed non-stream answer's connection busy.
var padding = []byte("\n")

// padder is the keeper of a non-stream Request's answer (answerBegan).
type padder struct {
	timer      clock.Timer
	quit, done chan struct{}
}

// answerBegan notes that a 2xx answer for a non-stream Request began
// arriving (its headers), and arms the commit.
func (x *exchange) answerBegan() {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.wrote || x.ended {
		return
	}
	now := x.g.clock.Now()
	x.answering = true
	at := x.start.Add(AnswerCommitAfter)
	if g := now.Add(AnswerGrace); g.After(at) {
		at = g
	}
	if c := x.start.Add(providers.FirstByteCeiling); at.After(c) {
		at = c
	}
	d := at.Sub(now)
	if x.pad != nil {
		x.pad.timer.Reset(d)
		return
	}
	p := &padder{timer: x.g.clock.NewTimer(d), quit: make(chan struct{}), done: make(chan struct{})}
	x.pad = p
	go func() {
		defer close(p.done)
		defer p.timer.Stop()
		for {
			select {
			case <-p.quit:
				return
			case <-p.timer.C():
			}
			if !x.padTick(p.timer) {
				return
			}
		}
	}()
}

// answerEnded notes that the answer being read did not reach the Caller
// (the Attempt failed): until the next one begins, nothing is committed.
func (x *exchange) answerEnded() {
	x.mu.Lock()
	x.answering = false
	x.mu.Unlock()
}

// padTick is one wake-up of the padder: commit, or keep a committed answer
// alive. It reports false when there is nothing more to do.
func (x *exchange) padTick(t clock.Timer) bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.ended || (x.wrote && !x.padded) {
		return false // answered
	}
	now := x.g.clock.Now()
	if !x.wrote {
		if !x.answering {
			return true // the next answerBegan re-arms the timer
		}
		x.w.Header().Set("Content-Type", "application/json")
		x.w.WriteHeader(http.StatusOK)
		x.wrote, x.padded, x.committed = true, true, true
		x.lastWrite = now
		if f, ok := x.w.(http.Flusher); ok {
			f.Flush()
		}
		t.Reset(KeepAliveEvery)
		return true
	}
	if due := x.lastWrite.Add(KeepAliveEvery); now.Before(due) {
		t.Reset(due.Sub(now))
		return true
	}
	t.Reset(KeepAliveEvery)
	_ = x.sendLocked(padding) // a failed write is noticed by the relay
	return true
}

// stopPadding ends the padder, if one started.
func (x *exchange) stopPadding() {
	x.mu.Lock()
	p := x.pad
	x.mu.Unlock()
	if p != nil {
		close(p.quit)
		<-p.done
	}
}
