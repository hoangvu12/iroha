package gateway_test

import (
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/failurerules"
	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func addProviderAt(t *testing.T, srv *testkit.Server, handle, url string, secrets ...string) {
	t.Helper()
	addProvider(t, srv, handle, url, secrets...)
}

const arrearage = `{"error":{"code":"Arrearage","type":"Arrearage","param":null,"message":"Access denied, please make sure your account is in good standing."}}`

func TestDashScopeQuirksApplyByEndpointHostWhateverTheHandle(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addProviderAt(t, srv, "acme", up.URLAt("dashscope-intl.aliyuncs.com"), "sk-test-a", "sk-test-b", "sk-test-c")
	addProviderAt(t, srv, "other", up.URLAt("api.example.com"), "sk-test-o")
	srv.NoConversationIDs("acme")
	srv.NoConversationIDs("other")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(testkit.Raw(400, "application/json", arrearage), up.Text("hello"))
	resp := caller.Post(chatPath, chat("qwen-max")).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Rule != "dashscope-arrearage" || r.Attempts[0].Outcome != "cooling_key" {
		t.Fatalf("attempts = %+v", r.Attempts)
	}
	k := readKey(t, srv, r.Attempts[0].UpstreamKey)
	if k.State.State != "cooling" || k.State.Rule != "dashscope-arrearage" || k.State.Until == nil || !k.State.Until.Equal(srv.Clock.Now().Add(15*time.Minute)) {
		t.Fatalf("overdue key = %+v", k.State)
	}

	up.Enqueue(testkit.Raw(403, "application/json", `{"error":{"code":"Model.AccessDenied","message":"Model access denied.","param":null,"type":"Model.AccessDenied"}}`), up.Text("hello"))
	resp = caller.Post(chatPath, chat("qwen-max")).Expect(200)
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Attempts[0].Rule != "dashscope-model-refused" || r.Attempts[0].Outcome != "model_gap" {
		t.Fatalf("model refusal = %+v", r.Attempts)
	}
	n := up.Count()
	up.Enqueue(testkit.Raw(400, "application/json", `{"error":{"code":"invalid_parameter_error","message":"The value of temperature must be in [0, 2)."}}`))
	var e callerError
	caller.Post(chatPath, chat("qwen-max")).Expect(400).JSON(&e)
	if e.Error.Code != "upstream_rejected" || len(e.Error.Details.Attempts) != 1 || e.Error.Details.Attempts[0].Rule != "bad-request" || up.Count() != n+1 {
		t.Fatalf("bad parameter = %+v", e.Error)
	}

	caller.Post("/providers/other/v1/chat/completions", chat("qwen-max")).Expect(200)
	up.Enqueue(testkit.Raw(400, "application/json", arrearage))
	caller.Post("/providers/other/v1/chat/completions", chat("qwen-max")).Expect(400).JSON(&e)
	if e.Error.Details.Attempts[0].Rule != "bad-request" {
		t.Fatalf("other host = %+v", e.Error.Details.Attempts)
	}

	var l failurerules.RuleList
	srv.Admin.Get("/api/rules?provider=acme").Expect(200).JSON(&l)
	names := map[string]bool{}
	for _, r := range l.Rules {
		names[r.Name] = true
	}
	if !names["dashscope-arrearage"] || names["zai-usage-window"] || !names["rate-limited"] || l.Rules[0].Name != "dashscope-arrearage" {
		t.Fatalf("rules for acme = %v", names)
	}
	srv.Admin.Get("/api/rules?provider=other").Expect(200).JSON(&l)
	for _, r := range l.Rules {
		if strings.HasPrefix(r.Name, "dashscope-") {
			t.Fatalf("rules for other include %s", r.Name)
		}
	}
}

func TestBillingRefusalsCoolTheWholeKeyNotTheModel(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addProviderAt(t, srv, "acme", up.URLAt("inference-api.nousresearch.com"), "sk-test-a", "sk-test-b")
	roundRobin(t, srv, "acme")
	caller := srv.Client(issue(t, srv, "pi", all))

	// Nous refuses an account without credits with a 404.
	up.Enqueue(testkit.Raw(404, "application/json",
		`{"status":404,"message":"Model requires available credits. Your account balance is too low to use paid models.","code":"insufficient_credits_for_paid_model"}`),
		up.Text("hello"))
	resp := caller.Post(chatPath, chat("Hermes-4-405B")).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Attempts[0].Rule != "nous-insufficient-credits" || r.Attempts[0].Outcome != "cooling_key" {
		t.Fatalf("attempts = %+v", r.Attempts)
	}
	if k := readKey(t, srv, "key-1"); k.State.State != "cooling" || len(k.CoolingModels) != 0 {
		t.Fatalf("key-1 = %+v", k)
	}
	resp = caller.Post(chatPath, chat("Hermes-4-70B")).Expect(200)
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); len(r.Attempts) != 1 || r.Attempts[0].UpstreamKey != "key-2" {
		t.Fatalf("second request = %+v", r.Attempts)
	}
}

func chunk(content string) string {
	return `data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"` + content + `"},"finish_reason":null}]}` + "\n\n"
}

func TestStreamedErrorBodiesAreClassifiedLikeBufferedOnes(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addProviderAt(t, srv, "acme", up.URLAt("api.z.ai"), "sk-test-a", "sk-test-b", "sk-test-c")
	addProviderAt(t, srv, "mm", up.URLAt("api.minimax.io"), "sk-test-m1", "sk-test-m2")
	addProviderAt(t, srv, "or", up.URLAt("openrouter.ai"), "sk-test-r1", "sk-test-r2")
	caller := srv.Client(issue(t, srv, "pi", all))
	stream := func(model string) map[string]any {
		b := chat(model)
		b["stream"] = true
		return b
	}
	reset := srv.Clock.Now().Add(2 * time.Hour)

	// Z.ai sends a usage-window refusal as the first event of a 200 stream.
	up.Enqueue(
		testkit.SSE(`data: {"error":{"code":"1308","message":"5-hour limit reached","next_flush_time":"`+reset.Format(time.RFC3339)+`"}}`+"\n\n"),
		up.Stream("Hel", "lo"))
	resp := caller.Post(chatPath, stream("glm-4.6")).Expect(200)
	if txt := resp.Text(); strings.Contains(txt, "1308") || !strings.Contains(txt, "Hel") || !strings.Contains(txt, "[DONE]") {
		t.Fatalf("stream = %s", txt)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	a := r.Attempts[0]
	if len(r.Attempts) != 2 || a.Status != 200 || a.Rule != "zai-usage-window" || a.Outcome != "cooling_key" ||
		!strings.Contains(a.FailureBody, "1308") || !strings.Contains(a.Reason, "inside a 2xx answer") {
		t.Fatalf("attempts = %+v", r.Attempts)
	}
	if k := readKey(t, srv, a.UpstreamKey); k.State.State != "cooling" || k.State.Until == nil || !k.State.Until.Equal(reset) {
		t.Fatalf("cooled key = %+v", k.State)
	}

	up.Enqueue(testkit.Raw(429, "text/event-stream", `data: {"error":{"code":"1113","message":"Insufficient balance or no resource package."}}`+"\n\n"), up.Stream("ok"))
	resp = caller.Post(chatPath, stream("glm-4.6")).Expect(200)
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Attempts[0].Rule != "zai-plan-billing" {
		t.Fatalf("event-stream error body = %+v", r.Attempts)
	}

	up.Enqueue(testkit.Raw(200, "application/json", `{"id":"","choices":null,"model":"MiniMax-M2","base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}`), up.Text("hello"))
	resp = caller.Post("/providers/mm/v1/chat/completions", chat("MiniMax-M2")).Expect(200)
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Attempts[0].Rule != "minimax-base-resp-balance" || r.Attempts[0].Outcome != "cooling_key" || r.Status != 200 {
		t.Fatalf("base_resp = %+v", r.Attempts)
	}

	// OpenRouter streams comments while it waits, and an error after its 200
	// as a chunk.
	up.Enqueue(testkit.SSE(": OPENROUTER PROCESSING\n\n",
		`data: {"id":"gen-1","object":"chat.completion.chunk","error":{"code":"server_error","message":"Provider disconnected"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}`+"\n\n"),
		up.Stream("fine"))
	resp = caller.Post("/providers/or/v1/chat/completions", stream("x/y")).Expect(200)
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Attempts[0].Rule != "server-error" || r.Attempts[0].Outcome != "retry_elsewhere" || !strings.Contains(r.Attempts[0].Reason, "500 server_error") {
		t.Fatalf("openrouter = %+v", r.Attempts)
	}
	if k := readKey2(t, srv, "or", r.Attempts[0].UpstreamKey); k != "active" {
		t.Fatalf("openrouter key = %s", k)
	}

	up.Enqueue(testkit.SSE(": OPENROUTER PROCESSING\n\n", chunk("Hi"), chunk(" there"), "data: [DONE]\n\n"))
	resp = caller.Post("/providers/or/v1/chat/completions", stream("x/y")).Expect(200)
	if txt := resp.Text(); !strings.HasPrefix(txt, ": OPENROUTER PROCESSING\n\n") || !strings.Contains(txt, `"Hi"`) || !strings.Contains(txt, `" there"`) {
		t.Fatalf("healthy stream = %q", txt)
	}
}

func TestAKeyTestReadsAnErrorInsideA200AsAFailure(t *testing.T) {
	up := testkit.NewOpenAIChat(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addProviderAt(t, srv, "acme", up.URLAt("api.minimax.io"), "sk-test-m1")
	refusal := testkit.Raw(200, "application/json", `{"id":"","choices":null,"model":"MiniMax-M2","base_resp":{"status_code":2049,"status_msg":"invalid api key"}}`)

	up.Enqueue(up.ErrorCode(404, "model_not_found", "The model gpt-x does not exist."))
	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=gpt-x", nil).Expect(200)
	if g := gapsOf(readKey(t, srv, "key-1")); g != "gpt-x" {
		t.Fatalf("gaps = %q", g)
	}

	up.Enqueue(refusal)
	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=MiniMax-M2", nil).Expect(200).JSON(&res)
	if res.Passed || res.Status != 200 || res.Rule != "minimax-base-resp-auth" || res.Outcome != "invalid" || res.State.State != "invalid" {
		t.Fatalf("test = %+v", res)
	}
	up.Enqueue(refusal)
	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=MiniMax-M2", nil).Expect(200).JSON(&res)
	if k := readKey(t, srv, "key-1"); res.Passed || k.State.State != "invalid" || gapsOf(k) != "gpt-x" {
		t.Fatalf("second test = %+v, key %+v", res, k)
	}

	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=MiniMax-M2", nil).Expect(200).JSON(&res)
	if !res.Passed || res.State.State != "active" {
		t.Fatalf("healthy test = %+v", res)
	}
}

func readKey2(t *testing.T, srv *testkit.Server, handle, name string) string {
	t.Helper()
	var k struct {
		State struct{ State string } `json:"state"`
	}
	srv.Admin.Get("/api/providers/" + handle + "/keys/" + name).Expect(200).JSON(&k)
	return k.State.State
}
