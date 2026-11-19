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

// heldBody is r with its status and headers sent at once and its body held
// until release is closed (a Provider that answers its headers early and
// then generates for minutes, as OpenRouter does on non-stream calls).
func heldBody(r testkit.Responder, release <-chan struct{}) testkit.Responder {
	return func(rec *testkit.Received) testkit.Reply {
		rep := r(rec)
		rep.Chunks = append([]testkit.Chunk{{Data: rep.Body, Wait: release}}, rep.Chunks...)
		rep.Body = nil
		return rep
	}
}

// liveBody is a non-stream answer read byte by byte as it arrives.
type liveBody struct {
	t     *testing.T
	resp  *http.Response
	bytes <-chan byte
	seen  []byte
}

// openAnswer sends a non-stream Chat Completions Request; the response
// arrives on the returned channel once its headers do.
func openAnswer(t *testing.T, caller *testkit.Client) <-chan *liveBody {
	t.Helper()
	ch := make(chan *liveBody, 1)
	go func() {
		resp := caller.Open(http.MethodPost, chatPath, chat("gpt-x"))
		bs := make(chan byte, 1<<16)
		go func() {
			defer close(bs)
			buf := make([]byte, 1)
			for {
				if _, err := resp.Body.Read(buf); err != nil {
					return
				}
				bs <- buf[0]
			}
		}()
		ch <- &liveBody{t: t, resp: resp, bytes: bs}
	}()
	t.Cleanup(func() {
		select {
		case b := <-ch:
			b.resp.Body.Close()
		default:
		}
	})
	return ch
}

func answerHeaders(t *testing.T, ch <-chan *liveBody) *liveBody {
	t.Helper()
	select {
	case b := <-ch:
		t.Cleanup(func() { b.resp.Body.Close() })
		return b
	case <-time.After(10 * time.Second):
		t.Fatal("no response headers")
		return nil
	}
}

func noAnswerYet(t *testing.T, ch <-chan *liveBody) {
	t.Helper()
	select {
	case b := <-ch:
		t.Fatalf("the Caller got %d before Iroha should have answered", b.resp.StatusCode)
	case <-time.After(50 * time.Millisecond):
	}
}

// expectByte reads the next byte, waiting up to 10 s real time.
func (b *liveBody) expectByte(want byte) {
	b.t.Helper()
	select {
	case c, ok := <-b.bytes:
		if !ok {
			b.t.Fatalf("the body ended; got %q", b.seen)
		}
		b.seen = append(b.seen, c)
		if c != want {
			b.t.Fatalf("got byte %q, want %q (so far %q)", c, want, b.seen)
		}
	case <-time.After(10 * time.Second):
		b.t.Fatalf("no byte within 10s; got %q", b.seen)
	}
}

// rest reads to the end of the body.
func (b *liveBody) rest() []byte {
	b.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case c, ok := <-b.bytes:
			if !ok {
				return b.seen
			}
			b.seen = append(b.seen, c)
		case <-deadline:
			b.t.Fatalf("the body did not end within 10s; got %q", b.seen)
		}
	}
}

// TIME-01 (story 19): a non-stream Request whose upstream sends its headers
// and then takes longer than Cloudflare's 100 s to write the body still
// reaches the Caller: Iroha commits 200 + JSON once the answer is late and
// keeps the connection busy with JSON whitespace until the body arrives,
// which follows byte for byte.
func TestALateNonStreamAnswerIsCommittedAndPaddedWithWhitespace(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	release := make(chan struct{})
	up.Enqueue(heldBody(up.Text("slow thoughts"), release))
	ch := openAnswer(t, caller)
	up.Await(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	commitAt := testkit.Epoch.Add(gateway.AnswerCommitAfter)
	if err := srv.Clock.BlockUntilDue(ctx, commitAt); err != nil {
		t.Fatal("Iroha set no timer to commit the late answer")
	}

	srv.Clock.Advance(gateway.AnswerCommitAfter - time.Second)
	noAnswerYet(t, ch)
	srv.Clock.Advance(time.Second)
	b := answerHeaders(t, ch)
	if b.resp.StatusCode != 200 || b.resp.Header.Get("Content-Type") != "application/json" || b.resp.Header.Get("X-Request-Id") == "" {
		t.Fatalf("committed with %d %v", b.resp.StatusCode, b.resp.Header)
	}
	// Past Cloudflare's 100 s, one newline per KeepAliveEvery of silence.
	pads := 0
	for elapsed := gateway.AnswerCommitAfter; elapsed < 120*time.Second; elapsed += gateway.KeepAliveEvery {
		if err := srv.Clock.BlockUntilDue(ctx, testkit.Epoch.Add(elapsed+gateway.KeepAliveEvery)); err != nil {
			t.Fatal("no keep-alive timer")
		}
		srv.Clock.Advance(gateway.KeepAliveEvery)
		b.expectByte('\n')
		pads++
	}

	close(release)
	got := b.rest()
	body := strings.TrimLeft(string(got), "\n")
	if len(got)-len(body) != pads {
		t.Fatalf("%d newlines before the body, want %d: %q", len(got)-len(body), pads, got)
	}
	var out struct {
		Model   string
		Choices []struct{ Message struct{ Content string } }
	}
	if err := json.Unmarshal(got, &out); err != nil || out.Model != "gpt-x" || out.Choices[0].Message.Content != "slow thoughts" {
		t.Fatalf("answer %q: %v", got, err)
	}
	r := readRequest(t, srv, b.resp.Header.Get("X-Request-Id"))
	if r.Status != 200 || r.Error != nil || r.Usage == nil {
		t.Fatalf("request = %+v", r)
	}
}

// After the commit, a late answer that turns out to be an error moves on to
// the next key as before; when nothing serves, the failure is the JSON
// error body in the Caller's Shape, under the 200 already sent.
func TestFailuresAfterANonStreamCommitMoveOnThenArriveAsAJSONErrorBody(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))

	release := make(chan struct{})
	up.Enqueue(heldBody(testkit.Raw(200, "application/json", `{"error":{"code":"server_error","message":"Provider disconnected"}}`), release), up.Text("from b"))
	ch := openAnswer(t, caller)
	up.Await(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Clock.BlockUntilDue(ctx, testkit.Epoch.Add(gateway.AnswerCommitAfter)); err != nil {
		t.Fatal("no commit timer")
	}
	srv.Clock.Advance(gateway.AnswerCommitAfter)
	b := answerHeaders(t, ch)
	close(release)
	got := b.rest()
	var out struct {
		Choices []struct{ Message struct{ Content string } }
	}
	if err := json.Unmarshal(got, &out); err != nil || len(out.Choices) == 0 || out.Choices[0].Message.Content != "from b" {
		t.Fatalf("answer %q: %v", got, err)
	}

	// The only key's body breaks off after the commit.
	srv.Admin.Post("/api/providers/acme/keys/key-2/disable", nil).Expect(200)
	release = make(chan struct{})
	up.Enqueue(heldBody(testkit.Raw(200, "application/json", `{"id":"x","choi`), release).ThenDisconnect())
	n := up.Count()
	ch = openAnswer(t, caller)
	up.Await(n + 1)
	if err := srv.Clock.BlockUntilDue(ctx, srv.Clock.Now().Add(gateway.AnswerCommitAfter)); err != nil {
		t.Fatal("no commit timer")
	}
	srv.Clock.Advance(gateway.AnswerCommitAfter)
	b = answerHeaders(t, ch)
	close(release)
	got = b.rest()
	var e callerError
	if err := json.Unmarshal(got, &e); err != nil || e.Error.Code != "upstream_broken" || e.Error.Hint == "" || e.Error.RequestID == "" {
		t.Fatalf("error body %q: %v", got, err)
	}
	r := readRequest(t, srv, e.Error.RequestID)
	if r.Status != 200 || r.Error == nil || r.Error.Code != "upstream_broken" {
		t.Fatalf("request = %+v", r)
	}
}

// An answer whose body follows its headers within AnswerGrace is never
// committed early: it keeps the Provider's status line and bytes.
func TestANonStreamAnswerArrivingInTimeIsNotPadded(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	resp := caller.Post(chatPath, chat("gpt-x")).Expect(200)
	if strings.HasPrefix(resp.Text(), "\n") || !strings.HasPrefix(resp.Text(), "{") {
		t.Fatalf("answer = %q", resp.Text())
	}
}
