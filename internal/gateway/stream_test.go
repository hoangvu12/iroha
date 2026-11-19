package gateway_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// liveStream is a streaming Request read as it arrives.
type liveStream struct {
	t     *testing.T
	resp  *http.Response
	lines <-chan string
	seen  []string
}

// openStream sends a streaming Chat Completions Request. The response
// arrives on the returned channel once its headers do.
func openStream(t *testing.T, caller *testkit.Client) <-chan *liveStream {
	t.Helper()
	body := chat("gpt-x")
	body["stream"] = true
	ch := make(chan *liveStream, 1)
	go func() {
		resp := caller.Open(http.MethodPost, chatPath, body)
		ch <- &liveStream{t: t, resp: resp, lines: eventLines(resp.Body)}
	}()
	t.Cleanup(func() {
		select {
		case s := <-ch:
			s.resp.Body.Close()
		default:
		}
	})
	return ch
}

// headers waits for the response headers.
func headers(t *testing.T, ch <-chan *liveStream) *liveStream {
	t.Helper()
	select {
	case s := <-ch:
		t.Cleanup(func() { s.resp.Body.Close() })
		return s
	case <-time.After(10 * time.Second):
		t.Fatal("no response headers")
		return nil
	}
}

// noHeadersYet checks that nothing reached the Caller.
func noHeadersYet(t *testing.T, ch <-chan *liveStream) {
	t.Helper()
	select {
	case s := <-ch:
		t.Fatalf("the Caller got %d before Iroha should have answered", s.resp.StatusCode)
	case <-time.After(50 * time.Millisecond):
	}
}

// next returns the next non-empty line, waiting up to 10 s real time.
func (s *liveStream) next() string {
	s.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case l, ok := <-s.lines:
			if !ok {
				s.t.Fatalf("the stream ended; got %q", s.seen)
			}
			s.seen = append(s.seen, l)
			if l != "" {
				return l
			}
		case <-deadline:
			s.t.Fatalf("no line within 10s; got %q", s.seen)
		}
	}
}

// expect reads the next non-empty line and checks it contains want.
func (s *liveStream) expect(want string) {
	s.t.Helper()
	if l := s.next(); !strings.Contains(l, want) {
		s.t.Fatalf("got line %q, want one containing %q (so far %q)", l, want, s.seen)
	}
}

// rest reads to the end of the stream and returns its events.
func (s *liveStream) rest() []testkit.Event {
	s.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case l, ok := <-s.lines:
			if !ok {
				return testkit.ParseSSE([]byte(strings.Join(s.seen, "\n") + "\n"))
			}
			s.seen = append(s.seen, l)
		case <-deadline:
			s.t.Fatalf("the stream did not end within 10s; got %q", s.seen)
		}
	}
}

// streamError decodes the error event a stream ended with.
func streamError(t *testing.T, events []testkit.Event) callerError {
	t.Helper()
	if len(events) == 0 {
		t.Fatal("no events")
	}
	last := events[len(events)-1]
	var e callerError
	if err := json.Unmarshal([]byte(last.Data), &e); err != nil || e.Error.Code == "" {
		t.Fatalf("the stream did not end with an error event: %+v", events)
	}
	for _, ev := range events {
		if ev.Data == "[DONE]" {
			t.Fatalf("a failed stream claimed completion: %+v", events)
		}
	}
	return e
}

func text(t *testing.T, events []testkit.Event) string {
	t.Helper()
	var b strings.Builder
	for _, e := range events {
		var c struct {
			Choices []struct{ Delta struct{ Content string } }
		}
		if e.Data != "[DONE]" && json.Unmarshal([]byte(e.Data), &c) == nil && len(c.Choices) > 0 {
			b.WriteString(c.Choices[0].Delta.Content)
		}
	}
	return b.String()
}

func TestAStreamWaitingForItsFirstByteIsCommittedAndKeptAlive(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	release := make(chan struct{})
	up.Enqueue(up.Stream("Hel", "lo").HoldUntil(release))
	ch := openStream(t, caller)
	up.Await(1)

	// Silence just short of the commit wait: still nothing sent, so a
	// failure now could still get its own HTTP status.
	srv.Clock.Advance(gateway.StreamCommitAfter - time.Second)
	noHeadersYet(t, ch)

	// Then Iroha commits: 200, stream headers and a keep-alive.
	srv.Clock.Advance(time.Second)
	s := headers(t, ch)
	if s.resp.StatusCode != 200 || !strings.HasPrefix(s.resp.Header.Get("Content-Type"), "text/event-stream") || s.resp.Header.Get("X-Request-Id") == "" {
		t.Fatalf("committed with %d %v", s.resp.StatusCode, s.resp.Header)
	}
	s.expect(": keep-alive")
	srv.Clock.Advance(gateway.KeepAliveEvery)
	s.expect(": keep-alive")

	// The upstream answers at last: its stream follows in the same response.
	close(release)
	events := s.rest()
	if got := text(t, events); got != "Hello" || events[len(events)-1].Data != "[DONE]" {
		t.Fatalf("text %q, events %+v", got, events)
	}
	r := readRequest(t, srv, s.resp.Header.Get("X-Request-Id"))
	if r.Status != 200 || r.Error != nil || r.Usage == nil || r.FirstByteMs == nil || *r.FirstByteMs != 25000 {
		t.Fatalf("request = %+v", r)
	}
}

func TestAStreamWhoseUpstreamStaysSilentEndsWithAnErrorEvent(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(testkit.Hang())
	ch := openStream(t, caller)
	up.Await(1)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s := headers(t, ch)
	s.expect(": keep-alive")
	for elapsed := gateway.StreamCommitAfter; elapsed+gateway.KeepAliveEvery < 60*time.Second; elapsed += gateway.KeepAliveEvery {
		srv.Clock.Advance(gateway.KeepAliveEvery)
		s.expect(": keep-alive")
	}
	srv.Clock.Set(testkit.Epoch.Add(60 * time.Second)) // the first-byte budget runs out

	e := streamError(t, s.rest())
	if e.Error.Code != "upstream_timeout" || e.Error.Hint == "" || e.Error.RequestID == "" || len(e.Error.Details.Attempts) != 1 ||
		e.Error.Details.Attempts[0].Rule != "upstream-timeout" || !strings.Contains(e.Error.Details.Summary, "time budget") {
		t.Fatalf("error event = %+v", e)
	}
	if up.Count() != 1 {
		t.Fatalf("the silent key was retried: upstream got %d", up.Count())
	}
	r := readRequest(t, srv, e.Error.RequestID)
	if r.Status != 200 || r.Error == nil || r.Error.Code != "upstream_timeout" || r.Summary != e.Error.Details.Summary || r.State != "completed" {
		t.Fatalf("request = %+v", r)
	}
}

func TestFailuresAfterCommitmentMoveOnThenArriveAsAnErrorEvent(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))

	// key-1 fails after the commit; key-2 serves the stream.
	hold := make(chan struct{})
	up.Enqueue(up.Error(500, "boom").HoldUntil(hold), up.Stream("Hi"))
	ch := openStream(t, caller)
	up.Await(1)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s := headers(t, ch)
	s.expect(": keep-alive")
	close(hold)
	events := s.rest()
	if got := text(t, events); got != "Hi" || events[len(events)-1].Data != "[DONE]" {
		t.Fatalf("text %q, events %+v", got, events)
	}
	r := readRequest(t, srv, s.resp.Header.Get("X-Request-Id"))
	if r.Status != 200 || r.Error != nil || r.AttemptCount != 2 || r.Attempts[0].Status != 500 {
		t.Fatalf("request = %+v", r)
	}

	// Every Attempt fails after the commit: the error event carries what
	// the HTTP error would have, the Attempts and the summary.
	srv.SkipShortWaits(time.Second) // the pause before the replay
	hold = make(chan struct{})
	up.Enqueue(up.Error(503, "overloaded").HoldUntil(hold))
	up.Default(up.Error(503, "overloaded"))
	n := up.Count()
	ch = openStream(t, caller)
	up.Await(n + 1)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s = headers(t, ch)
	s.expect(": keep-alive")
	close(hold)
	e := streamError(t, s.rest())
	if e.Error.Code != "upstream_failed" || len(e.Error.Details.Attempts) != 3 || !strings.Contains(e.Error.Details.Summary, "all 3 Attempts") ||
		!strings.Contains(e.Error.Message, "overloaded") {
		t.Fatalf("error event = %+v", e)
	}
	r = readRequest(t, srv, e.Error.RequestID)
	if r.Status != 200 || r.Error == nil || r.Error.Code != "upstream_failed" || r.AttemptCount != 3 {
		t.Fatalf("request = %+v", r)
	}
}

func TestStreamFailuresBeforeCommitmentKeepTheirHTTPStatus(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))

	srv.SkipShortWaits(time.Second) // the pause before the replay
	up.Default(up.Error(503, "overloaded"))
	body := chat("gpt-x")
	body["stream"] = true
	var e callerError
	resp := caller.Post(chatPath, body).Expect(502).JSON(&e)
	if resp.Header.Get("Content-Type") != "application/json" || e.Error.Code != "upstream_failed" || len(e.Error.Details.Attempts) != 3 {
		t.Fatalf("error = %s", resp.Body)
	}

	up.Default(up.ErrorCode(429, "rate_limit_exceeded", "Slow down").Header("Retry-After", "30"))
	resp = caller.Post(chatPath, body).Expect(503).JSON(&e)
	if e.Error.Code != "upstream_unavailable" || resp.Header.Get("Retry-After") == "" {
		t.Fatalf("cooling = %s %v", resp.Body, resp.Header)
	}
}

func TestAStreamBrokenMidwayEndsWithAnErrorEvent(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	stream := up.Stream("Hel", "lo")
	up.Enqueue(func(r *testkit.Received) testkit.Reply {
		rep := stream(r)
		rep.Chunks = rep.Chunks[:2] // role and "Hel", then the connection drops
		rep.Disconnect = true
		return rep
	})
	s := headers(t, openStream(t, caller))
	events := s.rest()
	e := streamError(t, events)
	if text(t, events) != "Hel" || e.Error.Code != "upstream_stream_broken" || e.Error.Hint == "" {
		t.Fatalf("events = %+v", events)
	}
	r := readRequest(t, srv, e.Error.RequestID)
	if r.Status != 200 || r.Error == nil || r.Error.Code != "upstream_stream_broken" || r.Attempts[0].Error == "" {
		t.Fatalf("request = %+v", r)
	}
}

func TestAnUnstreamedAnswerAfterCommitmentIsAnErrorEvent(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	hold := make(chan struct{})
	up.Enqueue(testkit.JSON(200, map[string]any{"object": "chat.completion", "choices": []any{}}).HoldUntil(hold))
	ch := openStream(t, caller)
	up.Await(1)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s := headers(t, ch)
	s.expect(": keep-alive")
	close(hold)
	if e := streamError(t, s.rest()); e.Error.Code != "upstream_not_streamed" || e.Error.Hint == "" {
		t.Fatalf("error event = %+v", e)
	}
}

func TestAThreeMinuteStreamWithLongPausesCompletes(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	// "one " arrives at once; each later piece after a minute of silence.
	pieces := []string{"one ", "two ", "three ", "four"}
	gates := make([]chan struct{}, len(pieces))
	stream := up.Stream(pieces...)
	up.Enqueue(func(r *testkit.Received) testkit.Reply {
		rep := stream(r)
		for i := 1; i < len(pieces); i++ {
			gates[i] = make(chan struct{})
			rep.Chunks[1+i].Wait = gates[i] // chunk 0 is the role
		}
		return rep
	})
	s := headers(t, openStream(t, caller))
	s.expect(`"role":"assistant"`)
	s.expect(`"one "`)
	// The keeper's timer is still the commit timer, due StreamCommitAfter
	// after arrival; firing it only re-arms it for KeepAliveEvery after the
	// last write. One Advance past both races the keeper (it may read the
	// clock before or after the Advance ends and re-arm for a time already
	// passed), so fire the commit timer alone and wait for the re-arm. From
	// then on each keep-alive re-arms the timer before it is written, so
	// once the Caller has it the next one is already set.
	start := srv.Clock.Now()
	srv.Clock.Advance(gateway.StreamCommitAfter)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Clock.BlockUntilDue(ctx, start.Add(gateway.KeepAliveEvery)); err != nil {
		t.Fatalf("the keeper did not re-arm its timer: %v", err)
	}
	srv.Clock.Advance(gateway.KeepAliveEvery - gateway.StreamCommitAfter)
	s.expect(": keep-alive")
	keepAlives := 1
	for i := 1; i < len(pieces); i++ {
		n := time.Minute / gateway.KeepAliveEvery
		if i == 1 {
			n-- // the gap's first keep-alive went out above
		}
		for range n {
			srv.Clock.Advance(gateway.KeepAliveEvery)
			s.expect(": keep-alive")
			keepAlives++
		}
		close(gates[i])
		s.expect(`"` + pieces[i] + `"`)
	}
	events := s.rest()
	if got := text(t, events); got != "one two three four" || events[len(events)-1].Data != "[DONE]" || keepAlives != 12 {
		t.Fatalf("text %q, %d keep-alives, events %+v", got, keepAlives, events)
	}
	r := readRequest(t, srv, s.resp.Header.Get("X-Request-Id"))
	if r.Status != 200 || r.Error != nil || r.DurationMs == nil || *r.DurationMs != 180000 || r.Usage == nil {
		t.Fatalf("request = %+v", r)
	}
}
