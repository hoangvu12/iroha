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

type Upstream struct {
	*fakeupstream.Upstream
	t testing.TB
}

type (
	Usage     = fakeupstream.Usage
	Received  = fakeupstream.Received
	Responder = fakeupstream.Responder
	Reply     = fakeupstream.Reply
	Chunk     = fakeupstream.Chunk
)

func JSON(status int, v any) Responder { return fakeupstream.JSON(status, v) }

func Raw(status int, contentType, body string) Responder {
	return fakeupstream.Raw(status, contentType, body)
}

func SSE(events ...string) Responder { return fakeupstream.SSE(events...) }

func Hang() Responder { return fakeupstream.Hang() }

func Drop() Responder { return fakeupstream.Drop() }

func NewUpstream(t testing.TB, sh shape.Shape) *Upstream {
	t.Helper()
	u := fakeupstream.New(sh, clock.Real{})
	t.Cleanup(u.Close)
	return &Upstream{Upstream: u, t: t}
}

func NewOpenAIChat(t testing.TB) *Upstream { return NewUpstream(t, shape.OpenAIChat) }

func NewOpenAIResponses(t testing.TB) *Upstream { return NewUpstream(t, shape.OpenAIResponses) }

func NewAnthropic(t testing.TB) *Upstream { return NewUpstream(t, shape.AnthropicMessages) }

func NewGemini(t testing.TB) *Upstream { return NewUpstream(t, shape.Gemini) }

func (u *Upstream) Client() *http.Client {
	c := u.Upstream.Client()
	u.t.Cleanup(c.CloseIdleConnections)
	return c
}

func (u *Upstream) Last() *Received {
	u.t.Helper()
	r := u.Upstream.Last()
	if r == nil {
		u.t.Fatalf("fake %s upstream received no request", u.Shape)
	}
	return r
}

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
