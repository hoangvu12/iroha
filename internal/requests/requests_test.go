package requests_test

import (
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testkit"
)

const chatPath = "/providers/acme/v1/chat/completions"

func addProvider(t *testing.T, srv *testkit.Server, url string) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": url, "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-one"}).Expect(201)
}

func issue(t *testing.T, srv *testkit.Server, body map[string]any) *testkit.Client {
	t.Helper()
	body["scope"] = map[string]any{"all": true}
	var out gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", body).Expect(201).JSON(&out)
	return srv.Client(out.GatewayKey.Secret)
}

func capture(t *testing.T, srv *testkit.Server, id string) requests.CaptureView {
	t.Helper()
	var v requests.CaptureView
	srv.Admin.Get("/api/requests/" + id + "/capture").Expect(200).JSON(&v)
	return v
}

func request(t *testing.T, srv *testkit.Server, id string) requests.Request {
	t.Helper()
	var r requests.Request
	srv.Admin.Get("/api/requests/" + id).Expect(200).JSON(&r)
	return r
}

func sameJSON(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	xa, _ := json.Marshal(x)
	ya, _ := json.Marshal(y)
	return string(xa) == string(ya)
}

func TestCaptureStoresPromptAndResponseOnlyForKeysWithCaptureOn(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, up.URL())
	debug := issue(t, srv, map[string]any{"name": "debug", "capture": true})
	friend := issue(t, srv, map[string]any{"name": "friend"})

	prompt := `{"model":"gpt-x", "messages":[{"role":"user","content":"what is 2+2?"}]}`
	up.Enqueue(testkit.JSON(200, map[string]any{"id": "c1", "object": "chat.completion", "model": "gpt-x-0101",
		"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "4"}, "finish_reason": "stop"}}}))
	resp := debug.Post(chatPath, prompt).Expect(200)
	id := resp.Header.Get("X-Request-Id")

	if r := request(t, srv, id); !r.Captured {
		t.Fatalf("request = %+v", r)
	}
	c := capture(t, srv, id)
	if c.RequestID != id || !sameJSON(c.Request.Body, []byte(prompt)) || c.Request.Truncated || !c.CapturedAt.Equal(testkit.Epoch) {
		t.Fatalf("captured request = %+v (body %s)", c.Request, c.Request.Body)
	}
	// The response is what the Caller received: model echoed as asked.
	if c.Response.Status != 200 || !sameJSON(c.Response.Body, resp.Body) || c.Response.Stream != "" || !strings.Contains(string(c.Response.Body), `"model":"gpt-x"`) {
		t.Fatalf("captured response = %+v (body %s, caller got %s)", c.Response, c.Response.Body, resp.Body)
	}

	// Failures are captured too, as the Caller saw them.
	up.Enqueue(up.Error(400, "bad messages"))
	failed := debug.Post(chatPath, prompt).Expect(400)
	if c := capture(t, srv, failed.Header.Get("X-Request-Id")); c.Response.Status != 400 || !sameJSON(c.Response.Body, failed.Body) {
		t.Fatalf("captured failure = %+v", c.Response)
	}
	refused := debug.Post(chatPath, `{"messages":[]}`).Expect(400)
	if c := capture(t, srv, refused.Header.Get("X-Request-Id")); c.Response.Status != 400 || !strings.Contains(string(c.Response.Body), "model_required") {
		t.Fatalf("captured refusal = %+v", c.Response)
	}

	// Capture off stores nothing.
	other := friend.Post(chatPath, prompt).Expect(200).Header.Get("X-Request-Id")
	if r := request(t, srv, other); r.Captured {
		t.Fatalf("a key with capture off was captured: %+v", r)
	}
	e := srv.Admin.Get("/api/requests/" + other + "/capture").Expect(404).Err()
	if e.Code != "capture_not_found" || !strings.Contains(e.Hint, `"capture": true`) {
		t.Fatalf("no capture = %+v", e)
	}
	srv.Admin.Get("/api/requests/req_nope/capture").Expect(404)
	var list requests.RequestPage
	srv.Admin.Get("/api/requests").Expect(200).JSON(&list)
	if len(list.Requests) != 4 || list.Requests[0].Captured || !list.Requests[1].Captured {
		t.Fatalf("list = %+v", list.Requests)
	}

	// Turning capture on is an audited, revertible change.
	var res gatewaykeys.GatewayKeyResult
	srv.Admin.Patch("/api/gateway-keys/friend", map[string]any{"capture": true}).Expect(200).JSON(&res)
	if !res.GatewayKey.Capture || len(res.Changes) != 1 || !slices.Equal(res.Changes[0].Fields, []string{"capture"}) {
		t.Fatalf("patch = %+v", res)
	}
	later := friend.Post(chatPath, prompt).Expect(200).Header.Get("X-Request-Id")
	capture(t, srv, later)
	srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(200)
	var k gatewaykeys.GatewayKey
	srv.Admin.Get("/api/gateway-keys/friend").Expect(200).JSON(&k)
	if k.Capture {
		t.Fatal("revert left capture on")
	}
	again := friend.Post(chatPath, prompt).Expect(200).Header.Get("X-Request-Id")
	srv.Admin.Get("/api/requests/" + again + "/capture").Expect(404)
	// Create-or-update by name keeps capture unless sent.
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "debug"}).Expect(200).JSON(&res)
	if !res.GatewayKey.Capture || res.Outcome != "unchanged" {
		t.Fatalf("repeat create = %+v", res)
	}
}

func TestCapturedStreamsAreKeptAsSentAndReassembled(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, up.URL())
	debug := issue(t, srv, map[string]any{"name": "debug", "capture": true})

	up.Enqueue(up.Stream("Hel", "lo"))
	resp := debug.Post(chatPath, `{"model":"gpt-x","stream":true,"messages":[{"role":"user","content":"hi"}]}`).Expect(200)
	c := capture(t, srv, resp.Header.Get("X-Request-Id"))
	if c.Response.Stream != string(resp.Body) || !strings.HasPrefix(c.Response.ContentType, "text/event-stream") {
		t.Fatalf("stream as sent = %q, caller got %q", c.Response.Stream, resp.Body)
	}
	var whole struct {
		Object  string
		Model   string
		Choices []struct {
			Index   int
			Message struct {
				Role, Content string
			}
			FinishReason string `json:"finish_reason"`
		}
		Usage any
	}
	if err := json.Unmarshal(c.Response.Body, &whole); err != nil {
		t.Fatalf("reassembled body %s: %v", c.Response.Body, err)
	}
	if whole.Object != "chat.completion" || whole.Model != "gpt-x" || len(whole.Choices) != 1 || whole.Choices[0].Message.Content != "Hello" ||
		whole.Choices[0].Message.Role != "assistant" || whole.Choices[0].FinishReason != "stop" || whole.Usage != nil {
		t.Fatalf("reassembled = %s", c.Response.Body)
	}

	// Tool calls arrive in pieces and are put back together by index.
	chunk := func(delta string, finish string) string {
		f := "null"
		if finish != "" {
			f = `"` + finish + `"`
		}
		return `data: {"id":"c2","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":` + delta + `,"finish_reason":` + f + "}]}\n\n"
	}
	up.Enqueue(testkit.SSE(
		chunk(`{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]}`, ""),
		chunk(`{"tool_calls":[{"index":0,"function":{"arguments":"{\"q\":"}}]}`, ""),
		chunk(`{"tool_calls":[{"index":0,"function":{"arguments":"\"tea\"}"}},{"index":1,"id":"call_2","type":"function","function":{"name":"time","arguments":"{}"}}]}`, ""),
		chunk(`{}`, "tool_calls"),
		"data: [DONE]\n\n",
	))
	resp = debug.Post(chatPath, `{"model":"gpt-x","stream":true,"messages":[{"role":"user","content":"tea?"}]}`).Expect(200)
	c = capture(t, srv, resp.Header.Get("X-Request-Id"))
	var tools struct {
		Choices []struct {
			Message struct {
				ToolCalls []struct {
					ID       string
					Type     string
					Function struct{ Name, Arguments string }
				} `json:"tool_calls"`
			}
			FinishReason string `json:"finish_reason"`
		}
	}
	if err := json.Unmarshal(c.Response.Body, &tools); err != nil || len(tools.Choices) != 1 {
		t.Fatalf("reassembled tool calls %s: %v", c.Response.Body, err)
	}
	calls := tools.Choices[0].Message.ToolCalls
	if len(calls) != 2 || calls[0].ID != "call_1" || calls[0].Type != "function" || calls[0].Function.Name != "lookup" ||
		calls[0].Function.Arguments != `{"q":"tea"}` || calls[1].Function.Name != "time" || tools.Choices[0].FinishReason != "tool_calls" {
		t.Fatalf("tool calls = %+v from %s", calls, c.Response.Body)
	}
}

func TestRequestsLeftInProgressByAStoppedRunAreMarkedInterrupted(t *testing.T) {
	first := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, first, up.URL())
	caller := issue(t, first, map[string]any{"name": "pi"})

	hold := make(chan struct{})
	up.Enqueue(up.Text("late").HoldUntil(hold))
	done := make(chan struct{})
	go func() {
		defer close(done)
		resp := caller.Open(http.MethodPost, chatPath, `{"model":"gpt-x","messages":[]}`)
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
	}()
	defer func() { close(hold); <-done }()
	up.Await(1)

	var page requests.RequestPage
	first.Admin.Get("/api/requests").Expect(200).JSON(&page)
	if len(page.Requests) != 1 || page.Requests[0].State != requests.StateInProgress {
		t.Fatalf("requests = %+v", page.Requests)
	}
	id := page.Requests[0].ID

	// The process that held the Request is gone as far as a new start can
	// tell (a crash leaves exactly this): a new run of Iroha opens the same
	// data and closes the Request as interrupted.
	second := testkit.Start(t, testkit.Options{DataDir: first.DataDir, Clock: first.Clock})
	second.Admin.Token = first.AdminToken
	var r requests.Request
	second.Admin.Get("/api/requests/" + id).Expect(200).JSON(&r)
	if r.State != requests.StateInterrupted || r.Error == nil || r.Error.Code != "interrupted" || r.FinishedAt != nil || r.Caller.Name != "pi" {
		t.Fatalf("request after restart = %+v", r)
	}
	ev := second.Logs("kind=request.interrupted&request_id=" + id)
	if len(ev) != 1 || ev[0].Level != "warn" {
		t.Fatalf("events = %+v", ev)
	}
	if n := len(second.Logs("kind=request.interrupted")); n != 1 {
		t.Fatalf("%d interrupted events", n)
	}
}
