package testkit

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/fakeupstream"
	"github.com/hoangvu12/iroha/internal/shape"
)

// Upstream is a programmable fake Provider speaking one Shape, stopped when
// the test ends. The fake itself is internal/fakeupstream (cmd/iroha-dev
// runs the same one); this wrapper fails the test where the fake would
// return nothing.
//
//	up := testkit.NewOpenAIChat(t)
//	up.Enqueue(up.Error(429, "slow down").Header("Retry-After", "30"), up.Text("hello"))
//	... point an Endpoint at up.URL() ...
//	got := up.Last()  // what Iroha sent: headers, body, model
type Upstream struct {
	*fakeupstream.Upstream
	t testing.TB
}

// The fake's types, under the names tests have always used.
type (
	Usage     = fakeupstream.Usage
	Received  = fakeupstream.Received
	Responder = fakeupstream.Responder
	Reply     = fakeupstream.Reply
	Chunk     = fakeupstream.Chunk
)

// JSON replies with status and v encoded as JSON.
func JSON(status int, v any) Responder { return fakeupstream.JSON(status, v) }

// Raw replies with status, content type and body exactly.
func Raw(status int, contentType, body string) Responder {
	return fakeupstream.Raw(status, contentType, body)
}

// SSE replies 200 with each event written and flushed as its own chunk.
// Pass complete event texts such as "data: {...}\n\n".
func SSE(events ...string) Responder { return fakeupstream.SSE(events...) }

// Hang never replies; the request ends only when the caller gives up.
func Hang() Responder { return fakeupstream.Hang() }

// Drop closes the connection without any response.
func Drop() Responder { return fakeupstream.Drop() }

// NewUpstream starts a fake speaking sh. It stops when the test ends.
// Replies' delays are real time, whatever clock Iroha runs on.
func NewUpstream(t testing.TB, sh shape.Shape) *Upstream {
	t.Helper()
	u := fakeupstream.New(sh, clock.Real{})
	t.Cleanup(u.Close)
	return &Upstream{Upstream: u, t: t}
}

// NewOpenAIChat starts a fake OpenAI Chat Completions Provider.
func NewOpenAIChat(t testing.TB) *Upstream { return NewUpstream(t, shape.OpenAIChat) }

// NewOpenAIResponses starts a fake OpenAI Responses Provider.
func NewOpenAIResponses(t testing.TB) *Upstream { return NewUpstream(t, shape.OpenAIResponses) }

// NewAnthropic starts a fake Anthropic Messages Provider.
func NewAnthropic(t testing.TB) *Upstream { return NewUpstream(t, shape.AnthropicMessages) }

// NewGemini starts a fake Gemini Provider.
func NewGemini(t testing.TB) *Upstream { return NewUpstream(t, shape.Gemini) }

// Client is an HTTP client that sends every request, whatever its host, to
// this fake. Pass it as Options.HTTPClient together with URLAt.
func (u *Upstream) Client() *http.Client {
	c := u.Upstream.Client()
	u.t.Cleanup(c.CloseIdleConnections)
	return c
}

// Last returns the latest request, failing the test if there is none.
func (u *Upstream) Last() *Received {
	u.t.Helper()
	r := u.Upstream.Last()
	if r == nil {
		u.t.Fatalf("fake %s upstream received no request", u.Shape)
	}
	return r
}

// Await waits (up to 10 s real time) until at least n requests arrived,
// for tests whose replies are held. It returns the n-th request.
func (u *Upstream) Await(n int) *Received {
	u.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r := u.Upstream.Await(ctx, n)
	if r == nil {
		u.t.Fatalf("fake %s upstream: waited 10s for request %d, got %d", u.Shape, n, u.Count())
	}
	return r
}
