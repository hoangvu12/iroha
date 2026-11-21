package gateway_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestCallerNetworkAndTraceHeadersNeverReachTheUpstreamButVendorHeadersDo(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	blocked := map[string]string{
		"Origin": "https://evil.example", "Referer": "https://evil.example/page", "Via": "1.1 proxy",
		"Forwarded": "for=203.0.113.9", "X-Real-Ip": "203.0.113.9", "True-Client-Ip": "203.0.113.9",
		"X-Request-Id": "caller-req", "X-Correlation-Id": "caller-corr",
		"Traceparent": "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01", "Tracestate": "vendor=1",
		"Proxy-Authorization": "Basic c2VjcmV0", "Cf-Connecting-Ip": "203.0.113.9", "Cf-Ray": "abc",
		"X-Forwarded-For": "203.0.113.9", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https",
		"Iroha-Debug": "1", "Cookie": "session=abc",
	}
	allowed := map[string]string{
		"Openai-Organization": "org-1", "Openai-Project": "proj-1", "X-Stainless-Lang": "js", "User-Agent": "pi/1.0",
	}
	c := caller.WithHeader("Accept-Encoding", "br")
	for k, v := range blocked {
		c = c.WithHeader(k, v)
	}
	for k, v := range allowed {
		c = c.WithHeader(k, v)
	}
	c.Post(chatPath, chat("gpt-x")).Expect(200)
	got := up.Last()
	for k := range blocked {
		if v := got.Header.Get(k); v != "" {
			t.Errorf("%s reached the upstream: %q", k, v)
		}
	}
	if strings.Contains(got.Header.Get("Accept-Encoding"), "br") {
		t.Errorf("the Caller's Accept-Encoding reached the upstream: %q", got.Header.Get("Accept-Encoding"))
	}
	for k, v := range allowed {
		if got.Header.Get(k) != v {
			t.Errorf("%s = %q upstream, want %q", k, got.Header.Get(k), v)
		}
	}
}

func TestContentTypeAndAcceptAreDefaultedUpstreamAndTheCallersAreKept(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	// Go's HTTP client sends no Accept header.
	caller.Post(chatPath, `{"model":"gpt-x","messages":[]}`).Expect(200)
	if h := up.Last().Header; h.Get("Content-Type") != "application/json" || h.Get("Accept") != "application/json" {
		t.Fatalf("buffered: Content-Type %q, Accept %q", h.Get("Content-Type"), h.Get("Accept"))
	}
	caller.Post(chatPath, `{"model":"gpt-x","stream":true,"messages":[]}`).Expect(200)
	if h := up.Last().Header; h.Get("Content-Type") != "application/json" || h.Get("Accept") != "text/event-stream" {
		t.Fatalf("stream: Content-Type %q, Accept %q", h.Get("Content-Type"), h.Get("Accept"))
	}
	caller.WithHeader("Accept", "application/json; q=0.9").WithHeader("Content-Type", "application/json; charset=utf-8").
		Post(chatPath, `{"model":"gpt-x","messages":[]}`).Expect(200)
	if h := up.Last().Header; h.Get("Content-Type") != "application/json; charset=utf-8" || h.Get("Accept") != "application/json; q=0.9" {
		t.Fatalf("the Caller's headers were replaced: Content-Type %q, Accept %q", h.Get("Content-Type"), h.Get("Accept"))
	}
}

func TestUpstreamRedirectsAreNeverFollowedAndRefusalsKeepTheirStatus(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	elsewhere := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	srv.NoConversationIDs("acme")
	caller := srv.Client(issue(t, srv, "pi", all))
	moved := func(status int) testkit.Responder {
		return testkit.Raw(status, "application/json", `{}`).Header("Location", elsewhere.URL()+"/chat/completions")
	}

	for _, status := range []int{302, 307} {
		before := up.Count()
		up.Enqueue(moved(status))
		var e callerError
		resp := caller.Post(chatPath, chat("gpt-x")).Expect(502).JSON(&e)
		if e.Error.Code != "upstream_redirect" || e.Error.Hint == "" || e.Error.RequestID != resp.Header.Get("X-Request-Id") {
			t.Fatalf("%d: %s", status, resp.Body)
		}
		if elsewhere.Count() != 0 || up.Count() != before+1 {
			t.Fatalf("%d: redirect target got %d, upstream got %d (want %d)", status, elsewhere.Count(), up.Count(), before+1)
		}
		r := readRequest(t, srv, e.Error.RequestID)
		if r.Status != 502 || r.Error == nil || r.Error.Code != "upstream_redirect" || len(r.Attempts) != 1 || r.Attempts[0].Status != status {
			t.Fatalf("%d: request = %+v", status, r)
		}
	}
	for _, k := range []string{"key-1", "key-2"} {
		if st := readKey(t, srv, k).State.State; st != "active" {
			t.Fatalf("%s is %s after a redirect", k, st)
		}
	}

	up.Enqueue(moved(302))
	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=gpt-x", nil).Expect(200).JSON(&res)
	if res.Passed || res.Status != 302 || res.State.State != "active" || elsewhere.Count() != 0 {
		t.Fatalf("key test = %+v; redirect target got %d", res, elsewhere.Count())
	}

	before := up.Count()
	up.Enqueue(up.Error(422, "messages: field required"))
	var e callerError
	resp := caller.Post(chatPath, chat("gpt-x")).Expect(422).JSON(&e)
	if e.Error.Code != "upstream_rejected" || !strings.Contains(e.Error.Message, "field required") || up.Count() != before+1 {
		t.Fatalf("422: %s (upstream got %d more)", resp.Body, up.Count()-before)
	}
	if st := readKey(t, srv, "key-1").State.State; st != "active" {
		t.Fatalf("key-1 is %s after a 422", st)
	}
}

func TestACallersRequestIdIsReplacedAndNeverForwarded(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all)).WithHeader("X-Request-Id", "mine")

	resp := caller.Post(chatPath, chat("gpt-x")).Expect(200)
	id := resp.Header.Get("X-Request-Id")
	if !strings.HasPrefix(id, "req_") || id == "mine" {
		t.Fatalf("x-request-id = %q", id)
	}
	if v := up.Last().Header.Get("X-Request-Id"); v != "" {
		t.Fatalf("the Caller's X-Request-Id reached the upstream: %q", v)
	}
	readRequest(t, srv, id)
}

func TestUnservedInferenceOperationsAnswer404WithoutAnUpstreamCall(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	for _, path := range []string{
		"/v1/embeddings", "/providers/acme/v1/embeddings", "/v1/images/generations",
		"/providers/acme/v1/audio/speech", "/v1/moderations", "/providers/acme/v1/completions",
	} {
		resp := caller.Post(path, map[string]any{"model": "acme/gpt-x", "input": "hi"})
		if resp.Status != 404 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
			t.Errorf("%s: %d %q %s", path, resp.Status, resp.Header.Get("Content-Type"), resp.Body)
			continue
		}
		if e := resp.Err(); e.Code == "" || e.Hint == "" {
			t.Errorf("%s: %s", path, resp.Body)
		}
	}
	if up.Count() != 0 {
		t.Fatalf("an unserved operation reached the upstream %d times", up.Count())
	}
}

func TestOnlyAStreamOfLiteralTrueStreams(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	for _, v := range []string{`"true"`, `1`, `"yes"`, `null`, `{}`} {
		body := `{"model":"gpt-x","stream":` + v + `,"messages":[]}`
		resp := caller.Post(chatPath, body).Expect(200)
		if got := string(up.Last().Body); got != body {
			t.Errorf("stream %s: upstream got %s", v, got)
		}
		if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
			t.Errorf("stream %s: Content-Type %q", v, ct)
		}
		if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Stream {
			t.Errorf("stream %s was recorded as a stream", v)
		}
	}
}

func TestTheBearerSchemeIsCaseInsensitiveAndTheTokenTrimmed(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	key := issue(t, srv, "pi", all)

	for _, h := range []string{"bearer " + key, "BEARER " + key, "Bearer   " + key + "  ", "bEaReR \t" + key} {
		srv.Anon.WithHeader("Authorization", h).Post(chatPath, chat("gpt-x")).Expect(200)
	}
	srv.Anon.WithHeader("Authorization", "Basic "+key).Post(chatPath, chat("gpt-x")).Expect(401)
	if up.Count() != 4 {
		t.Fatalf("upstream got %d", up.Count())
	}
}

func TestAnAllKeyReachesProvidersCreatedAfterIt(t *testing.T) {
	srv := testkit.Start(t)
	caller := srv.Client(issue(t, srv, "early", all))

	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "late", up.URL(), "sk-test-one")
	srv.Admin.Post("/api/providers/late/models", map[string]any{"model": "m1"}).Expect(201)

	caller.Post("/providers/late/v1/chat/completions", chat("m1")).Expect(200)
	caller.Post("/v1/chat/completions", chat("late/m1")).Expect(200)
	var list struct{ Data []struct{ ID string } }
	caller.Get("/v1/models").Expect(200).JSON(&list)
	found := false
	for _, m := range list.Data {
		found = found || m.ID == "late/m1"
	}
	if !found || up.Count() != 2 {
		t.Fatalf("models = %+v; upstream got %d", list.Data, up.Count())
	}
}

type confHanging struct {
	srv     *httptest.Server
	arrived chan struct{}
	gone    chan struct{}
}

func confNewHanging(t *testing.T, firstChunk string) *confHanging {
	t.Helper()
	u := &confHanging{arrived: make(chan struct{}), gone: make(chan struct{})}
	var arrivedOnce, goneOnce sync.Once
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		_, _ = io.Copy(io.Discard, r.Body)
		if firstChunk != "" {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, firstChunk)
			w.(http.Flusher).Flush()
		}
		arrivedOnce.Do(func() { close(u.arrived) })
		<-r.Context().Done()
		goneOnce.Do(func() { close(u.gone) })
	}))
	t.Cleanup(func() {
		u.srv.CloseClientConnections()
		u.srv.Close()
	})
	return u
}

func confWait(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(10 * time.Second):
		t.Fatalf("waited 10s for %s", what)
	}
}

func confOnlyRequest(t *testing.T, srv *testkit.Server) requests.Request {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		var page requests.RequestPage
		srv.Admin.Get("/api/requests").Expect(200).JSON(&page)
		if len(page.Requests) == 1 && page.Requests[0].State == "completed" {
			return readRequest(t, srv, page.Requests[0].ID)
		}
		if time.Now().After(deadline) {
			t.Fatalf("no completed Request within 10s: %+v", page.Requests)
		}
		<-time.After(5 * time.Millisecond)
	}
}

func TestACallerThatGoesAwayEndsTheUpstreamCallAndIsRecordedCallerGone(t *testing.T) {
	const chunk = "data: {\"id\":\"c1\",\"object\":\"chat.completion.chunk\",\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Hel\"}}]}\n\n"
	cases := []struct {
		name, shape, firstChunk string
		stream                  bool
		status                  int
	}{
		{"buffered", "openai-chat", "", false, 499},
		{"translated", "anthropic-messages", "", false, 499},
		{"stream before its first byte", "openai-chat", "", true, 499},
		{"mid-stream", "openai-chat", chunk, true, 200},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := testkit.Start(t)
			up := confNewHanging(t, tc.firstChunk)
			srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
			srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": up.srv.URL + "/v1", "shape": tc.shape}).Expect(201)
			srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-one"}).Expect(201)
			key := issue(t, srv, "pi", all)

			body := `{"model":"gpt-x","messages":[{"role":"user","content":"hi"}]}`
			if tc.stream {
				body = `{"model":"gpt-x","stream":true,"messages":[{"role":"user","content":"hi"}]}`
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+chatPath, strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+key)
			got := make(chan *http.Response, 1)
			go func() {
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					resp = nil
				}
				got <- resp
			}()
			confWait(t, up.arrived, "the upstream request")
			if tc.firstChunk != "" {
				var resp *http.Response
				select {
				case resp = <-got:
				case <-time.After(10 * time.Second):
					t.Fatal("no response headers")
				}
				if resp == nil {
					t.Fatal("the stream failed before the first chunk")
				}
				defer resp.Body.Close()
				if l := (&liveStream{t: t, resp: resp, lines: eventLines(resp.Body)}).next(); !strings.Contains(l, `"Hel"`) {
					t.Fatalf("first line = %q", l)
				}
			}
			cancel()
			confWait(t, up.gone, "the upstream call to end")

			r := confOnlyRequest(t, srv)
			if r.Status != tc.status || r.Error == nil || r.Error.Code != "caller_gone" || len(r.Attempts) != 1 || r.Attempts[0].Rule != "" {
				t.Fatalf("request = %+v (attempts %+v)", r, r.Attempts)
			}
			if k := readKey(t, srv, "key-1"); k.State.State != "active" {
				t.Fatalf("key = %+v", k.State)
			}
		})
	}
}

func TestAJSONAnswerToAStreamRequestBeforeCommitmentIsPassedOn(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(testkit.JSON(200, map[string]any{
		"id": "chatcmpl-1", "object": "chat.completion", "model": "gpt-x-0613",
		"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "hello"}, "finish_reason": "stop"}},
		"usage":   map[string]any{"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5},
	}))
	body := chat("gpt-x")
	body["stream"] = true
	resp := caller.Post(chatPath, body).Expect(200)
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type %q: %s", ct, resp.Body)
	}
	m := resp.Map()
	if m["model"] != "gpt-x" || m["object"] != "chat.completion" {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Status != 200 || r.Error != nil || !r.Stream || r.Usage == nil || r.Usage.Input != 3 || r.Usage.Output != 2 || r.AttemptCount != 1 {
		t.Fatalf("request = %+v", r)
	}
}

func TestAStreamThatBreaksAfterRelayingIsNeverRetriedOnAnotherKey(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	roundRobin(t, srv, "acme")
	caller := srv.Client(issue(t, srv, "pi", all))

	stream := up.Stream("Hel", "lo")
	up.Enqueue(func(r *testkit.Received) testkit.Reply {
		rep := stream(r)
		rep.Chunks = rep.Chunks[:2]
		rep.Disconnect = true
		return rep
	})
	s := headers(t, openStream(t, caller))
	events := s.rest()
	e := streamError(t, events)
	if text(t, events) != "Hel" || e.Error.Code != "upstream_stream_broken" {
		t.Fatalf("events = %+v", events)
	}
	if got := bearers(up, 0); got != "a" {
		t.Fatalf("keys tried = %s", got)
	}
	if r := readRequest(t, srv, e.Error.RequestID); r.AttemptCount != 1 {
		t.Fatalf("request = %+v", r)
	}
}

func TestRevokingAGatewayKeyMidStreamLetsTheStreamFinish(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-one")
	caller := srv.Client(issue(t, srv, "pi", all))

	hold := make(chan struct{})
	stream := up.Stream("Hel", "lo")
	up.Enqueue(func(r *testkit.Received) testkit.Reply {
		rep := stream(r)
		rep.Chunks[2].Wait = hold
		return rep
	})
	s := headers(t, openStream(t, caller))
	s.expect(`"role":"assistant"`)
	s.expect(`"Hel"`)
	srv.Admin.Post("/api/gateway-keys/pi/revoke", nil).Expect(200)
	close(hold)
	events := s.rest()
	if got := text(t, events); got != "Hello" || events[len(events)-1].Data != "[DONE]" {
		t.Fatalf("text %q, events %+v", got, events)
	}
	if r := readRequest(t, srv, s.resp.Header.Get("X-Request-Id")); r.Status != 200 || r.Error != nil {
		t.Fatalf("request = %+v", r)
	}
	var e callerError
	caller.Post(chatPath, chat("gpt-x")).Expect(401).JSON(&e)
	if e.Error.Code != "gateway_key_invalid" || up.Count() != 1 {
		t.Fatalf("after revoke: %+v (upstream got %d)", e.Error, up.Count())
	}
}

func TestAnEmptyPlanRefusalIsRecordedWithoutAttempts(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	srv.Admin.Post("/api/providers/acme/keys/key-1/disable", nil).Expect(200)
	resp := caller.Post(chatPath, chat("gpt-x")).Expect(503)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Status != 503 || r.Error == nil || r.Error.Code != "no_candidate" || r.AttemptCount != 0 || len(r.Attempts) != 0 || r.State != "completed" {
		t.Fatalf("disabled: request = %+v", r)
	}

	srv.Admin.Post("/api/providers/acme/keys/key-1/enable", nil).Expect(200)
	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "45"))
	caller.Post(chatPath, chat("gpt-x")).Expect(503)
	resp = caller.Post(chatPath, chat("gpt-x")).Expect(503)
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Status != 503 || r.Error == nil || r.Error.Code != "keys_cooling" || r.AttemptCount != 0 || up.Count() != 1 {
		t.Fatalf("cooling: request = %+v", r)
	}
}

func TestProvidersSharingAnEndpointAndSecretEachSendTheirOwnWireModel(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	for handle, wire := range map[string]string{"claude-relay": "anthropic/claude-sonnet", "gemini-relay": "google/gemini-pro"} {
		srv.Admin.Post("/api/providers", map[string]any{"handle": handle}).Expect(201)
		srv.Admin.Post("/api/providers/"+handle+"/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat",
			"renames": map[string]string{"best": wire}}).Expect(201)
		srv.Admin.Post("/api/providers/"+handle+"/keys", map[string]any{"secret": "sk-test-shared"}).Expect(201)
	}
	caller := srv.Client(issue(t, srv, "pi", all))

	for handle, wire := range map[string]string{"claude-relay": "anthropic/claude-sonnet", "gemini-relay": "google/gemini-pro"} {
		resp := caller.Post("/providers/"+handle+"/v1/chat/completions", chat("best")).Expect(200)
		got := up.Last()
		if got.Model != wire || got.Bearer() != "sk-test-shared" {
			t.Fatalf("%s: upstream got model %q with %q", handle, got.Model, got.Bearer())
		}
		if m := resp.Map(); m["model"] != "best" {
			t.Fatalf("%s: the Caller saw model %v", handle, m["model"])
		}
		if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Provider != handle || r.WireModel != wire {
			t.Fatalf("%s: request = %+v", handle, r)
		}
	}
}
