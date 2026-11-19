package testkit_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// These tests pin down the fakes themselves, so later tickets can trust them.

func post(t *testing.T, url, body string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer sk-test-upstream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func read(t *testing.T, resp *http.Response) string {
	t.Helper()
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

type call struct {
	path, body string
}

func inferenceCall(sh shape.Shape, model string, stream bool) call {
	s := "false"
	if stream {
		s = "true"
	}
	switch sh {
	case shape.OpenAIChat:
		return call{"/chat/completions", `{"model":"` + model + `","stream":` + s + `,"stream_options":{"include_usage":true},"messages":[{"role":"user","content":"hi"}]}`}
	case shape.OpenAIResponses:
		return call{"/responses", `{"model":"` + model + `","stream":` + s + `,"input":"hi"}`}
	case shape.AnthropicMessages:
		return call{"/messages", `{"model":"` + model + `","stream":` + s + `,"max_tokens":10,"messages":[{"role":"user","content":"hi"}]}`}
	default:
		if stream {
			return call{"/models/" + model + ":streamGenerateContent?alt=sse", `{"contents":[{"parts":[{"text":"hi"}]}]}`}
		}
		return call{"/models/" + model + ":generateContent", `{"contents":[{"parts":[{"text":"hi"}]}]}`}
	}
}

func TestEveryShapeAnswersTextStreamedAndNot(t *testing.T) {
	for _, sh := range shape.All {
		t.Run(string(sh), func(t *testing.T) {
			up := testkit.NewUpstream(t, sh)
			up.SetUsage(7, 3)

			c := inferenceCall(sh, "m-1", false)
			body := read(t, post(t, up.URL()+c.path, c.body))
			var m map[string]any
			if err := json.Unmarshal([]byte(body), &m); err != nil {
				t.Fatalf("non-stream body is not JSON: %s", body)
			}
			if !strings.Contains(body, "Hello from the fake") || !strings.Contains(body, `"m-1"`) || !strings.Contains(body, "7") {
				t.Fatalf("non-stream body lacks text, model or usage: %s", body)
			}
			got := up.Last()
			if got.Model != "m-1" || got.Stream || got.Bearer() != "sk-test-upstream" {
				t.Fatalf("recorded %+v", got)
			}

			c = inferenceCall(sh, "m-2", true)
			resp := post(t, up.URL()+c.path, c.body)
			if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
				t.Fatalf("stream content type %q", ct)
			}
			events := testkit.ParseSSE([]byte(read(t, resp)))
			if len(events) < 3 {
				t.Fatalf("stream has %d events", len(events))
			}
			var text strings.Builder
			for _, e := range events {
				if e.Data == "[DONE]" {
					continue
				}
				var v any
				if err := json.Unmarshal([]byte(e.Data), &v); err != nil {
					t.Fatalf("event data is not JSON: %q", e.Data)
				}
				text.WriteString(e.Data)
			}
			for _, word := range []string{"Hello", "from", "fake"} {
				if !strings.Contains(text.String(), word) {
					t.Fatalf("stream lacks %q: %s", word, text.String())
				}
			}
			if !up.Last().Stream || up.Count() != 2 {
				t.Fatalf("second request not recorded as stream")
			}
		})
	}
}

func TestQueuedRespondersAnswerInOrderThenDefault(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	up.Enqueue(
		up.Error(429, "slow down").Header("Retry-After", "30"),
		up.ErrorCode(401, "invalid_api_key", "bad key"),
	)
	up.Default(up.Text("fallback"))
	c := inferenceCall(shape.OpenAIChat, "m", false)

	r1 := post(t, up.URL()+c.path, c.body)
	b1 := read(t, r1)
	if r1.StatusCode != 429 || r1.Header.Get("Retry-After") != "30" || !strings.Contains(b1, `"rate_limit_error"`) {
		t.Fatalf("first: %d %v %s", r1.StatusCode, r1.Header, b1)
	}
	r2 := post(t, up.URL()+c.path, c.body)
	if b2 := read(t, r2); r2.StatusCode != 401 || !strings.Contains(b2, `"invalid_api_key"`) {
		t.Fatalf("second: %d %s", r2.StatusCode, b2)
	}
	r3 := post(t, up.URL()+c.path, c.body)
	if b3 := read(t, r3); r3.StatusCode != 200 || !strings.Contains(b3, "fallback") {
		t.Fatalf("third: %d %s", r3.StatusCode, b3)
	}
}

func TestErrorEnvelopesPerShape(t *testing.T) {
	want := map[shape.Shape]string{
		shape.OpenAIChat:        `{"error":{"code":null,"message":"nope","param":null,"type":"permission_error"}}`,
		shape.OpenAIResponses:   `{"error":{"code":null,"message":"nope","param":null,"type":"permission_error"}}`,
		shape.AnthropicMessages: `{"error":{"message":"nope","type":"permission_error"},"type":"error"}`,
		shape.Gemini:            `{"error":{"code":403,"message":"nope","status":"PERMISSION_DENIED"}}`,
	}
	for sh, body := range want {
		up := testkit.NewUpstream(t, sh)
		up.Enqueue(up.Error(403, "nope"))
		c := inferenceCall(sh, "m", false)
		if got := read(t, post(t, up.URL()+c.path, c.body)); got != body {
			t.Errorf("%s: %s, want %s", sh, got, body)
		}
	}
}

func TestModelListsPerShape(t *testing.T) {
	for _, sh := range shape.All {
		up := testkit.NewUpstream(t, sh)
		up.SetModels("alpha", "beta/gamma")
		resp, err := http.Get(up.URL() + "/models")
		if err != nil {
			t.Fatal(err)
		}
		body := read(t, resp)
		if !strings.Contains(body, "alpha") || !strings.Contains(body, "beta/gamma") {
			t.Errorf("%s models: %s", sh, body)
		}
	}
}

func TestHeldRepliesAndDisconnects(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	release := make(chan struct{})
	up.Enqueue(up.Text("late").HoldUntil(release), testkit.Drop(), up.Stream("a", "b").ThenDisconnect())
	c := inferenceCall(shape.OpenAIChat, "m", false)

	done := make(chan string)
	go func() { done <- read(t, post(t, up.URL()+c.path, c.body)) }()
	up.Await(1)
	select {
	case <-done:
		t.Fatal("held reply arrived before release")
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	if body := <-done; !strings.Contains(body, "late") {
		t.Fatalf("held body %s", body)
	}

	if _, err := http.Post(up.URL()+c.path, "application/json", strings.NewReader(c.body)); err == nil {
		t.Fatal("Drop: expected a transport error")
	}

	resp := post(t, up.URL()+c.path, c.body)
	_, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err == nil {
		t.Fatal("ThenDisconnect: expected the stream to break")
	}
}

func TestHangEndsWhenTheCallerGivesUp(t *testing.T) {
	up := testkit.NewAnthropic(t)
	up.Default(testkit.Hang())
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, up.URL()+"/messages", strings.NewReader(`{"model":"m"}`))
	if _, err := http.DefaultClient.Do(req); err == nil {
		t.Fatal("expected a timeout")
	}
}

func TestGeminiStreamWithoutSSEIsAJSONArray(t *testing.T) {
	up := testkit.NewGemini(t)
	up.Enqueue(up.Stream("one", "two", "three"))
	body := read(t, post(t, up.URL()+"/models/g:streamGenerateContent", `{}`))
	var chunks []map[string]any
	if err := json.Unmarshal([]byte(body), &chunks); err != nil || len(chunks) != 3 {
		t.Fatalf("array stream: %v %s", err, body)
	}
}
