package gateway_test

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func chat(model string) map[string]any {
	return map[string]any{"model": model, "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
}

func readKey(t *testing.T, srv *testkit.Server, name string) providers.UpstreamKey {
	t.Helper()
	var k providers.UpstreamKey
	srv.Admin.Get("/api/providers/acme/keys/" + name).Expect(200).JSON(&k)
	return k
}

type callerError struct {
	Error struct {
		Code, Message, Hint string
		RequestID           string `json:"request_id"`
		Details             struct {
			Reason   string
			Until    string
			Summary  string
			Attempts []struct {
				Seq                                  int
				UpstreamKey                          string `json:"upstream_key"`
				Status                               int
				Rule, Outcome, Reason, Action, Model string
			}
		}
	}
}

func bearers(up *testkit.Upstream, from int) string {
	var out []string
	for _, r := range up.Requests()[from:] {
		if r.Method == http.MethodGet {
			continue
		}
		out = append(out, strings.TrimPrefix(r.Bearer(), "sk-test-"))
	}
	return strings.Join(out, ",")
}

func TestFailedAttemptsMoveOnToOtherKeysAndEachExplainsItself(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c")
	roundRobin(t, srv, "acme")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(up.Error(500, "boom").Header("X-Upstream-Trace", "t-1"),
		up.ErrorCode(429, "rate_limit_exceeded", "Slow down").Header("Retry-After", "30"),
		up.Text("hello"))
	resp := caller.Post(chatPath, chat("gpt-x")).Expect(200)
	if got := bearers(up, 0); got != "a,b,c" {
		t.Fatalf("keys tried = %s", got)
	}
	id := resp.Header.Get("X-Request-Id")
	r := readRequest(t, srv, id)
	if r.AttemptCount != 3 || len(r.Attempts) != 3 || r.Status != 200 || r.UpstreamKey != "key-3" {
		t.Fatalf("request = %+v", r)
	}
	a1, a2, a3 := r.Attempts[0], r.Attempts[1], r.Attempts[2]
	if a1.Status != 500 || a1.Rule != "server-error" || a1.Outcome != "retry_elsewhere" || a1.Reason != "500 server_error: boom" || a1.Action == "" ||
		!strings.Contains(a1.FailureBody, "boom") || a1.FailureHeaders["X-Upstream-Trace"] != "t-1" {
		t.Fatalf("attempt 1 = %+v", a1)
	}
	if a2.Rule != "rate-limited" || a2.Outcome != "cooling_key_model" || !strings.Contains(a2.Action, "cooling for gpt-x") {
		t.Fatalf("attempt 2 = %+v", a2)
	}
	if a3.Status != 200 || a3.Rule != "" || a3.Outcome != "" || a3.FailureBody != "" {
		t.Fatalf("attempt 3 = %+v", a3)
	}
	for _, want := range []string{"#1 key-1: 500 server_error: boom -> server-error, retry_elsewhere", "#2 key-2: 429 rate_limit_exceeded: Slow down -> rate-limited, cooling_key_model until 00:00:30", "#3 key-3: 200"} {
		if !strings.Contains(r.Summary, want) {
			t.Fatalf("summary %q lacks %q", r.Summary, want)
		}
	}

	k2 := readKey(t, srv, "key-2")
	if k2.State.State != "active" || len(k2.CoolingModels) != 1 || k2.CoolingModels[0].Model != "gpt-x" ||
		!k2.CoolingModels[0].Until.Equal(testkit.Epoch.Add(30*time.Second)) || !strings.Contains(k2.CoolingModels[0].Reason, "Slow down") {
		t.Fatalf("key-2 = %+v", k2)
	}
	if k1 := readKey(t, srv, "key-1"); k1.State.State != "active" || len(k1.CoolingModels) != 0 {
		t.Fatalf("a 5xx changed key-1: %+v", k1)
	}
	if ev := srv.Logs("kind=rule.match&request_id=" + id); len(ev) != 2 || ev[0].Provider != "acme" || ev[0].Attrs["rule"] != "rate-limited" {
		t.Fatalf("rule.match events = %+v", ev)
	}
	ev := srv.Logs("kind=key.state&request_id=" + id)
	if len(ev) != 1 || ev[0].Level != "warn" || ev[0].Attrs["state"] != "cooling" || ev[0].Attrs["model"] != "gpt-x" || ev[0].Attrs["upstream_key"] != "key-2" {
		t.Fatalf("key.state events = %+v", ev)
	}

	n := up.Count()
	for range 3 {
		caller.Post(chatPath, chat("gpt-x")).Expect(200)
	}
	if got := bearers(up, n); strings.Contains(got, "b") {
		t.Fatalf("a cooling key served its model: %s", got)
	}
	n = up.Count()
	for range 3 {
		caller.Post(chatPath, chat("gpt-y")).Expect(200)
	}
	if got := bearers(up, n); !strings.Contains(got, "b") {
		t.Fatalf("a key cooling for one model stopped serving others: %s", got)
	}

	srv.Clock.Advance(31 * time.Second)
	n = up.Count()
	up.Enqueue(up.Error(500, "boom"), up.Error(500, "boom"))
	caller.Post(chatPath, chat("gpt-x")).Expect(200)
	if got := bearers(up, n); !strings.HasSuffix(got, ",b") {
		t.Fatalf("key-2 did not come back: %s", got)
	}
	if k2 := readKey(t, srv, "key-2"); len(k2.CoolingModels) != 0 || k2.State.State != "active" {
		t.Fatalf("key-2 after recovery = %+v", k2)
	}
}

func TestAStreamRefusedBeforeItsFirstByteMovesToTheNextKey(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))
	up.Enqueue(up.Error(429, "slow"), up.Stream("Hel", "lo"))
	body := chat("gpt-x")
	body["stream"] = true
	resp := caller.Post(chatPath, body).Expect(200)
	if !strings.HasPrefix(resp.Header.Get("Content-Type"), "text/event-stream") || strings.Contains(resp.Text(), "slow") || !strings.Contains(resp.Text(), "[DONE]") {
		t.Fatalf("stream = %s", resp.Body)
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.AttemptCount != 2 || r.Attempts[0].Outcome != "cooling_key_model" || r.Usage == nil || r.Summary == "" {
		t.Fatalf("request = %+v", r)
	}
}

func TestWhenEveryAttemptFailsTheCallerGetsEachAttempt(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	roundRobin(t, srv, "acme")
	srv.NoConversationIDs("acme")
	caller := srv.Client(issue(t, srv, "pi", all))

	srv.SkipShortWaits(time.Second)
	up.Default(up.Error(503, "overloaded"))
	var e callerError
	resp := caller.Post(chatPath, chat("gpt-x")).Expect(502).JSON(&e)
	if e.Error.Code != "upstream_failed" || len(e.Error.Details.Attempts) != 3 || e.Error.Hint == "" ||
		!strings.Contains(e.Error.Message, "#3 key-1: 503 server_error: overloaded") || !strings.Contains(e.Error.Details.Summary, "all 3 Attempts") {
		t.Fatalf("error = %s", resp.Body)
	}
	if got := bearers(up, 0); got != "a,b,a" {
		t.Fatalf("keys tried = %s", got)
	}
	r := readRequest(t, srv, e.Error.RequestID)
	if r.Status != 502 || r.Error.Code != "upstream_failed" || r.AttemptCount != 3 || r.Summary != e.Error.Details.Summary {
		t.Fatalf("request = %+v", r)
	}

	n := up.Count()
	up.Enqueue(up.ErrorCode(400, "invalid_value", "temperature must be at most 2"))
	resp = caller.Post(chatPath, chat("gpt-x")).Expect(400).JSON(&e)
	if e.Error.Code != "upstream_rejected" || !strings.Contains(e.Error.Message, "temperature must be at most 2") ||
		len(e.Error.Details.Attempts) != 1 || e.Error.Details.Attempts[0].Rule != "bad-request" || up.Count() != n+1 {
		t.Fatalf("rejected = %s", resp.Body)
	}
	if k := readKey(t, srv, "key-1"); k.State.State != "active" {
		t.Fatalf("a 400 changed a key: %+v", k)
	}
}

func TestInvalidKeysStayOutUntilATestPassesOrTheSecretChanges(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	roundRobin(t, srv, "acme")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(up.ErrorCode(401, "invalid_api_key", "Incorrect API key provided"))
	caller.Post(chatPath, chat("gpt-x")).Expect(200)
	k1 := readKey(t, srv, "key-1")
	if k1.State.State != "invalid" || k1.State.Rule != "unauthorized" || !strings.Contains(k1.State.Reason, "401 invalid_api_key: Incorrect API key provided") ||
		k1.State.Since == nil || k1.State.Until != nil || k1.State.RequestID == "" {
		t.Fatalf("key-1 = %+v", k1.State)
	}

	srv.Clock.Advance(5 * time.Hour)
	n := up.Count()
	for range 4 {
		caller.Post(chatPath, chat("gpt-x")).Expect(200)
	}
	if got := bearers(up, n); got != "b,b,b,b" {
		t.Fatalf("keys used = %s", got)
	}

	srv.Admin.Patch("/api/providers/acme/keys/key-1", map[string]any{"secret": "sk-test-a2"}).Expect(200)
	if k := readKey(t, srv, "key-1"); k.State.State != "active" || !strings.Contains(k.State.Reason, "secret") {
		t.Fatalf("after a new secret = %+v", k.State)
	}
	if ev := srv.Logs("kind=key.state&provider=acme"); len(ev) < 2 || ev[0].Attrs["from"] != "invalid" || ev[0].Attrs["state"] != "active" {
		t.Fatalf("key.state events = %+v", ev)
	}

	up.Enqueue(up.Error(401, "no"))
	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=gpt-x", nil).Expect(200)
	if k := readKey(t, srv, "key-1"); k.State.State != "invalid" {
		t.Fatalf("a failing test did not mark the key: %+v", k.State)
	}
	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/key-1/test", nil).Expect(200).JSON(&res)
	if !res.Passed || res.Status != 200 || res.Model != "gpt-x" || res.State.State != "active" || !strings.Contains(res.State.Reason, "test passed") {
		t.Fatalf("test = %+v", res)
	}
	got := up.Last()
	var sent struct {
		Model     string `json:"model"`
		MaxTokens int    `json:"max_tokens"`
		Messages  []struct{ Content string }
		Stream    bool
	}
	got.JSON(t, &sent)
	if sent.Model != "gpt-x" || sent.MaxTokens != 16 || len(sent.Messages) != 1 || sent.Stream || got.Bearer() != "sk-test-a2" {
		t.Fatalf("test call = %s (bearer %s)", got.Body, got.Bearer())
	}
}

func TestCoolingDoublesFromAMinuteAndHonoursResetTimes(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))
	until := func() time.Duration {
		k := readKey(t, srv, "key-1")
		if len(k.CoolingModels) != 1 {
			t.Fatalf("key-1 = %+v", k)
		}
		return k.CoolingModels[0].Until.Sub(srv.Clock.Now())
	}

	up.Enqueue(up.Error(429, "slow"))
	caller.Post(chatPath, chat("gpt-x")).Expect(503)
	if d := until(); d != time.Minute {
		t.Fatalf("first cooling = %v", d)
	}
	n := up.Count()
	var e callerError
	resp := caller.Post(chatPath, chat("gpt-x")).Expect(503).JSON(&e)
	if e.Error.Code != "keys_cooling" || e.Error.Details.Reason != "cooling" || e.Error.Details.Until != "2026-01-01T00:01:00Z" ||
		resp.Header.Get("Retry-After") != "60" || up.Count() != n {
		t.Fatalf("cooling refusal = %s (Retry-After %q)", resp.Body, resp.Header.Get("Retry-After"))
	}

	want := []time.Duration{2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 16 * time.Minute, 32 * time.Minute, time.Hour, time.Hour}
	for _, w := range want {
		srv.Clock.Advance(until() + time.Second)
		up.Enqueue(up.Error(429, "slow"))
		caller.Post(chatPath, chat("gpt-x")).Expect(503)
		if d := until(); d != w {
			t.Fatalf("cooling = %v, want %v", d, w)
		}
	}

	srv.Clock.Advance(until() + time.Second)
	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "300"))
	caller.Post(chatPath, chat("gpt-x")).Expect(503)
	if d := until(); d != 5*time.Minute {
		t.Fatalf("Retry-After cooling = %v", d)
	}

	srv.Clock.Advance(6 * time.Minute)
	caller.Post(chatPath, chat("gpt-x")).Expect(200)
	if k := readKey(t, srv, "key-1"); len(k.CoolingModels) != 0 {
		t.Fatalf("success left %+v", k.CoolingModels)
	}
	srv.Clock.Advance(2 * time.Hour)
	up.Enqueue(up.Error(429, "slow"))
	caller.Post(chatPath, chat("gpt-x")).Expect(503)
	if d := until(); d != time.Minute {
		t.Fatalf("cooling after recovery = %v", d)
	}

	srv.Clock.Advance(2 * time.Hour)
	up.Enqueue(up.Error(402, "Insufficient credits"))
	caller.Post(chatPath, chat("gpt-y")).Expect(503)
	k := readKey(t, srv, "key-1")
	if k.State.State != "cooling" || k.State.Until == nil || !k.State.Until.Equal(srv.Clock.Now().Add(time.Minute)) || k.State.Rule != "payment-required" {
		t.Fatalf("402 = %+v", k.State)
	}
}

func TestCoolingForThreeModelsWithinFiveMinutesCoolsTheWholeKey(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	for i, m := range []string{"m-1", "m-2", "m-3"} {
		up.Enqueue(up.Error(429, "slow").Header("Retry-After", "600"))
		caller.Post(chatPath, chat(m)).Expect(503)
		k := readKey(t, srv, "key-1")
		if i < 2 && k.State.State != "active" {
			t.Fatalf("escalated after %d models: %+v", i+1, k.State)
		}
		srv.Clock.Advance(time.Minute)
	}
	k := readKey(t, srv, "key-1")
	if k.State.State != "cooling" || !strings.Contains(k.State.Reason, "3 models") || len(k.CoolingModels) != 3 {
		t.Fatalf("after 3 models = %+v", k)
	}
	n := up.Count()
	var e callerError
	caller.Post(chatPath, chat("m-4")).Expect(503).JSON(&e)
	if e.Error.Code != "keys_cooling" || up.Count() != n {
		t.Fatalf("a key-wide cooling let m-4 through: %+v", e.Error)
	}

	srv2 := testkit.Start(t)
	addProvider(t, srv2, "acme", up.URL(), "sk-test-z")
	caller2 := srv2.Client(issue(t, srv2, "pi", all))
	for _, m := range []string{"m-1", "m-2", "m-3"} {
		up.Enqueue(up.Error(429, "slow"))
		caller2.Post(chatPath, chat(m)).Expect(503)
		srv2.Clock.Advance(3 * time.Minute)
	}
	if k := readKey(t, srv2, "key-1"); k.State.State != "active" {
		t.Fatalf("escalated over 6 minutes: %+v", k.State)
	}
}

func TestTheTimeBudgetEndsASilentAttemptWithoutReplayingIt(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(testkit.Hang())
	done := make(chan *testkit.Response, 1)
	go func() { done <- caller.Post(chatPath, chat("gpt-x")) }()
	up.Await(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Clock.BlockUntil(ctx, 1); err != nil {
		t.Fatal(err)
	}
	srv.Clock.Advance(59 * time.Second)
	select {
	case r := <-done:
		t.Fatalf("answered before the budget ran out: %d %s", r.Status, r.Body)
	case <-time.After(50 * time.Millisecond):
	}
	srv.Clock.Advance(time.Second)
	resp := <-done
	var e callerError
	resp.Expect(504).JSON(&e)
	if e.Error.Code != "upstream_timeout" || len(e.Error.Details.Attempts) != 1 || e.Error.Details.Attempts[0].Rule != "upstream-timeout" || up.Count() != 1 {
		t.Fatalf("timeout = %s (upstream got %d)", resp.Body, up.Count())
	}
	if k := readKey(t, srv, "key-1"); k.State.State != "active" || len(k.CoolingModels) != 0 {
		t.Fatalf("a timeout changed the key: %+v", k)
	}

	srv.Admin.Patch("/api/providers/acme", map[string]any{"first_byte_seconds": 20}).Expect(200)
	var p providers.Provider
	srv.Admin.Get("/api/providers/acme").Expect(200).JSON(&p)
	if p.Budget.FirstByteSeconds != 20 || p.Budget.MaxAttempts != 3 || !p.Budget.Overridden {
		t.Fatalf("budget = %+v", p.Budget)
	}
	up.Enqueue(testkit.Hang())
	go func() { done <- caller.Post(chatPath, chat("gpt-x")) }()
	up.Await(2)
	if err := srv.Clock.BlockUntil(ctx, 1); err != nil {
		t.Fatal(err)
	}
	srv.Clock.Advance(20 * time.Second)
	resp = <-done
	resp.Expect(504).JSON(&e)
	if len(e.Error.Details.Attempts) != 1 || up.Count() != 2 || !strings.Contains(e.Error.Message, "20s") {
		t.Fatalf("20 s budget = %s (upstream got %d)", resp.Body, up.Count())
	}
	for _, bad := range []map[string]any{{"first_byte_seconds": 96}, {"max_attempts": 11}, {"first_byte_seconds": -1}} {
		if e := srv.Admin.Patch("/api/providers/acme", bad).Expect(400).Err(); e.Hint == "" {
			t.Errorf("%v: no hint", bad)
		}
	}
}

func TestMaxAttemptsOverrideLimitsTheAttempts(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c")
	srv.Admin.Patch("/api/providers/acme", map[string]any{"max_attempts": 1}).Expect(200)
	caller := srv.Client(issue(t, srv, "pi", all))
	up.Default(up.Error(500, "boom"))
	var e callerError
	caller.Post(chatPath, chat("gpt-x")).Expect(502).JSON(&e)
	if len(e.Error.Details.Attempts) != 1 || up.Count() != 1 || !strings.Contains(e.Error.Details.Summary, "all 1 Attempts") {
		t.Fatalf("attempts = %+v", e.Error)
	}
	srv.Admin.Patch("/api/providers/acme", map[string]any{"max_attempts": 0}).Expect(200)
	var p providers.Provider
	srv.Admin.Get("/api/providers/acme").Expect(200).JSON(&p)
	if p.Budget.MaxAttempts != 3 || p.Budget.Overridden {
		t.Fatalf("reset budget = %+v", p.Budget)
	}
}

func TestAnEmptyPlanSaysWhetherAnythingCanEverServe(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))

	srv.Admin.Post("/api/providers/acme/keys/bulk/disable", map[string]any{"items": []string{"key-1", "key-2"}}).Expect(200)
	var e callerError
	resp := caller.Post(chatPath, chat("gpt-x")).Expect(503).JSON(&e)
	if e.Error.Code != "no_candidate" || e.Error.Details.Reason != "no_usable_key" || resp.Header.Get("Retry-After") != "" || up.Count() != 0 {
		t.Fatalf("all disabled = %s", resp.Body)
	}

	srv.Admin.Post("/api/providers/acme/keys/key-2/enable", nil).Expect(200)
	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "45"))
	caller.Post(chatPath, chat("gpt-x")).Expect(503)
	resp = caller.Post(chatPath, chat("gpt-x")).Expect(503).JSON(&e)
	if e.Error.Code != "keys_cooling" || e.Error.Details.Until != "2026-01-01T00:00:45Z" || resp.Header.Get("Retry-After") != "45" {
		t.Fatalf("cooling = %s", resp.Body)
	}
}

func TestKeysAreEnabledDisabledAndSummarisedThroughTheAPI(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c", "sk-test-d")
	caller := srv.Client(issue(t, srv, "pi", all))
	agent := srv.NewAdminToken("agent-1")

	var res providers.UpstreamKeyResult
	agent.Post("/api/providers/acme/keys/key-1/disable", nil).Expect(200).JSON(&res)
	if res.UpstreamKey.Enabled || res.UpstreamKey.State.State != "disabled" || res.UpstreamKey.State.Reason != "Disabled by agent-1." || res.AuditEntry == "" {
		t.Fatalf("disable = %+v", res)
	}
	for range 3 {
		caller.Post(chatPath, chat("gpt-x")).Expect(200)
	}
	if got := bearers(up, 0); strings.Contains(got, "a") {
		t.Fatalf("a disabled key was used: %s", got)
	}
	if ev := srv.Logs("kind=key.state&provider=acme"); len(ev) != 1 || ev[0].Attrs["state"] != "disabled" || ev[0].Attrs["upstream_key"] != "key-1" {
		t.Fatalf("key.state = %+v", ev)
	}
	srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(200)
	if k := readKey(t, srv, "key-1"); !k.Enabled || k.State.State != "active" {
		t.Fatalf("after revert = %+v", k)
	}

	var bulk audit.BulkResult[providers.UpstreamKey]
	srv.Admin.Post("/api/providers/acme/keys/bulk/disable?dry_run=true", map[string]any{"items": []string{"key-2", "key-3"}}).Expect(200).JSON(&bulk)
	if !bulk.DryRun || bulk.Succeeded != 2 || readKey(t, srv, "key-2").State.State != "active" {
		t.Fatalf("dry run = %+v", bulk)
	}
	srv.Admin.Post("/api/providers/acme/keys/bulk/disable", map[string]any{"items": []string{"key-2", "key-3", "nope"}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 2 || bulk.Failed != 1 || bulk.Items[0].Result.State.State != "disabled" {
		t.Fatalf("bulk disable = %+v", bulk)
	}

	up.Enqueue(up.Error(401, "bad key"))
	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=gpt-x", nil).Expect(200)
	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "90"))
	caller.Post(chatPath, chat("gpt-x")).Expect(503)

	var sum providers.ProviderSummary
	srv.Admin.Get("/api/providers/acme/summary").Expect(200).JSON(&sum)
	if sum.Keys != (providers.KeyCounts{Total: 4, Active: 1, Disabled: 2, Invalid: 1}) {
		t.Fatalf("counts = %+v", sum.Keys)
	}
	if len(sum.Cooling) != 1 || sum.Cooling[0].UpstreamKey != "key-4" || sum.Cooling[0].Model != "gpt-x" ||
		!sum.Cooling[0].Until.Equal(srv.Clock.Now().Add(90*time.Second)) || sum.NextUsableAt != nil {
		t.Fatalf("cooling = %+v", sum)
	}
	if sum.RecentAttempts.Attempts != 4 || sum.RecentAttempts.Failed != 1 || sum.Budget.MaxAttempts != 3 {
		t.Fatalf("recent = %+v", sum.RecentAttempts)
	}
	up.Enqueue(up.Error(402, "pay up"))
	caller.Post(chatPath, chat("gpt-y")).Expect(503)
	srv.Admin.Get("/api/providers/acme/summary").Expect(200).JSON(&sum)
	if sum.Keys.Cooling != 1 || sum.Keys.Active != 0 || sum.NextUsableAt == nil || !sum.NextUsableAt.Equal(srv.Clock.Now().Add(time.Minute)) {
		t.Fatalf("summary = %+v", sum)
	}
}

func idempotencyKeys(up *testkit.Upstream, from int) []string {
	var out []string
	for _, r := range up.Requests()[from:] {
		if r.Method != http.MethodGet {
			out = append(out, r.Header.Get("Idempotency-Key"))
		}
	}
	return out
}

func TestEveryAttemptOfARequestCarriesTheSameIdempotencyKey(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(up.Error(500, "boom"), up.Text("hello"))
	caller.Post(chatPath, chat("gpt-x")).Expect(200)
	first := idempotencyKeys(up, 0)
	if len(first) != 2 || first[0] == "" || first[0] != first[1] {
		t.Fatalf("Idempotency-Keys = %q", first)
	}

	n := up.Count()
	caller.Post(chatPath, chat("gpt-x")).Expect(200)
	if got := idempotencyKeys(up, n); len(got) != 1 || got[0] == "" || got[0] == first[0] {
		t.Fatalf("second Request's Idempotency-Key = %q (first %q)", got, first[0])
	}

	n = up.Count()
	up.Enqueue(up.Error(500, "boom"), up.Text("hello"))
	caller.WithHeader("Idempotency-Key", "caller-key-1").Post(chatPath, chat("gpt-x")).Expect(200)
	if got := idempotencyKeys(up, n); len(got) != 2 || got[0] != "caller-key-1" || got[1] != "caller-key-1" {
		t.Fatalf("Caller's Idempotency-Key = %q", got)
	}
}

func waitForReplay(t *testing.T, srv *testkit.Server, up *testkit.Upstream, send func() *testkit.Response, max time.Duration) (<-chan *testkit.Response, time.Time) {
	t.Helper()
	done := make(chan *testkit.Response, 1)
	go func() { done <- send() }()
	up.Await(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	now := srv.Clock.Now()
	if err := srv.Clock.BlockUntilDue(ctx, now.Add(max)); err != nil {
		t.Fatalf("no replay pause armed: %v", err)
	}
	return done, now
}

func notYet(t *testing.T, done <-chan *testkit.Response, up *testkit.Upstream, attempts int) {
	t.Helper()
	select {
	case r := <-done:
		t.Fatalf("answered during the pause: %d %s", r.Status, r.Body)
	case <-time.After(50 * time.Millisecond):
	}
	if up.Count() != attempts {
		t.Fatalf("upstream got %d Attempts during the pause, want %d", up.Count(), attempts)
	}
}

func TestAReplayOnTheSameKeyWaitsFirst(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))
	send := func() *testkit.Response { return caller.Post(chatPath, chat("gpt-x")) }

	up.Enqueue(up.Error(503, "overloaded"), up.Text("hello"))
	done, _ := waitForReplay(t, srv, up, send, 375*time.Millisecond)
	notYet(t, done, up, 1)
	srv.Clock.Advance(375 * time.Millisecond)
	resp := (<-done).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[1].UpstreamKey != "key-1" || up.Count() != 2 {
		t.Fatalf("request = %+v", r)
	}
	if keys := idempotencyKeys(up, 0); keys[0] == "" || keys[0] != keys[1] {
		t.Fatalf("the replay sent another Idempotency-Key: %q", keys)
	}

	up.Enqueue(up.Error(503, "overloaded").Header("Retry-After", "3"), up.Text("hello"))
	n := up.Count()
	done, _ = waitForReplay(t, srv, up, send, 3*time.Second)
	srv.Clock.Advance(2900 * time.Millisecond)
	notYet(t, done, up, n+1)
	srv.Clock.Advance(100 * time.Millisecond)
	(<-done).Expect(200)

	up.Enqueue(up.Error(503, "overloaded").Header("Retry-After", "120"))
	n = up.Count()
	var e callerError
	send().Expect(502).JSON(&e)
	if e.Error.Code != "upstream_failed" || len(e.Error.Details.Attempts) != 1 || up.Count() != n+1 {
		t.Fatalf("error = %+v (upstream got %d)", e.Error, up.Count()-n)
	}
}

func TestACallerLeavingDuringTheReplayPauseEndsTheRequest(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	key := issue(t, srv, "pi", all)

	up.Enqueue(up.Error(503, "overloaded").Header("Retry-After", "30"))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+chatPath,
		strings.NewReader(`{"model":"gpt-x","messages":[{"role":"user","content":"hi"}]}`))
	req.Header.Set("Authorization", "Bearer "+key)
	go func() {
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
		}
	}()
	up.Await(1)
	wait, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	if err := srv.Clock.BlockUntilDue(wait, srv.Clock.Now().Add(30*time.Second)); err != nil {
		t.Fatal(err)
	}
	cancel()
	r := confOnlyRequest(t, srv)
	if r.Status != 499 || r.Error == nil || r.Error.Code != "caller_gone" || len(r.Attempts) != 1 || up.Count() != 1 {
		t.Fatalf("request = %+v (upstream got %d)", r, up.Count())
	}
}

func TestKeyTestsRunSinglyAndInBulk(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c")

	if e := srv.Admin.Post("/api/providers/acme/keys/key-1/test", nil).Expect(400).Err(); e.Code != "model_required" || e.Hint == "" {
		t.Fatalf("no model: %+v", e)
	}
	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=gpt-x&dry_run=true", nil).Expect(200).JSON(&res)
	if !res.DryRun || res.Passed || up.Count() != 0 || res.Endpoint != "default" || res.Model != "gpt-x" {
		t.Fatalf("dry run = %+v", res)
	}

	responders := map[string]testkit.Responder{
		"sk-test-a": up.Text("OK"),
		"sk-test-b": up.Error(401, "revoked"),
		"sk-test-c": up.Error(429, "slow").Header("Retry-After", "120"),
	}
	up.Default(func(r *testkit.Received) testkit.Reply { return responders[r.Bearer()](r) })
	var bulk gateway.KeyTestBulk
	srv.Admin.Post("/api/providers/acme/keys/bulk/test?model=gpt-x", map[string]any{"items": []string{"key-1", "key-2", "key-3", "nope"}}).Expect(200).JSON(&bulk)
	if bulk.Passed != 1 || bulk.Failed != 3 || len(bulk.Items) != 4 {
		t.Fatalf("bulk = %+v", bulk)
	}
	it := bulk.Items
	if !it[0].OK || !it[0].Result.Passed || it[0].Result.State.State != "active" ||
		!it[1].OK || it[1].Result.Passed || it[1].Result.Rule != "unauthorized" || it[1].Result.State.State != "invalid" ||
		!it[2].OK || it[2].Result.Outcome != "cooling_key_model" || it[2].Result.Status != 429 ||
		it[3].OK || it[3].Error == nil || it[3].Error.Code != "not_found" {
		t.Fatalf("items = %+v %+v %+v %+v", it[0], it[1], it[2], it[3])
	}
	if up.Count() != 3 {
		t.Fatalf("upstream got %d tests", up.Count())
	}
	if k := readKey(t, srv, "key-3"); len(k.CoolingModels) != 1 || !k.CoolingModels[0].Until.Equal(srv.Clock.Now().Add(2*time.Minute)) {
		t.Fatalf("key-3 = %+v", k)
	}
	if ev := srv.Logs("kind=key.test&provider=acme"); len(ev) != 3 {
		t.Fatalf("key.test events = %d", len(ev))
	}
	if strings.Contains(srv.Console(), "sk-test-") {
		t.Fatal("a secret reached the logs")
	}
}
