package gateway_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// pool creates or replaces a Model Pool through the admin API; members are
// provider, model pairs.
func pool(t *testing.T, srv *testkit.Server, name string, extra map[string]any, pairs ...string) {
	t.Helper()
	var ms []any
	for i := 0; i < len(pairs); i += 2 {
		ms = append(ms, map[string]any{"provider": pairs[i], "model": pairs[i+1]})
	}
	body := map[string]any{"name": name, "members": ms}
	for k, v := range extra {
		body[k] = v
	}
	srv.Admin.Post("/api/pools", body).OK()
}

func TestAPoolFailsOverDownItsMembersAndEchoesItsName(t *testing.T) {
	srv := testkit.Start(t)
	zai, chutes := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	addProvider(t, srv, "zai", zai.URL(), "sk-test-z")
	addProvider(t, srv, "chutes", chutes.URL(), "sk-test-c")
	pool(t, srv, "glm-4.6", nil, "zai", "glm-4.6", "chutes", "zai-org/GLM-4.6")
	caller := srv.Client(issue(t, srv, "pi", all))

	// The first member's only key is refused: the second member serves.
	zai.Enqueue(zai.Error(429, "slow down"))
	chutes.Enqueue(chutes.Text("hi"))
	resp := caller.Post("/v1/chat/completions", chatBody("glm-4.6")).Expect(200)
	if zai.Last().Model != "glm-4.6" || chutes.Last().Model != "zai-org/GLM-4.6" || resp.Map()["model"] != "glm-4.6" {
		t.Fatalf("upstreams got %q, %q; answer %s", zai.Last().Model, chutes.Last().Model, resp.Body)
	}
	id := resp.Header.Get("X-Request-Id")
	r := readRequest(t, srv, id)
	if r.Pool != "glm-4.6" || r.Model != "glm-4.6" || r.Provider != "chutes" || r.WireModel != "zai-org/GLM-4.6" || r.AttemptCount != 2 ||
		r.Attempts[0].Provider != "zai" || r.Attempts[0].WireModel != "glm-4.6" || r.Attempts[1].Provider != "chutes" || r.Summary == "" {
		t.Fatalf("request = %+v", r)
	}
	// The feed filters on it.
	if !strings.Contains(srv.Admin.Get("/api/requests?pool=glm-4.6").Expect(200).Text(), id) {
		t.Fatalf("pool filter misses %s", id)
	}

	// Streamed, each chunk names the Pool.
	st := chatBody("glm-4.6")
	st["stream"] = true
	for _, e := range caller.Post("/v1/chat/completions", st).Expect(200).Events() {
		if e.Data != "[DONE]" && !strings.Contains(e.Data, `"model":"glm-4.6"`) {
			t.Fatalf("chunk = %s", e.Data)
		}
	}
	// zai's key cools for the model, so it was skipped without an Attempt.
	if zai.Count() != 1 || chutes.Count() != 2 {
		t.Fatalf("calls: zai %d, chutes %d", zai.Count(), chutes.Count())
	}

	// Reordering applies to the next Request.
	srv.Clock.Advance(2 * time.Minute)
	pool(t, srv, "glm-4.6", nil, "chutes", "zai-org/GLM-4.6", "zai", "glm-4.6")
	caller.Post("/v1/chat/completions", chatBody("glm-4.6")).Expect(200)
	if zai.Count() != 1 || chutes.Count() != 3 {
		t.Fatalf("after reorder: zai %d, chutes %d", zai.Count(), chutes.Count())
	}
	pool(t, srv, "glm-4.6", nil, "zai", "glm-4.6", "chutes", "zai-org/GLM-4.6")
	caller.Post("/v1/chat/completions", chatBody("glm-4.6")).Expect(200)
	if zai.Count() != 2 || chutes.Count() != 3 {
		t.Fatalf("after reorder back: zai %d, chutes %d", zai.Count(), chutes.Count())
	}
}

func TestAPoolSharesOneBudgetAcrossItsMembers(t *testing.T) {
	srv := testkit.Start(t)
	a, b, c := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	addProvider(t, srv, "a", a.URL(), "sk-test-a")
	addProvider(t, srv, "b", b.URL(), "sk-test-b")
	addProvider(t, srv, "c", c.URL(), "sk-test-c")
	pool(t, srv, "p", map[string]any{"budget": map[string]any{"max_attempts": 2}}, "a", "m", "b", "m", "c", "m")
	caller := srv.Client(issue(t, srv, "pi", all))

	// Two Attempts in all, whichever members they were on.
	a.Enqueue(a.Error(500, "boom"))
	b.Enqueue(b.Error(500, "boom"))
	var e callerError
	caller.Post("/v1/chat/completions", chatBody("p")).Expect(502).JSON(&e)
	if len(e.Error.Details.Attempts) != 2 || c.Count() != 0 || !strings.Contains(e.Error.Message, "Every Attempt on Model Pool p failed (2 Attempts)") {
		t.Fatalf("error = %+v; c called %d times", e.Error, c.Count())
	}

	// One time budget: the Pool's 20 s run out on the first member, and the
	// next member is not tried.
	srv.Admin.Patch("/api/pools/p", map[string]any{"budget": map[string]any{"max_attempts": 0, "first_byte_seconds": 20}}).OK()
	a.Enqueue(testkit.Hang())
	done := make(chan *testkit.Response, 1)
	go func() { done <- caller.Post("/v1/chat/completions", chatBody("p")) }()
	a.Await(2)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Clock.BlockUntil(ctx, 1); err != nil {
		t.Fatal(err)
	}
	srv.Clock.Advance(20 * time.Second)
	resp := <-done
	resp.Expect(504).JSON(&e)
	if len(e.Error.Details.Attempts) != 1 || b.Count() != 1 || c.Count() != 0 || !strings.Contains(e.Error.Message, "Model Pool p did not answer") {
		t.Fatalf("error = %+v; b %d c %d", e.Error, b.Count(), c.Count())
	}
}

func TestSwitchedOffAndUnusableMembersAreNotTried(t *testing.T) {
	srv := testkit.Start(t)
	a, b := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	addProvider(t, srv, "a", a.URL(), "sk-test-a")
	addProvider(t, srv, "b", b.URL(), "sk-test-b")
	srv.Admin.Post("/api/pools", map[string]any{"name": "p", "members": []any{
		map[string]any{"provider": "a", "model": "m", "enabled": false}, map[string]any{"provider": "b", "model": "m"}}}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))

	caller.Post("/v1/chat/completions", chatBody("p")).Expect(200)
	if a.Count() != 0 || b.Count() != 1 {
		t.Fatalf("calls: a %d, b %d", a.Count(), b.Count())
	}
	// A disabled Provider, a hidden model: nothing left to plan.
	srv.Admin.Patch("/api/providers/b", map[string]any{"enabled": false}).OK()
	resp := caller.Post("/v1/chat/completions", chatBody("p")).Expect(503)
	e := resp.Err()
	if e.Code != "no_candidate" || !strings.Contains(e.Message, "#1 a/m: Switched off by the Owner; #2 b/m: Provider b is disabled") {
		t.Fatalf("error = %+v", e)
	}
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Pool != "p" || r.AttemptCount != 0 {
		t.Fatalf("request = %+v", r)
	}
	srv.Admin.Patch("/api/providers/b", map[string]any{"enabled": true}).OK()
	srv.Admin.Post("/api/providers/b/models", map[string]any{"model": "m", "hidden": true}).Expect(201)
	if e := caller.Post("/v1/chat/completions", chatBody("p")).Expect(503).Err(); !strings.Contains(e.Message, `#2 b/m: Provider b does not offer the model "m"`) {
		t.Fatalf("error = %+v", e)
	}
	if b.Count() != 1 {
		t.Fatalf("b called %d times", b.Count())
	}
}

func TestGatewayKeyScopesNamePoolsAndRefuseOthersUniformly(t *testing.T) {
	srv := testkit.Start(t)
	a, b := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	addProvider(t, srv, "a", a.URL(), "sk-test-a")
	addProvider(t, srv, "b", b.URL(), "sk-test-b")
	pool(t, srv, "p", nil, "a", "m")
	pool(t, srv, "q", nil, "b", "m")
	srv.Admin.Post("/api/providers/a/models", map[string]any{"model": "m", "metadata": map[string]any{"context_length": 200000}}).Expect(201)

	// A key that may use Pool p only: served by its member a, though a is
	// not in the key's Providers.
	onlyP := srv.Client(issue(t, srv, "friend", map[string]any{"pools": []string{"p"}}))
	onlyP.Post("/v1/chat/completions", chatBody("p")).Expect(200)
	if e := onlyP.Post("/v1/chat/completions", chatBody("a/m")).Expect(403).Err(); e.Code != "provider_not_allowed" {
		t.Fatalf("a/m = %+v", e)
	}
	// A Pool outside the scope and one that does not exist look the same.
	out := onlyP.Post("/v1/chat/completions", chatBody("q")).Expect(400).Err()
	none := onlyP.Post("/v1/chat/completions", chatBody("nope")).Expect(400).Err()
	if out.Code != "invalid_model_id" || strings.ReplaceAll(out.Message, `"q"`, `"nope"`) != none.Message || out.Hint != none.Hint {
		t.Fatalf("out of scope %+v, unknown %+v", out, none)
	}
	if b.Count() != 0 {
		t.Fatalf("an out-of-scope Pool reached its member")
	}

	// The scope reads back with names; unknown Pools are refused.
	var key struct {
		Scope struct{ Pools []string }
	}
	srv.Admin.Get("/api/gateway-keys/friend").Expect(200).JSON(&key)
	if len(key.Scope.Pools) != 1 || key.Scope.Pools[0] != "p" {
		t.Fatalf("scope = %+v", key.Scope)
	}
	srv.Admin.Patch("/api/gateway-keys/friend", map[string]any{"scope": map[string]any{"pools": []string{"nope"}}}).Expect(404)
	// A Pool a key names cannot be deleted from under it.
	if e := srv.Admin.Delete("/api/pools/p").Expect(409).Err(); e.Code != "pool_in_use" || !strings.Contains(e.Message, "friend") {
		t.Fatalf("delete = %+v", e)
	}

	// /v1/models lists the Pool with its first member's metadata, and
	// nothing the key may not use.
	var list struct {
		Data []struct {
			ID            string
			OwnedBy       string `json:"owned_by"`
			ContextLength int    `json:"context_length"`
		}
	}
	onlyP.Get("/v1/models").Expect(200).JSON(&list)
	if len(list.Data) != 1 || list.Data[0].ID != "p" || list.Data[0].ContextLength != 200000 {
		t.Fatalf("models = %+v", list)
	}
	srv.Client(issue(t, srv, "everyone", all)).Get("/v1/models").Expect(200).JSON(&list)
	var ids []string
	for _, m := range list.Data {
		ids = append(ids, m.ID)
	}
	if strings.Join(ids, ",") != "p,q" { // a's model was never listed, only described
		t.Fatalf("models = %v", ids)
	}
}

func TestAPoolNamedInAGeminiURL(t *testing.T) {
	srv := testkit.Start(t)
	gem := testkit.NewGemini(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "google"}).Expect(201)
	srv.Admin.Post("/api/providers/google/endpoints", map[string]any{"url": gem.URL(), "shape": "gemini", "auth_style": "header", "auth_param": "x-goog-api-key"}).Expect(201)
	srv.Admin.Post("/api/providers/google/keys", map[string]any{"secret": "sk-test-gem"}).Expect(201)
	pool(t, srv, "flash", nil, "google", "gemini-2.5-flash")
	caller := srv.Anon.WithHeader("x-goog-api-key", issue(t, srv, "sdk", map[string]any{"pools": []string{"flash"}}))

	var ans geminiAnswer
	resp := caller.Post("/v1beta/models/flash:generateContent", generate("hi")).Expect(200).JSON(&ans)
	if got := gem.Last(); got.Path != "/v1beta/models/gemini-2.5-flash:generateContent" || ans.ModelVersion != "flash" {
		t.Fatalf("upstream path %s, answer %s", got.Path, resp.Body)
	}
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Pool != "flash" || r.Model != "flash" || r.WireModel != "gemini-2.5-flash" {
		t.Fatalf("request = %+v", r)
	}
	caller.Post("/v1beta/models/flash:streamGenerateContent?alt=sse", generate("hi")).Expect(200)
	if got := gem.Last(); got.Path != "/v1beta/models/gemini-2.5-flash:streamGenerateContent" {
		t.Fatalf("stream path %s", got.Path)
	}
	if e := caller.Post("/v1beta/models/other:generateContent", generate("hi")).Expect(400).Map(); e["error"] == nil {
		t.Fatalf("unknown Pool = %v", e)
	}
}

func TestTheRoutePreviewPlansLikeLiveTrafficAndSendsNothing(t *testing.T) {
	srv := testkit.Start(t)
	zai, chutes, sf := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	addProvider(t, srv, "zai", zai.URL(), "sk-test-1", "sk-test-2", "sk-test-3")
	addProvider(t, srv, "chutes", chutes.URL(), "sk-test-c")
	addProvider(t, srv, "siliconflow", sf.URL(), "sk-test-s")
	srv.Admin.Post("/api/pools", map[string]any{"name": "glm-4.6", "members": []any{
		map[string]any{"provider": "zai", "model": "glm-4.6"},
		map[string]any{"provider": "chutes", "model": "zai-org/GLM-4.6"},
		map[string]any{"provider": "siliconflow", "model": "zai-org/GLM-4.6", "enabled": false}}}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))

	// key-1 cools for glm-4.6 (key-2 answers), key-2 is then disabled. The
	// prompt is empty, so there is no conversation and keys go round-robin.
	zai.Enqueue(zai.Error(429, "slow down").Header("Retry-After", "40"), zai.Text("hi"))
	caller.Post("/v1/chat/completions", map[string]any{"model": "glm-4.6", "messages": []any{}}).Expect(200)
	srv.Admin.Post("/api/providers/zai/keys/key-2/disable", nil).OK()
	calls := zai.Count() + chutes.Count() + sf.Count()

	preview := func(query string) gateway.RoutePreview {
		t.Helper()
		var pv gateway.RoutePreview
		srv.Admin.Get("/api/route-preview?" + query).Expect(200).JSON(&pv)
		return pv
	}
	pv := preview("model=glm-4.6")
	if pv.Pool != "glm-4.6" || pv.Outcome != nil || len(pv.Members) != 3 || pv.Ready != 2 || pv.Budget.MaxAttempts != 3 || pv.Budget.FirstByteSeconds != 60 {
		t.Fatalf("preview = %+v", pv)
	}
	m1, m2, m3 := pv.Members[0], pv.Members[1], pv.Members[2]
	if !m1.Planned || m1.Provider != "zai" || m1.Keys != 3 || m1.ReadyKeys != 1 || len(m1.Candidates) != 1 ||
		m1.Candidates[0].UpstreamKey != "key-3" || m1.Candidates[0].Endpoint != "default" || m1.Candidates[0].WireModel != "glm-4.6" {
		t.Fatalf("member 1 = %+v", m1)
	}
	skips := map[string]gateway.PreviewSkip{}
	for _, s := range m1.Skipped {
		skips[s.UpstreamKey] = s
	}
	if s := skips["key-1"]; s.Reason != "cooling_model" || s.Model != "glm-4.6" || s.Until == nil || s.SecondsLeft != 40 {
		t.Fatalf("key-1 skip = %+v", s)
	}
	if s := skips["key-2"]; s.Reason != "disabled" || len(skips) != 2 {
		t.Fatalf("skips = %+v", m1.Skipped)
	}
	if !m2.Planned || m2.Position != 2 || len(m2.Candidates) != 1 || m2.Candidates[0].WireModel != "zai-org/GLM-4.6" || m2.Candidates[0].UpstreamKey != "key-1" {
		t.Fatalf("member 2 = %+v", m2)
	}
	if m3.Planned || m3.Enabled || m3.NotPlanned != "off" || m3.Provider != "siliconflow" || len(m3.Candidates) != 0 {
		t.Fatalf("member 3 = %+v", m3)
	}

	// A provider/model, and the refusal a Gateway Key would get.
	pv = preview("model=chutes/zai-org/GLM-4.6&shape=anthropic-messages")
	if len(pv.Members) != 1 || !pv.Members[0].Planned || pv.Members[0].Model != "zai-org/GLM-4.6" || !pv.Members[0].Candidates[0].Translated {
		t.Fatalf("provider preview = %+v", pv)
	}
	issue(t, srv, "narrow", map[string]any{"providers": []any{map[string]any{"provider": "chutes"}}})
	pv = preview("model=glm-4.6&as=narrow")
	if pv.As != "narrow" || pv.Outcome == nil || pv.Outcome.Status != 400 || pv.Outcome.Code != "invalid_model_id" || len(pv.Members) != 0 {
		t.Fatalf("as narrow = %+v", pv)
	}
	pv = preview("model=chutes/x&as=narrow")
	if pv.Outcome != nil || pv.Pool != "" || pv.Ready != 1 {
		t.Fatalf("as narrow, in scope = %+v", pv)
	}

	// Every member cooling or off: the members still show, with the refusal.
	srv.Admin.Post("/api/providers/zai/keys/key-3/disable", nil).OK()
	srv.Admin.Post("/api/providers/chutes/keys/key-1/disable", nil).OK()
	pv = preview("model=glm-4.6")
	if pv.Outcome == nil || pv.Outcome.Code != "keys_cooling" || len(pv.Members) != 3 || pv.Members[1].Empty == nil || pv.Members[1].Empty.Code != "no_usable_key" {
		t.Fatalf("all out = %+v", pv)
	}
	if n := zai.Count() + chutes.Count() + sf.Count(); n != calls {
		t.Fatalf("the preview sent %d upstream calls", n-calls)
	}
}
