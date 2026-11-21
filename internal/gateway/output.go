package gateway

import (
	"net/http"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/shape"
)

type callerOutput struct {
	clock     clock.Clock
	shape     shape.Shape
	requestID string

	mu             sync.Mutex
	w              http.ResponseWriter
	wrote          bool
	streaming      bool
	committed      bool
	padded         bool
	ended          bool
	answering      bool
	lastWrite      time.Time
	commit         *alarm
	keepAlive      *alarm
	keepersStopped bool
}

func newCallerOutput(w http.ResponseWriter, c clock.Clock, sh shape.Shape, requestID string) *callerOutput {
	return &callerOutput{w: w, clock: c, shape: sh, requestID: requestID}
}

func (o *callerOutput) wrap(wrapper func(http.ResponseWriter) http.ResponseWriter) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.w = wrapper(o.w)
}

func (o *callerOutput) setHeader(key, value string) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if !o.wrote {
		o.w.Header().Set(key, value)
	}
}

func (o *callerOutput) writeHead(status int, contentType string, stream bool) (sent, answerFits bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.committed {
		return false, stream || o.padded
	}
	h := o.w.Header()
	h.Set("Content-Type", contentType)
	if stream {
		h.Set("Cache-Control", "no-cache")
	}
	o.wrote, o.streaming = true, stream
	o.w.WriteHeader(status)
	if stream {
		o.lastWrite = o.clock.Now()
		o.armKeepAliveLocked()
		o.flushLocked()
	}
	return true, true
}

func (o *callerOutput) send(b []byte) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.sendLocked(b)
}

func (o *callerOutput) sendLocked(b []byte) error {
	o.lastWrite = o.clock.Now()
	o.armKeepAliveLocked()
	if _, err := o.w.Write(b); err != nil {
		return err
	}
	o.flushLocked()
	return nil
}

func (o *callerOutput) flushLocked() {
	if f, ok := o.w.(http.Flusher); ok {
		f.Flush()
	}
}

func (o *callerOutput) writeError(e *api.Error) (statusSent bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.ended {
		return false
	}
	o.ended = true
	if o.streaming {
		_ = o.sendLocked(specOrChat(o.shape).stream.errorEvent(e, o.requestID))
		return false
	}
	if o.padded {
		_, _ = o.w.Write(append(compactJSON(errorEnvelope(o.shape, e, o.requestID)), '\n'))
		return false
	}
	if o.wrote {
		return false
	}
	o.wrote = true
	o.w.Header().Set("Content-Type", "application/json")
	o.w.WriteHeader(e.Status)
	_, _ = o.w.Write(append(compactJSON(errorEnvelope(o.shape, e, o.requestID)), '\n'))
	return true
}

func (o *callerOutput) end() {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.ended = true
}

func (o *callerOutput) isCommitted() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.committed
}

func (o *callerOutput) isStreaming() bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.streaming
}

func (o *callerOutput) armKeepAliveLocked() {
	if o.keepersStopped || o.ended || !(o.streaming || o.padded) {
		return
	}
	if o.keepAlive == nil {
		o.keepAlive = newAlarm(o.clock, KeepAliveEvery, o.keepAliveDue)
		return
	}
	o.keepAlive.reset(KeepAliveEvery)
}

func (o *callerOutput) keepAliveDue() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.ended || o.clock.Now().Before(o.lastWrite.Add(KeepAliveEvery)) {
		return
	}
	frame := padding
	if o.streaming {
		frame = specOrChat(o.shape).stream.keepAlive()
	}
	_ = o.sendLocked(frame)
}

func (o *callerOutput) stopKeepers() {
	o.mu.Lock()
	o.keepersStopped = true
	keepers := []*alarm{o.commit, o.keepAlive}
	o.mu.Unlock()
	for _, a := range keepers {
		if a != nil {
			a.stop()
		}
	}
}
