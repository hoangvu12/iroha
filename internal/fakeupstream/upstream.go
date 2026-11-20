// Package fakeupstream is a programmable fake Provider for one Shape: a
// real HTTP server on localhost that records every request and answers from
// a queue of Responders. It needs no testing.TB, so the dev launcher
// (cmd/iroha-dev) runs the same fakes the tests use; internal/testkit wraps
// it with helpers that fail the test.
package fakeupstream

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/shape"
)

// Upstream is a programmable fake Provider speaking one Shape. It records
// every request it receives and answers inference calls from a queue of
// Responders, then from a default (a short text reply in its Shape).
//
//	up := fakeupstream.New(shape.OpenAIChat, clock.Real{})
//	defer up.Close()
//	up.Enqueue(up.Error(429, "slow down").Header("Retry-After", "30"), up.Text("hello"))
//	... point an Endpoint at up.URL() ...
//	got := up.Last()  // what Iroha sent: headers, body, model
type Upstream struct {
	Shape shape.Shape
	clock clock.Clock // Received.At and reply delays
	srv   *httptest.Server
	ctl   atomic.Bool // answers ControlPath (EnableControl)

	mu       sync.Mutex
	queue    []Responder
	fallback Responder
	custom   map[string]Responder // "METHOD /path"
	models   []string
	usage    Usage
	served   string // the model answers name; empty: the one requested
	received []*Received
	arrived  chan struct{} // closed and replaced on every request
	seq      int

	written atomic.Int64 // reply body bytes written so far (Written)
}

// Usage is the token usage a fake reports. Input counts every prompt
// token; CacheRead of them were read from the cache (0: no cache fields).
type Usage struct{ Input, Output, CacheRead int }

// Received is one request the fake got.
type Received struct {
	Method string
	Path   string
	Query  url.Values
	Header http.Header
	Body   []byte
	Model  string // from the JSON body, or the Gemini URL path
	Stream bool   // the request asked for a stream
	At     time.Time
	// Seq is 1 for the first request this fake received, 2 for the next...
	Seq int
}

// Fataler is the part of testing.TB the decoding helpers need.
type Fataler interface {
	Helper()
	Fatalf(format string, args ...any)
}

// JSON decodes the received body into v, failing the test on error.
func (r *Received) JSON(t Fataler, v any) {
	t.Helper()
	if err := json.Unmarshal(r.Body, v); err != nil {
		t.Fatalf("upstream received a body that is not JSON: %v\n%s", err, r.Body)
	}
}

// Map decodes the received body as a JSON object.
func (r *Received) Map(t Fataler) map[string]any {
	t.Helper()
	var m map[string]any
	r.JSON(t, &m)
	return m
}

// Bearer returns the token of the Authorization header, or "".
func (r *Received) Bearer() string {
	h := r.Header.Get("Authorization")
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return h[7:]
	}
	return ""
}

// Responder decides the Reply to a received request.
type Responder func(r *Received) Reply

// Reply is what a fake sends back.
type Reply struct {
	Status int // default 200
	Header http.Header
	Body   []byte
	// Chunks are written after Body, each flushed on its own, for streams.
	Chunks []Chunk
	// Delay waits (on the fake's clock) before anything is written.
	Delay time.Duration
	// Wait holds the reply until the channel is closed or the caller goes away.
	Wait <-chan struct{}
	// Disconnect drops the connection after writing whatever is given; with
	// nothing given the caller sees a network error and no status at all.
	Disconnect bool
}

// Chunk is one piece of a streamed body.
type Chunk struct {
	Data  []byte
	Delay time.Duration   // wait (on the fake's clock) before this chunk
	Wait  <-chan struct{} // hold this chunk until closed
}

// Header returns a Responder that also sets a response header.
func (rs Responder) Header(key, value string) Responder {
	return func(r *Received) Reply {
		rep := rs(r)
		if rep.Header == nil {
			rep.Header = http.Header{}
		}
		rep.Header.Set(key, value)
		return rep
	}
}

// After returns a Responder that waits d (on the fake's clock) before replying.
func (rs Responder) After(d time.Duration) Responder {
	return func(r *Received) Reply { rep := rs(r); rep.Delay = d; return rep }
}

// HoldUntil returns a Responder that holds its reply until ch is closed.
func (rs Responder) HoldUntil(ch <-chan struct{}) Responder {
	return func(r *Received) Reply { rep := rs(r); rep.Wait = ch; return rep }
}

// ThenDisconnect returns a Responder that drops the connection after its
// body and chunks, so a stream ends without its terminator.
func (rs Responder) ThenDisconnect() Responder {
	return func(r *Received) Reply { rep := rs(r); rep.Disconnect = true; return rep }
}

// JSON replies with status and v encoded as JSON.
func JSON(status int, v any) Responder {
	body, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return Raw(status, "application/json", string(body))
}

// Raw replies with status, content type and body exactly.
func Raw(status int, contentType, body string) Responder {
	return func(*Received) Reply {
		return Reply{Status: status, Header: http.Header{"Content-Type": {contentType}}, Body: []byte(body)}
	}
}

// SSE replies 200 with each event written and flushed as its own chunk.
// Pass complete event texts such as "data: {...}\n\n".
func SSE(events ...string) Responder {
	return func(*Received) Reply {
		rep := Reply{Status: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}}
		for _, e := range events {
			rep.Chunks = append(rep.Chunks, Chunk{Data: []byte(e)})
		}
		return rep
	}
}

// Hang never replies; the request ends only when the caller gives up.
func Hang() Responder {
	return func(*Received) Reply { return Reply{Wait: make(chan struct{})} }
}

// Drop closes the connection without any response.
func Drop() Responder {
	return func(*Received) Reply { return Reply{Disconnect: true} }
}

// New starts a fake speaking sh on a free localhost port. Tests pass
// clock.Real{}: replies wait in real time even when Iroha runs on a fake
// clock. Close stops it.
func New(sh shape.Shape, c clock.Clock) *Upstream {
	u := &Upstream{Shape: sh, clock: c, custom: map[string]Responder{}, usage: Usage{Input: 10, Output: 5}, arrived: make(chan struct{})}
	u.srv = httptest.NewServer(http.HandlerFunc(u.serve))
	return u
}

// Close stops the fake, ending held replies first.
func (u *Upstream) Close() {
	u.srv.CloseClientConnections() // ends held replies so Close does not wait on them
	u.srv.Close()
}

// Origin is the fake's scheme and host, e.g. http://127.0.0.1:51234.
func (u *Upstream) Origin() string { return u.srv.URL }

// URL is the Endpoint URL to configure, including the version path:
// .../v1 for OpenAI and Anthropic, .../v1beta for Gemini.
func (u *Upstream) URL() string { return u.srv.URL + u.basePath() }

// URLAt is the Endpoint URL on host (http://<host>/v1), for an Iroha
// started with Options{HTTPClient: up.Client()}: the Endpoint carries a
// Provider's real host name, which built-in Failure Rules match on, while
// this fake answers.
func (u *Upstream) URLAt(host string) string { return "http://" + host + u.basePath() }

// Client is an HTTP client that sends every request, whatever its host, to
// this fake. Pass it as Options.HTTPClient together with URLAt. Close its
// idle connections when done with it.
func (u *Upstream) Client() *http.Client {
	addr := strings.TrimPrefix(u.srv.URL, "http://")
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.Proxy = nil
	tr.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, network, addr)
	}
	return &http.Client{Transport: tr}
}

func (u *Upstream) basePath() string {
	if u.Shape == shape.Gemini {
		return "/v1beta"
	}
	return "/v1"
}

// Enqueue adds Responders for the next inference requests, in order. When
// the queue is empty the default answers.
func (u *Upstream) Enqueue(rs ...Responder) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.queue = append(u.queue, rs...)
}

// Default replaces the Responder used when the queue is empty.
func (u *Upstream) Default(r Responder) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.fallback = r
}

// Handle answers method and path (exact, without query) with r, for routes
// other than the Shape's inference and model-list routes, or to override them.
func (u *Upstream) Handle(method, path string, r Responder) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.custom[method+" "+path] = r
}

// SetModels sets what the Shape's model-list route returns.
func (u *Upstream) SetModels(ids ...string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.models = append([]string(nil), ids...)
}

// SetServedModel makes Text and Stream replies name model as the one that
// served them (a dated snapshot, a router's choice) instead of echoing the
// model the request named. Empty restores the echo.
func (u *Upstream) SetServedModel(model string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.served = model
}

// servedModel is the model a reply to r names.
func (u *Upstream) servedModel(r *Received) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.served != "" {
		return u.served
	}
	return r.Model
}

// SetUsage sets the token usage reported by Text and Stream replies, with
// no cache reads.
func (u *Upstream) SetUsage(input, output int) {
	u.SetUsageWith(Usage{Input: input, Output: output})
}

// SetUsageWith sets the whole usage reported by Text and Stream replies,
// cache reads included.
func (u *Upstream) SetUsageWith(us Usage) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.usage = us
}

// Reset empties the queue of Responders, removes the default and custom
// routes and forgets the requests received. Usage and models stay.
func (u *Upstream) Reset() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.queue, u.fallback, u.received = nil, nil, nil
	u.custom = map[string]Responder{}
}

// Queued is how many Enqueued Responders are still waiting.
func (u *Upstream) Queued() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.queue)
}

// Requests returns every request received so far, oldest first.
func (u *Upstream) Requests() []*Received {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]*Received(nil), u.received...)
}

// Count is the number of requests received.
func (u *Upstream) Count() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return len(u.received)
}

// Last returns the latest request, or nil when none arrived.
func (u *Upstream) Last() *Received {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.received) == 0 {
		return nil
	}
	return u.received[len(u.received)-1]
}

// Await waits until at least n requests arrived, for callers whose replies
// are held, and returns the n-th request; nil when ctx ends first.
func (u *Upstream) Await(ctx context.Context, n int) *Received {
	for {
		u.mu.Lock()
		if len(u.received) >= n {
			r := u.received[n-1]
			u.mu.Unlock()
			return r
		}
		ch := u.arrived
		u.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return nil
		}
	}
}

func (u *Upstream) serve(w http.ResponseWriter, req *http.Request) {
	if u.ctl.Load() && strings.HasPrefix(req.URL.Path, ControlPath+"/") {
		u.control(w, req)
		return
	}
	body, _ := io.ReadAll(req.Body)
	rec := &Received{Method: req.Method, Path: req.URL.Path, Query: req.URL.Query(), Header: req.Header.Clone(), Body: body, At: u.clock.Now()}
	rec.Model, rec.Stream = u.inspect(rec)

	u.mu.Lock()
	u.seq++
	rec.Seq = u.seq
	u.received = append(u.received, rec)
	close(u.arrived)
	u.arrived = make(chan struct{})
	responder := u.pick(rec)
	u.mu.Unlock()

	u.write(w, req.Context(), responder(rec))
}

// Written is how many bytes of reply bodies (Body and Chunks, every request
// together) the fake has handed to its connections so far. A write returns
// once the connection accepts the bytes, so a reader that stops reading
// stops this count growing once the buffers between them are full.
func (u *Upstream) Written() int64 { return u.written.Load() }

// pick chooses the Responder; u.mu is held.
func (u *Upstream) pick(r *Received) Responder {
	if u.ctl.Load() {
		if rs, ok := u.markedFailure(r); ok {
			return rs
		}
	}
	if c, ok := u.custom[r.Method+" "+r.Path]; ok {
		return c
	}
	switch u.route(r) {
	case routeInference:
		if len(u.queue) > 0 {
			next := u.queue[0]
			u.queue = u.queue[1:]
			return next
		}
		if u.fallback != nil {
			return u.fallback
		}
		return u.text("Hello from the fake " + string(u.Shape) + " upstream.")
	case routeModels:
		return u.modelList(append([]string(nil), u.models...))
	}
	return u.errorReply(http.StatusNotFound, "not_found", "the fake "+string(u.Shape)+" upstream has no route "+r.Method+" "+r.Path)
}

type route int

const (
	routeOther route = iota
	routeInference
	routeModels
)

func (u *Upstream) route(r *Received) route {
	switch u.Shape {
	case shape.OpenAIChat:
		if r.Method == http.MethodPost && r.Path == "/v1/chat/completions" {
			return routeInference
		}
	case shape.OpenAIResponses:
		if r.Method == http.MethodPost && r.Path == "/v1/responses" {
			return routeInference
		}
	case shape.AnthropicMessages:
		if r.Method == http.MethodPost && r.Path == "/v1/messages" {
			return routeInference
		}
	case shape.Gemini:
		if r.Method == http.MethodPost && strings.HasPrefix(r.Path, "/v1beta/models/") &&
			(strings.HasSuffix(r.Path, ":generateContent") || strings.HasSuffix(r.Path, ":streamGenerateContent")) {
			return routeInference
		}
		if r.Method == http.MethodGet && r.Path == "/v1beta/models" {
			return routeModels
		}
		return routeOther
	}
	if r.Method == http.MethodGet && r.Path == "/v1/models" {
		return routeModels
	}
	return routeOther
}

func (u *Upstream) inspect(r *Received) (model string, stream bool) {
	if u.Shape == shape.Gemini {
		rest := strings.TrimPrefix(r.Path, "/v1beta/models/")
		if i := strings.LastIndex(rest, ":"); i >= 0 {
			return rest[:i], strings.HasSuffix(rest, ":streamGenerateContent")
		}
		return "", false
	}
	var b struct {
		Model  string `json:"model"`
		Stream bool   `json:"stream"`
	}
	_ = json.Unmarshal(r.Body, &b)
	return b.Model, b.Stream
}

func (u *Upstream) write(w http.ResponseWriter, ctx context.Context, rep Reply) {
	written := &u.written
	if !u.pause(ctx, rep.Delay, rep.Wait) {
		return
	}
	if rep.Disconnect && rep.Status == 0 && len(rep.Body) == 0 && len(rep.Chunks) == 0 {
		panic(http.ErrAbortHandler) // closes the connection with no response
	}
	for k, vs := range rep.Header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	status := rep.Status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	flusher, _ := w.(http.Flusher)
	if len(rep.Body) > 0 {
		n, _ := w.Write(rep.Body)
		written.Add(int64(n))
	}
	if flusher != nil {
		flusher.Flush()
	}
	for _, c := range rep.Chunks {
		if !u.pause(ctx, c.Delay, c.Wait) {
			return
		}
		if _, err := w.Write(c.Data); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
		written.Add(int64(len(c.Data))) // counted once flushed to the connection
	}
	if rep.Disconnect {
		panic(http.ErrAbortHandler)
	}
}

// pause waits d and then wait, returning false if the caller went away.
func (u *Upstream) pause(ctx context.Context, d time.Duration, wait <-chan struct{}) bool {
	if d > 0 {
		t := u.clock.NewTimer(d)
		defer t.Stop()
		select {
		case <-t.C():
		case <-ctx.Done():
			return false
		}
	}
	if wait != nil {
		select {
		case <-wait:
		case <-ctx.Done():
			return false
		}
	}
	return true
}

// compactJSON marshals v without HTML escaping.
func compactJSON(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		panic(err)
	}
	return strings.TrimSuffix(b.String(), "\n")
}
