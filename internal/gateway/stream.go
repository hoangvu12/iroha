package gateway

import (
	"bytes"
	"encoding/json"
	"net/http"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
)

// Cloudflare answers 524 when the origin stays silent past its Proxy Read
// Timeout: 100 s for years, 125 s by default today
// (https://developers.cloudflare.com/fundamentals/reference/connection-limits/).
const (
	StreamCommitAfter = 10 * time.Second
	KeepAliveEvery    = 15 * time.Second
)

type streamShape interface {
	keepAlive() []byte
	errorEvent(e *api.Error, requestID string) []byte
}

// The Anthropic SDKs skip ping events and raise an error event as an API
// error.
type anthropicStream struct{}

func (anthropicStream) keepAlive() []byte {
	return []byte("event: ping\ndata: {\"type\":\"ping\"}\n\n")
}

func (anthropicStream) errorEvent(e *api.Error, requestID string) []byte {
	return append(append([]byte("event: error\ndata: "), compactJSON(anthropicError(e, requestID))...), "\n\n"...)
}

func anthropicError(e *api.Error, requestID string) map[string]any {
	inner := map[string]any{
		"type":       anthropicErrorType(e.Status),
		"message":    e.Message,
		"code":       e.Code,
		"hint":       e.Hint,
		"request_id": requestID,
	}
	if e.Details != nil {
		inner["details"] = e.Details
	}
	return map[string]any{"type": "error", "error": inner, "request_id": requestID}
}

func anthropicErrorType(status int) string {
	switch {
	case status == http.StatusUnauthorized:
		return "authentication_error"
	case status == http.StatusPaymentRequired:
		return "billing_error"
	case status == http.StatusForbidden:
		return "permission_error"
	case status == http.StatusNotFound:
		return "not_found_error"
	case status == http.StatusRequestEntityTooLarge:
		return "request_too_large"
	case status == http.StatusTooManyRequests:
		return "rate_limit_error"
	case status == http.StatusGatewayTimeout:
		return "timeout_error"
	case status == 529 || status == http.StatusServiceUnavailable:
		return "overloaded_error"
	case status >= 500:
		return "api_error"
	}
	return "invalid_request_error"
}

// SSE clients skip comments. The OpenAI SDKs raise a data event holding an
// error object as an API error.
type openAIChatStream struct{}

func (openAIChatStream) keepAlive() []byte { return []byte(": keep-alive\n\n") }

func (openAIChatStream) errorEvent(e *api.Error, requestID string) []byte {
	return append(append([]byte("data: "), compactJSON(openAIError(e, requestID))...), "\n\n"...)
}

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

func (o *callerOutput) commitStreamAt(at time.Time) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.keepersStopped || o.commit != nil {
		return
	}
	o.commit = newAlarm(o.clock, at.Sub(o.clock.Now()), o.commitStream)
}

func (o *callerOutput) commitStream() {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.keepersStopped || o.wrote || o.ended {
		return
	}
	h := o.w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	o.w.WriteHeader(http.StatusOK)
	o.wrote, o.streaming, o.committed = true, true, true
	_ = o.sendLocked(specOrChat(o.shape).stream.keepAlive())
}
