package gateway_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/testkit"
)

// holdChunk is r with its chunk i (and those after it) held until release.
func holdChunk(r testkit.Responder, i int, release <-chan struct{}) testkit.Responder {
	return func(rec *testkit.Received) testkit.Reply {
		rep := r(rec)
		rep.Chunks[i].Wait = release
		return rep
	}
}

// openLive sends a streaming body to path and returns the live stream once
// its headers arrive.
func openLive(t *testing.T, caller *testkit.Client, path string, body map[string]any) *liveStream {
	t.Helper()
	body["stream"] = true
	ch := make(chan *liveStream, 1)
	go func() {
		resp := caller.Open(http.MethodPost, path, body)
		ch <- &liveStream{t: t, resp: resp, lines: eventLines(resp.Body)}
	}()
	return headers(t, ch)
}

// Story 75: a stream's time to first token is when the first
// event carrying generated content arrived, not the Provider's comments,
// pings, role-only chunk or message_start before it; on passthrough and
// translated streams alike.
func TestTimeToFirstTokenIsTheFirstContentEvent(t *testing.T) {
	srv := testkit.Start(t)
	chatUp := testkit.NewOpenAIChat(t)
	claudeUp := testkit.NewAnthropic(t)
	addProvider(t, srv, "acme", chatUp.URL(), "sk-test-a")
	srv.Admin.Post("/api/providers", map[string]any{"handle": "claude"}).Expect(201)
	srv.Admin.Post("/api/providers/claude/endpoints", map[string]any{"url": claudeUp.URL(), "shape": "anthropic-messages"}).Expect(201)
	srv.Admin.Post("/api/providers/claude/keys", map[string]any{"secret": "sk-test-c"}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))

	role := `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}` + "\n\n"
	release := make(chan struct{})
	chatUp.Enqueue(holdChunk(testkit.SSE(": OPENROUTER PROCESSING\n\n", role, chunk("Hi"), "data: [DONE]\n\n"), 2, release))
	s := openLive(t, caller, chatPath, chat("gpt-x"))
	s.expect(": OPENROUTER PROCESSING")
	s.expect(`"role":"assistant"`)
	srv.Clock.Advance(3 * time.Second)
	close(release)
	s.rest()
	r := readRequest(t, srv, s.resp.Header.Get("X-Request-Id"))
	if r.FirstByteMs == nil || *r.FirstByteMs != 3000 || r.Attempts[0].FirstByteMs == nil || *r.Attempts[0].FirstByteMs != 3000 {
		t.Fatalf("passthrough: first token %v, attempt %v", msOf(r.FirstByteMs), msOf(r.Attempts[0].FirstByteMs))
	}

	// Anthropic to a Chat Caller: message_start and content_block_start
	// carry no token.
	release = make(chan struct{})
	claudeUp.Enqueue(holdChunk(claudeUp.Stream("Hi"), 2, release))
	s = openLive(t, caller, "/providers/claude/v1/chat/completions", chat("sonnet"))
	s.expect(`"role":"assistant"`)
	srv.Clock.Advance(2 * time.Second)
	close(release)
	s.rest()
	r = readRequest(t, srv, s.resp.Header.Get("X-Request-Id"))
	if r.ShapeOut != "anthropic-messages" || r.FirstByteMs == nil || *r.FirstByteMs != 2000 {
		t.Fatalf("translated: shape %s, first token %v", r.ShapeOut, msOf(r.FirstByteMs))
	}
}

// msOf renders an optional millisecond count.
func msOf(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}
