package testkit

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/shape"
)

// Upstream is a programmable fake Provider speaking one Shape. It records
// every request it receives and answers inference calls from a queue of
// Responders, then from a default (a short text reply in its Shape).
//
//	up := testkit.NewOpenAIChat(t)
//	up.Enqueue(up.Error(429, "slow down").Header("Retry-After", "30"), up.Text("hello"))
//	... point an Endpoint at up.URL() ...
//	got := up.Last()  // what Iroha sent: headers, body, model
type Upstream struct {
	Shape shape.Shape
	t     testing.TB
	srv   *httptest.Server

	mu       sync.Mutex
	queue    []Responder
	fallback Responder
	custom   map[string]Responder // "METHOD /path"
	models   []string
	usage    Usage
	received []*Received
	arrived  chan struct{} // closed and replaced on every request
	seq      int
}

// Usage is the token usage a fake reports.
type Usage struct{ Input, Output int }

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

// JSON decodes the received body into v, failing the test on error.
func (r *Received) JSON(t testing.TB, v any) {
	t.Helper()
	if err := json.Unmarshal(r.Body, v); err != nil {
		t.Fatalf("upstream received a body that is not JSON: %v\n%s", err, r.Body)
	}
}

// Map decodes the received body as a JSON object.
func (r *Received) Map(t testing.TB) map[string]any {
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
	// Delay sleeps (real time) before anything is written.
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
	Delay time.Duration   // real sleep before this chunk
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

// After returns a Responder that waits d (real time) before replying.
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

// NewUpstream starts a fake speaking sh. It stops when the test ends.
func NewUpstream(t testing.TB, sh shape.Shape) *Upstream {
	t.Helper()
	u := &Upstream{Shape: sh, t: t, custom: map[string]Responder{}, usage: Usage{Input: 10, Output: 5}, arrived: make(chan struct{})}
	u.srv = httptest.NewServer(http.HandlerFunc(u.serve))
	t.Cleanup(func() {
		u.srv.CloseClientConnections() // ends held replies so Close does not wait on them
		u.srv.Close()
	})
	return u
}

// NewOpenAIChat starts a fake OpenAI Chat Completions Provider.
func NewOpenAIChat(t testing.TB) *Upstream { return NewUpstream(t, shape.OpenAIChat) }

// NewOpenAIResponses starts a fake OpenAI Responses Provider.
func NewOpenAIResponses(t testing.TB) *Upstream { return NewUpstream(t, shape.OpenAIResponses) }

// NewAnthropic starts a fake Anthropic Messages Provider.
func NewAnthropic(t testing.TB) *Upstream { return NewUpstream(t, shape.AnthropicMessages) }

// NewGemini starts a fake Gemini Provider.
func NewGemini(t testing.TB) *Upstream { return NewUpstream(t, shape.Gemini) }

// Origin is the fake's scheme and host, e.g. http://127.0.0.1:51234.
func (u *Upstream) Origin() string { return u.srv.URL }

// URL is the Endpoint URL to configure, including the version path:
// .../v1 for OpenAI and Anthropic, .../v1beta for Gemini.
func (u *Upstream) URL() string { return u.srv.URL + u.basePath() }

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

// SetUsage sets the token usage reported by Text and Stream replies.
func (u *Upstream) SetUsage(input, output int) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.usage = Usage{Input: input, Output: output}
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

// Last returns the latest request, failing the test if there is none.
func (u *Upstream) Last() *Received {
	u.t.Helper()
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.received) == 0 {
		u.t.Fatalf("fake %s upstream received no request", u.Shape)
	}
	return u.received[len(u.received)-1]
}

// Await waits (up to 10 s real time) until at least n requests arrived,
// for tests whose replies are held. It returns the n-th request.
func (u *Upstream) Await(n int) *Received {
	u.t.Helper()
	deadline := time.After(10 * time.Second)
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
		case <-deadline:
			u.t.Fatalf("fake %s upstream: waited 10s for request %d, got %d", u.Shape, n, u.Count())
			return nil
		}
	}
}

func (u *Upstream) serve(w http.ResponseWriter, req *http.Request) {
	body, _ := io.ReadAll(req.Body)
	rec := &Received{Method: req.Method, Path: req.URL.Path, Query: req.URL.Query(), Header: req.Header.Clone(), Body: body, At: time.Now()}
	rec.Model, rec.Stream = u.inspect(rec)

	u.mu.Lock()
	u.seq++
	rec.Seq = u.seq
	u.received = append(u.received, rec)
	close(u.arrived)
	u.arrived = make(chan struct{})
	responder := u.pick(rec)
	u.mu.Unlock()

	write(w, req.Context(), responder(rec))
}

// pick chooses the Responder; u.mu is held.
func (u *Upstream) pick(r *Received) Responder {
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

func write(w http.ResponseWriter, ctx context.Context, rep Reply) {
	if !pause(ctx, rep.Delay, rep.Wait) {
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
		_, _ = w.Write(rep.Body)
	}
	if flusher != nil {
		flusher.Flush()
	}
	for _, c := range rep.Chunks {
		if !pause(ctx, c.Delay, c.Wait) {
			return
		}
		if _, err := w.Write(c.Data); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
	}
	if rep.Disconnect {
		panic(http.ErrAbortHandler)
	}
}

// pause waits d and then wait, returning false if the caller went away.
func pause(ctx context.Context, d time.Duration, wait <-chan struct{}) bool {
	if d > 0 {
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-t.C:
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
