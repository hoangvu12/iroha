package gateway_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testkit"
	"github.com/hoangvu12/iroha/internal/usage"
)

const geminiModels = "/providers/acme/v1beta/models/"

// addGeminiProvider adds Provider acme with one Gemini Endpoint that sends
// its Upstream Key the way Google's API takes it.
func addGeminiProvider(t *testing.T, srv *testkit.Server, url string, extra map[string]any) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	ep := map[string]any{"url": url, "shape": "gemini", "auth_style": "header", "auth_param": "x-goog-api-key"}
	for k, v := range extra {
		ep[k] = v
	}
	srv.Admin.Post("/api/providers/acme/endpoints", ep).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-gem"}).Expect(201)
}

func generate(text string) map[string]any {
	return map[string]any{"contents": []any{map[string]any{"role": "user", "parts": []any{map[string]any{"text": text}}}}}
}

// geminiCaller sends its Gateway Key the way the Google SDKs do.
func geminiCaller(t *testing.T, srv *testkit.Server) (*testkit.Client, string) {
	secret := issue(t, srv, "gemini-cli", all)
	return srv.Anon.WithHeader("x-goog-api-key", secret), secret
}

// geminiAnswer is a generateContent answer or stream chunk.
type geminiAnswer struct {
	ModelVersion string `json:"modelVersion"`
	Candidates   []struct {
		Content struct {
			Role  string
			Parts []struct {
				Text    string
				Thought bool
			}
		}
		FinishReason string `json:"finishReason"`
	}
	UsageMetadata map[string]any `json:"usageMetadata"`
}

func (a geminiAnswer) text() string {
	var b strings.Builder
	for _, c := range a.Candidates {
		for _, p := range c.Content.Parts {
			if !p.Thought {
				b.WriteString(p.Text)
			}
		}
	}
	return b.String()
}

// geminiChunks decodes a Gemini stream, checking every chunk names model.
func geminiChunks(t *testing.T, events []testkit.Event, model string) (text string, last geminiAnswer) {
	t.Helper()
	var b strings.Builder
	for _, e := range events {
		var a geminiAnswer
		if err := json.Unmarshal([]byte(e.Data), &a); err != nil || a.ModelVersion != model {
			t.Fatalf("chunk %q (want modelVersion %s)", e.Data, model)
		}
		b.WriteString(a.text())
		last = a
	}
	if len(events) == 0 || len(last.Candidates) == 0 || last.Candidates[0].FinishReason == "" {
		t.Fatalf("the stream did not finish: %+v", events)
	}
	return b.String(), last
}

// noSecret fails if the Gateway Key reached the upstream anywhere.
func noSecret(t *testing.T, got *testkit.Received, secret string) {
	t.Helper()
	if strings.Contains(string(got.Body), secret) || strings.Contains(got.Query.Encode(), secret) || strings.Contains(got.Path, secret) {
		t.Fatalf("the Gateway Key reached the upstream: %s?%s %s", got.Path, got.Query.Encode(), got.Body)
	}
	for k, vs := range got.Header {
		for _, v := range vs {
			if strings.Contains(v, secret) {
				t.Fatalf("the Gateway Key reached the upstream in %s", k)
			}
		}
	}
}

func TestGeminiPassesThroughToAGeminiEndpointWithTheModelInTheURL(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewGemini(t)
	addGeminiProvider(t, srv, up.URL(), map[string]any{"renames": map[string]string{"flash": "gemini-2.5-flash"}})
	caller, secret := geminiCaller(t, srv)

	body := `{"contents":[{"role":"user","parts":[{"text":"hi"}]}],  "safetySettings":[{"category":"HARM_CATEGORY_HARASSMENT","threshold":"BLOCK_NONE"}]}`
	resp := caller.Post(geminiModels+"flash:generateContent", body).Expect(200)
	got := up.Last()
	if string(got.Body) != body || got.Path != "/v1beta/models/gemini-2.5-flash:generateContent" || got.Header.Get("X-Goog-Api-Key") != "sk-test-gem" || len(got.Query) != 0 {
		t.Fatalf("upstream got %s?%s %v\n%s", got.Path, got.Query.Encode(), got.Header, got.Body)
	}
	noSecret(t, got, secret)
	var ans geminiAnswer
	resp.JSON(&ans)
	if ans.ModelVersion != "flash" || ans.text() != "Hello from the fake gemini upstream." || ans.Candidates[0].FinishReason != "STOP" {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "gemini" || r.ShapeOut != "gemini" || r.Model != "flash" || r.WireModel != "gemini-2.5-flash" || r.Stream ||
		r.Route != geminiModels+"flash:generateContent" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) {
		t.Fatalf("request = %+v usage %+v", r, r.Usage)
	}

	// Streamed: Iroha asks for server-sent events; each chunk names the
	// model asked for, and the usage of the last is recorded.
	resp = caller.Post(geminiModels+"flash:streamGenerateContent?alt=sse", body).Expect(200)
	got = up.Last()
	if string(got.Body) != body || got.Path != "/v1beta/models/gemini-2.5-flash:streamGenerateContent" || got.Query.Encode() != "alt=sse" {
		t.Fatalf("upstream got %s?%s\n%s", got.Path, got.Query.Encode(), got.Body)
	}
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("content type %s", resp.Header.Get("Content-Type"))
	}
	if text, _ := geminiChunks(t, resp.Events(), "flash"); text != "Hello from the fake gemini upstream." {
		t.Fatalf("text %q", text)
	}
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if !r.Stream || r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) || r.Error != nil {
		t.Fatalf("stream request = %+v usage %+v", r, r.Usage)
	}
}

func TestGeminiCallersAuthenticateByHeaderOrKeyParameterAndNeitherIsForwarded(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewGemini(t)
	// The Endpoint itself takes its key as ?key=, like Google's API.
	addGeminiProvider(t, srv, up.URL(), map[string]any{"auth_style": "query", "auth_param": "key"})
	secret := issue(t, srv, "sdk", all)

	srv.Anon.Post(geminiModels+"m:generateContent?key="+secret, generate("hi")).Expect(200)
	got := up.Last()
	if keys := got.Query["key"]; len(keys) != 1 || keys[0] != "sk-test-gem" || got.Header.Get("X-Goog-Api-Key") != "" || got.Header.Get("Authorization") != "" {
		t.Fatalf("upstream got %s?%s %v", got.Path, got.Query.Encode(), got.Header)
	}
	noSecret(t, got, secret)

	srv.Anon.Post(geminiModels+"m:streamGenerateContent?alt=sse&key="+secret, generate("hi")).Expect(200)
	got = up.Last()
	if got.Query.Get("alt") != "sse" || len(got.Query["key"]) != 1 {
		t.Fatalf("upstream got %s?%s", got.Path, got.Query.Encode())
	}
	noSecret(t, got, secret)

	srv.Anon.WithHeader("x-goog-api-key", secret).Post(geminiModels+"m:generateContent", generate("hi")).Expect(200)
	noSecret(t, up.Last(), secret)

	// The key parameter is a Caller credential on every route.
	srv.Anon.Post(geminiModels+"m:generateContent?key=sk-iroha_nope", generate("hi")).Expect(401)
	srv.Anon.Post(geminiModels+"m:generateContent", generate("hi")).Expect(401)
	if up.Count() != 3 {
		t.Fatalf("upstream calls = %d", up.Count())
	}
}

func TestAGeminiModelNameMayHoldSlashes(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewGemini(t)
	addGeminiProvider(t, srv, up.URL(), nil)
	caller, _ := geminiCaller(t, srv)

	resp := caller.Post(geminiModels+"google/gemini-2.5-flash:generateContent", generate("hi")).Expect(200)
	if got := up.Last(); got.Path != "/v1beta/models/google/gemini-2.5-flash:generateContent" {
		t.Fatalf("upstream path = %s", got.Path)
	}
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Model != "google/gemini-2.5-flash" {
		t.Fatalf("model = %q", r.Model)
	}
}

func TestTheGlobalGeminiRouteTakesAQualifiedModelThatMayHoldSlashes(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewGemini(t)
	addGeminiProvider(t, srv, up.URL(), nil)
	caller, secret := geminiCaller(t, srv)

	resp := caller.Post("/v1beta/models/acme/google/gemini-2.5-flash:generateContent", generate("hi")).Expect(200)
	got := up.Last()
	if got.Path != "/v1beta/models/google/gemini-2.5-flash:generateContent" {
		t.Fatalf("upstream path = %s", got.Path)
	}
	noSecret(t, got, secret)
	var a geminiAnswer
	resp.JSON(&a)
	if a.ModelVersion != "acme/google/gemini-2.5-flash" {
		t.Fatalf("modelVersion = %q, want the qualified name the Caller asked for", a.ModelVersion)
	}
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Model != "acme/google/gemini-2.5-flash" {
		t.Fatalf("model = %q", r.Model)
	}

	// The ?key= style works on the global route too, and an unqualified
	// name is refused with a hint.
	srv.Anon.Post("/v1beta/models/acme/gemini-2.5-flash:streamGenerateContent?alt=sse&key="+secret, generate("hi")).Expect(200)
	if got := up.Last(); got.Query.Has("key") {
		t.Fatalf("Caller key reached the upstream: %v", got.Query)
	}
	caller.Post("/v1beta/models/gemini-2.5-flash:generateContent", generate("hi")).Expect(400)
}

// geminiErr is Google's error envelope as Iroha writes it.
type geminiErr struct {
	Error struct {
		Code                          int
		Message, Status, Reason, Hint string
		RequestID                     string `json:"request_id"`
		Details                       []map[string]any
	}
}

func TestGeminiErrorsUseGooglesEnvelope(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewGemini(t)
	addGeminiProvider(t, srv, up.URL(), nil)
	caller, _ := geminiCaller(t, srv)

	var e geminiErr
	caller.Post("/providers/nope/v1beta/models/m:generateContent", generate("hi")).Expect(403).JSON(&e)
	if e.Error.Code != 403 || e.Error.Status != "PERMISSION_DENIED" || e.Error.Reason != "provider_not_allowed" ||
		e.Error.RequestID == "" || e.Error.Hint == "" || e.Error.Message == "" || len(e.Error.Details) != 1 || e.Error.Details[0]["reason"] != "provider_not_allowed" {
		t.Fatalf("error = %+v", e)
	}
	for _, op := range []string{"m:countTokens", "m", "m:embedContent"} {
		e = geminiErr{}
		caller.Post(geminiModels+op, generate("hi")).Expect(404).JSON(&e)
		if e.Error.Reason != "operation_not_supported" || e.Error.Status != "NOT_FOUND" {
			t.Fatalf("%s: error = %+v", op, e)
		}
	}
	e = geminiErr{}
	caller.Post(geminiModels+":generateContent", generate("hi")).Expect(400).JSON(&e)
	if e.Error.Reason != "model_required" || e.Error.Status != "INVALID_ARGUMENT" {
		t.Fatalf("error = %+v", e)
	}
	e = geminiErr{}
	caller.Post(geminiModels+"m:generateContent", `[1]`).Expect(400).JSON(&e)
	if e.Error.Code != 400 || e.Error.Status != "INVALID_ARGUMENT" || e.Error.RequestID == "" {
		t.Fatalf("error = %+v", e)
	}
	if up.Count() != 0 {
		t.Fatalf("upstream calls = %d", up.Count())
	}
}

func TestGeminiIsTranslatedForAnOpenAIChatEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addEndpointProvider(t, srv, "acme", "openai-chat", up.URL(), "sk-test-oai")
	caller, secret := geminiCaller(t, srv)
	up.SetUsage(30, 7)

	req := generate("hi")
	req["systemInstruction"] = map[string]any{"parts": []any{map[string]any{"text": "Be terse."}}}
	resp := caller.Post(geminiModels+"glm-4.6:generateContent", req).Expect(200)
	got := up.Last()
	sent := got.Map(t)
	msgs, _ := sent["messages"].([]any)
	if got.Path != "/v1/chat/completions" || got.Bearer() != "sk-test-oai" || sent["model"] != "glm-4.6" || len(msgs) != 2 || sent["stream"] == true {
		t.Fatalf("upstream got %s %v\n%s", got.Path, got.Header, got.Body)
	}
	noSecret(t, got, secret)
	var ans geminiAnswer
	resp.JSON(&ans)
	if ans.ModelVersion != "glm-4.6" || ans.text() != "Hello from the fake openai-chat upstream." || ans.Candidates[0].FinishReason != "STOP" ||
		ans.UsageMetadata["promptTokenCount"] != float64(30) || ans.UsageMetadata["candidatesTokenCount"] != float64(7) {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "gemini" || r.ShapeOut != "openai-chat" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 30, Output: 7}) {
		t.Fatalf("request = %+v usage %+v", r, r.Usage)
	}

	// Streamed: Chat chunks become Gemini chunks, usage on the last one.
	resp = caller.Post(geminiModels+"glm-4.6:streamGenerateContent?alt=sse", req).Expect(200)
	sent = up.Last().Map(t)
	if opts, _ := sent["stream_options"].(map[string]any); sent["stream"] != true || opts["include_usage"] != true {
		t.Fatalf("upstream stream request = %s", up.Last().Body)
	}
	text, last := geminiChunks(t, resp.Events(), "glm-4.6")
	if text != "Hello from the fake openai-chat upstream." || last.UsageMetadata["promptTokenCount"] != float64(30) || last.UsageMetadata["candidatesTokenCount"] != float64(7) {
		t.Fatalf("text %q, last chunk %+v", text, last)
	}
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if !r.Stream || r.Usage == nil || *r.Usage != (usage.Usage{Input: 30, Output: 7}) || r.Error != nil {
		t.Fatalf("stream request = %+v usage %+v", r, r.Usage)
	}
}

func TestGeminiIsTranslatedForAnAnthropicEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewAnthropic(t)
	addEndpointProvider(t, srv, "acme", "anthropic-messages", up.URL(), "sk-test-ant")
	caller, secret := geminiCaller(t, srv)

	resp := caller.Post(geminiModels+"claude-haiku-4-5:generateContent", generate("hi")).Expect(200)
	got := up.Last()
	if got.Path != "/v1/messages" || got.Header.Get("X-Api-Key") != "sk-test-ant" || got.Map(t)["model"] != "claude-haiku-4-5" {
		t.Fatalf("upstream got %s %v\n%s", got.Path, got.Header, got.Body)
	}
	noSecret(t, got, secret)
	var ans geminiAnswer
	resp.JSON(&ans)
	if ans.ModelVersion != "claude-haiku-4-5" || ans.text() != "Hello from the fake anthropic-messages upstream." {
		t.Fatalf("answer = %s", resp.Body)
	}

	resp = caller.Post(geminiModels+"claude-haiku-4-5:streamGenerateContent", generate("hi")).Expect(200)
	text, last := geminiChunks(t, resp.Events(), "claude-haiku-4-5")
	if text != "Hello from the fake anthropic-messages upstream." || last.UsageMetadata["promptTokenCount"] != float64(10) || last.UsageMetadata["candidatesTokenCount"] != float64(5) {
		t.Fatalf("text %q, last chunk %+v", text, last)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeOut != "anthropic-messages" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) {
		t.Fatalf("stream request = %+v usage %+v", r, r.Usage)
	}
}

func TestChatAndMessagesAreTranslatedForAGeminiEndpoint(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewGemini(t)
	addGeminiProvider(t, srv, up.URL(), map[string]any{"renames": map[string]string{"smart": "gemini-2.5-pro"}})
	caller := srv.Client(issue(t, srv, "pi", all))

	resp := caller.Post(chatPath, chat("smart")).Expect(200)
	got := up.Last()
	sent := got.Map(t)
	if got.Path != "/v1beta/models/gemini-2.5-pro:generateContent" || got.Header.Get("X-Goog-Api-Key") != "sk-test-gem" || got.Header.Get("Authorization") != "" ||
		sent["model"] != nil || sent["contents"] == nil {
		t.Fatalf("upstream got %s %v\n%s", got.Path, got.Header, got.Body)
	}
	var ans struct {
		Object, Model string
		Choices       []struct {
			Message struct{ Content string }
		}
		Usage map[string]any
	}
	resp.JSON(&ans)
	if ans.Object != "chat.completion" || ans.Model != "smart" || len(ans.Choices) != 1 || ans.Choices[0].Message.Content != "Hello from the fake gemini upstream." ||
		ans.Usage["prompt_tokens"] != float64(10) {
		t.Fatalf("answer = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "openai-chat" || r.ShapeOut != "gemini" || r.WireModel != "gemini-2.5-pro" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) {
		t.Fatalf("request = %+v usage %+v", r, r.Usage)
	}

	req := chat("smart")
	req["stream"] = true
	resp = caller.Post(chatPath, req).Expect(200)
	if got := up.Last(); got.Path != "/v1beta/models/gemini-2.5-pro:streamGenerateContent" || got.Query.Get("alt") != "sse" {
		t.Fatalf("upstream got %s?%s", got.Path, got.Query.Encode())
	}
	events := resp.Events()
	if got := text(t, events); got != "Hello from the fake gemini upstream." || events[len(events)-1].Data != "[DONE]" {
		t.Fatalf("events = %+v", events)
	}
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) || r.Error != nil {
		t.Fatalf("stream request = %+v usage %+v", r, r.Usage)
	}

	resp = claudeCaller(t, srv).Post(messagesPath, messages("smart")).Expect(200)
	var msg struct {
		Type, Model string
		Content     []struct{ Type, Text string }
	}
	resp.JSON(&msg)
	if up.Last().Path != "/v1beta/models/gemini-2.5-pro:generateContent" || msg.Type != "message" || msg.Model != "smart" ||
		len(msg.Content) != 1 || msg.Content[0].Text != "Hello from the fake gemini upstream." {
		t.Fatalf("answer = %s", resp.Body)
	}
}

func TestGeminiAndResponsesTranslateBothWays(t *testing.T) {
	srv := testkit.Start(t)
	gem := testkit.NewGemini(t)
	addGeminiProvider(t, srv, gem.URL(), nil)
	oai := testkit.NewOpenAIResponses(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "openai"}).Expect(201)
	srv.Admin.Post("/api/providers/openai/endpoints", map[string]any{"url": oai.URL(), "shape": "openai-responses"}).Expect(201)
	srv.Admin.Post("/api/providers/openai/keys", map[string]any{"secret": "sk-test-oai"}).Expect(201)
	caller, _ := geminiCaller(t, srv)

	// A Responses Caller on the Gemini Endpoint, streamed.
	req := responsesReq("gemini-2.5-flash")
	req["stream"] = true
	resp := caller.Post(responsesPath, req).Expect(200)
	if got := gem.Last(); got.Path != "/v1beta/models/gemini-2.5-flash:streamGenerateContent" || got.Query.Get("alt") != "sse" {
		t.Fatalf("upstream got %s?%s", got.Path, got.Query.Encode())
	}
	evs, text := readResponses(t, resp.Events())
	if evs[0].Type != "response.created" || evs[len(evs)-1].Type != "response.completed" || text != "Hello from the fake gemini upstream." {
		t.Fatalf("events = %+v", evs)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.ShapeIn != "openai-responses" || r.ShapeOut != "gemini" || r.Usage == nil || *r.Usage != (usage.Usage{Input: 10, Output: 5}) {
		t.Fatalf("request = %+v usage %+v", r, r.Usage)
	}

	// A Gemini Caller on the Responses Endpoint, buffered and streamed.
	resp = caller.Post("/providers/openai/v1beta/models/gpt-5:generateContent", generate("hi")).Expect(200)
	if got := oai.Last(); got.Path != "/v1/responses" || got.Map(t)["model"] != "gpt-5" {
		t.Fatalf("upstream got %s\n%s", got.Path, got.Body)
	}
	var ans geminiAnswer
	resp.JSON(&ans)
	if ans.ModelVersion != "gpt-5" || ans.text() != "Hello from the fake openai-responses upstream." {
		t.Fatalf("answer = %s", resp.Body)
	}
	resp = caller.Post("/providers/openai/v1beta/models/gpt-5:streamGenerateContent?alt=sse", generate("hi")).Expect(200)
	text, last := geminiChunks(t, resp.Events(), "gpt-5")
	if text != "Hello from the fake openai-responses upstream." || last.UsageMetadata["promptTokenCount"] != float64(10) {
		t.Fatalf("text %q, last chunk %+v", text, last)
	}
}

func TestAGeminiStreamIsKeptAliveWithEmptyChunks(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewGemini(t)
	addGeminiProvider(t, srv, up.URL(), nil)
	caller, _ := geminiCaller(t, srv)
	open := func() <-chan *liveStream {
		ch := make(chan *liveStream, 1)
		go func() {
			resp := caller.Open(http.MethodPost, geminiModels+"m:streamGenerateContent?alt=sse", generate("hi"))
			ch <- &liveStream{t: t, resp: resp, lines: eventLines(resp.Body)}
		}()
		return ch
	}

	release := make(chan struct{})
	up.Enqueue(up.Stream("Hel", "lo").HoldUntil(release))
	ch := open()
	up.Await(1)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s := headers(t, ch)
	keepAlive := `data: {"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"index":0}]}`
	if l := s.next(); l != keepAlive {
		t.Fatalf("keep-alive = %q", l)
	}
	close(release)
	events := s.rest()
	if text, _ := geminiChunks(t, events[1:], "m"); text != "Hello" {
		t.Fatalf("text %q", text)
	}

	// A committed stream that then fails ends with Google's error envelope.
	up.Enqueue(testkit.Hang())
	ch = open()
	up.Await(2)
	srv.Clock.Advance(gateway.StreamCommitAfter)
	s = headers(t, ch)
	s.expect(keepAlive)
	srv.Clock.Advance(100 * time.Second)
	events = s.rest()
	var e geminiErr
	if err := json.Unmarshal([]byte(events[len(events)-1].Data), &e); err != nil || e.Error.Reason != "upstream_timeout" || e.Error.Code == 0 || e.Error.Status == "" || e.Error.RequestID == "" {
		t.Fatalf("events = %+v", events)
	}
}

func TestCapturedGeminiStreamsAreReassembled(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewGemini(t)
	addGeminiProvider(t, srv, up.URL(), nil)
	var out struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "cap", "scope": all, "capture": true}).Expect(201).JSON(&out)
	caller := srv.Anon.WithHeader("x-goog-api-key", out.GatewayKey.Secret)

	resp := caller.Post(geminiModels+"m:streamGenerateContent?alt=sse", generate("hi")).Expect(200)
	var c requests.CaptureView
	srv.Admin.Get("/api/requests/" + resp.Header.Get("X-Request-Id") + "/capture").Expect(200).JSON(&c)
	var ans geminiAnswer
	if err := json.Unmarshal(c.Response.Body, &ans); err != nil {
		t.Fatalf("capture body = %s", c.Response.Body)
	}
	if ans.ModelVersion != "m" || len(ans.Candidates) != 1 || len(ans.Candidates[0].Content.Parts) != 1 ||
		ans.text() != "Hello from the fake gemini upstream." || ans.Candidates[0].FinishReason != "STOP" ||
		ans.UsageMetadata["candidatesTokenCount"] != float64(5) || c.Response.Stream == "" {
		t.Fatalf("capture = %s", c.Response.Body)
	}
}
