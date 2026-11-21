package gateway

import (
	"net/http"
	"time"

	"github.com/hoangvu12/iroha/internal/providers"
)

// Cloudflare's Proxy Read Timeout (stream.go) cuts non-stream answers too.
// OpenRouter sends a non-stream answer's 200 and headers as soon as the
// provider accepts the request, before generating. Whitespace before a JSON
// value is valid JSON (RFC 8259).
const (
	AnswerCommitAfter = StreamCommitAfter
	AnswerGrace       = 5 * time.Second
)

var padding = []byte("\n")

func (x *exchange) answerBegan() {
	at := x.start.Add(AnswerCommitAfter)
	if grace := x.g.clock.Now().Add(AnswerGrace); grace.After(at) {
		at = grace
	}
	if ceiling := x.start.Add(providers.FirstByteCeiling); at.After(ceiling) {
		at = ceiling
	}
	x.out.commitAnswerAt(at)
}

func (o *callerOutput) commitAnswerAt(at time.Time) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.keepersStopped || o.wrote || o.ended {
		return
	}
	o.answering = true
	d := at.Sub(o.clock.Now())
	if o.commit == nil {
		o.commit = newAlarm(o.clock, d, o.commitAnswer)
		return
	}
	o.commit.reset(d)
}

func (o *callerOutput) answerEnded() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.answering = false
}

func (o *callerOutput) commitAnswer() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.keepersStopped || o.wrote || o.ended || !o.answering {
		return
	}
	o.w.Header().Set("Content-Type", "application/json")
	o.w.WriteHeader(http.StatusOK)
	o.wrote, o.padded, o.committed = true, true, true
	o.lastWrite = o.clock.Now()
	o.armKeepAliveLocked()
	o.flushLocked()
}
