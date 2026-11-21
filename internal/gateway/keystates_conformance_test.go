package gateway_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

const kscNousHost = "inference-api.nousresearch.com"

// Nous Research refuses an account without credits with this 404.
const kscNousCredits = `{"status":404,"message":"Model requires available credits. Your account balance is too low to use paid models.","code":"insufficient_credits_for_paid_model"}`

func kscNous(t *testing.T, secrets ...string) (*testkit.Server, *testkit.Upstream) {
	t.Helper()
	up := testkit.NewOpenAIChat(t)
	srv := testkit.Start(t, testkit.Options{HTTPClient: up.Client()})
	addProvider(t, srv, "acme", up.URLAt(kscNousHost), secrets...)
	return srv, up
}

func kscTest(t *testing.T, srv *testkit.Server, key, model string) gateway.KeyTestResult {
	t.Helper()
	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/"+key+"/test?model="+model, nil).Expect(200).JSON(&res)
	return res
}

func kscUntil(k providers.UpstreamKey) time.Time {
	if k.State.Until == nil {
		return time.Time{}
	}
	return *k.State.Until
}

func kscCooling(k providers.UpstreamKey) map[string]time.Time {
	out := map[string]time.Time{}
	for _, m := range k.CoolingModels {
		out[m.Model] = m.Until
	}
	return out
}

func TestANarrowerOrShorterRefusalNeverOverridesABroaderKeyState(t *testing.T) {
	srv, up := kscNous(t, "sk-test-a", "sk-test-b", "sk-test-c")
	start := srv.Clock.Now()

	up.Enqueue(up.Error(401, "revoked"))
	kscTest(t, srv, "key-1", "hermes")
	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "5"))
	if res := kscTest(t, srv, "key-1", "hermes"); !strings.Contains(res.Action, "stays invalid") {
		t.Fatalf("429 on an invalid key: %+v", res)
	}
	if k := readKey(t, srv, "key-1"); k.State.State != "invalid" || k.State.Rule != "unauthorized" || len(k.CoolingModels) != 0 {
		t.Fatalf("key-1 = %+v", k)
	}

	up.Enqueue(testkit.Raw(404, "application/json", kscNousCredits))
	kscTest(t, srv, "key-2", "hermes")
	want := start.Add(15 * time.Minute)
	if k := readKey(t, srv, "key-2"); k.State.State != "cooling" || k.State.Rule != "nous-insufficient-credits" || !kscUntil(k).Equal(want) {
		t.Fatalf("key-2 after the billing refusal = %+v", k.State)
	}
	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "5"), up.Error(402, "pay"))
	kscTest(t, srv, "key-2", "hermes")
	kscTest(t, srv, "key-2", "hermes")
	if k := readKey(t, srv, "key-2"); k.State.State != "cooling" || !kscUntil(k).Equal(want) {
		t.Fatalf("key-2 after shorter refusals = %+v", k.State)
	}

	before := readKey(t, srv, "key-2").State
	for _, m := range []string{"m-1", "m-2", "m-3"} {
		up.Enqueue(up.Error(429, "slow"))
		kscTest(t, srv, "key-2", m)
	}
	k := readKey(t, srv, "key-2")
	if k.State.State != "cooling" || !kscUntil(k).Equal(want) || k.State.Reason != before.Reason || strings.Contains(k.State.Reason, "models within") {
		t.Fatalf("escalation rewrote the key-wide cooling: %+v (before %+v)", k.State, before)
	}

	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "300"), up.Error(429, "slow").Header("Retry-After", "5"))
	kscTest(t, srv, "key-3", "hermes")
	kscTest(t, srv, "key-3", "hermes")
	if c := kscCooling(readKey(t, srv, "key-3")); !c["hermes"].Equal(start.Add(5 * time.Minute)) {
		t.Fatalf("key-3 model cooling = %v", c)
	}
}

func TestASuccessDropsItsModelFromTheEscalationCount(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "30"))
	caller.Post(chatPath, chat("m-1")).Expect(503)
	srv.Clock.Advance(time.Minute)
	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "600"))
	caller.Post(chatPath, chat("m-2")).Expect(503)
	caller.Post(chatPath, chat("m-1")).Expect(200)
	if c := kscCooling(readKey(t, srv, "key-1")); len(c) != 1 {
		t.Fatalf("after serving m-1: %v", c)
	}
	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "600"))
	caller.Post(chatPath, chat("m-3")).Expect(503)
	k := readKey(t, srv, "key-1")
	if c := kscCooling(k); k.State.State != "active" || len(c) != 2 || c["m-2"].IsZero() || c["m-3"].IsZero() {
		t.Fatalf("a cleared model counted toward escalation: %+v", k)
	}
}

func TestKeyStatesSurviveARestart(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c", "sk-test-d")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(up.ErrorCode(401, "invalid_api_key", "Incorrect API key provided"),
		up.Error(429, "slow").Header("Retry-After", "600"),
		up.Error(402, "pay up").Header("Retry-After", "900"))
	kscTestOn := func(key string) {
		srv.Admin.Post("/api/providers/acme/keys/"+key+"/test?model=gpt-x", nil).Expect(200)
	}
	kscTestOn("key-1")
	kscTestOn("key-2")
	kscTestOn("key-3")
	names := []string{"key-1", "key-2", "key-3", "key-4"}
	before := map[string]providers.UpstreamKey{}
	for _, n := range names {
		before[n] = readKey(t, srv, n)
	}
	if before["key-1"].State.State != "invalid" || len(before["key-2"].CoolingModels) != 1 || before["key-3"].State.State != "cooling" || before["key-4"].State.State != "active" {
		t.Fatalf("before = %+v", before)
	}

	srv.Restart()
	for _, n := range names {
		b, a := before[n], readKey(t, srv, n)
		if a.State.State != b.State.State || a.State.Reason != b.State.Reason || a.State.Rule != b.State.Rule ||
			!kscSameTime(a.State.Since, b.State.Since) || !kscSameTime(a.State.Until, b.State.Until) || len(a.CoolingModels) != len(b.CoolingModels) {
			t.Fatalf("%s: before %+v, after %+v", n, b.State, a.State)
		}
		for i := range a.CoolingModels {
			if a.CoolingModels[i].Model != b.CoolingModels[i].Model || !a.CoolingModels[i].Until.Equal(b.CoolingModels[i].Until) || a.CoolingModels[i].Reason != b.CoolingModels[i].Reason {
				t.Fatalf("%s cooling models: before %+v, after %+v", n, b.CoolingModels, a.CoolingModels)
			}
		}
	}
	n := up.Count()
	for range 4 {
		caller.Post(chatPath, chat("gpt-x")).Expect(200)
	}
	if got := bearers(up, n); got != "d,d,d,d" {
		t.Fatalf("keys used after the restart = %s", got)
	}
}

func kscSameTime(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == b
	}
	return a.Equal(*b)
}

func TestASuccessOnAnotherModelKeepsThatModelsCooling(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(up.Error(429, "slow").Header("Retry-After", "600"))
	caller.Post(chatPath, chat("gpt-x")).Expect(503)
	up.Enqueue(up.Error(402, "pay up"))
	caller.Post(chatPath, chat("gpt-y")).Expect(503)
	if k := readKey(t, srv, "key-1"); k.State.State != "cooling" {
		t.Fatalf("after the 402 = %+v", k.State)
	}
	srv.Clock.Advance(61 * time.Second)
	caller.Post(chatPath, chat("gpt-y")).Expect(200)
	k := readKey(t, srv, "key-1")
	if c := kscCooling(k); k.State.State != "active" || !strings.Contains(k.State.Reason, "Served") || len(c) != 1 || !c["gpt-x"].Equal(testkit.Epoch.Add(10*time.Minute)) {
		t.Fatalf("after serving gpt-y = %+v", k)
	}
	n := up.Count()
	var e callerError
	caller.Post(chatPath, chat("gpt-x")).Expect(503).JSON(&e)
	if e.Error.Code != "keys_cooling" || up.Count() != n {
		t.Fatalf("gpt-x reached the key while it cools: %+v", e.Error)
	}
}

func TestABillingCooledKeyIsNotRevivedByATestOrAModelList(t *testing.T) {
	srv, up := kscNous(t, "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(testkit.Raw(404, "application/json", kscNousCredits))
	caller.Post(chatPath, chat("hermes")).Expect(503)
	cooled := readKey(t, srv, "key-1")
	if cooled.State.State != "cooling" || cooled.State.Rule != "nous-insufficient-credits" {
		t.Fatalf("after the refusal = %+v", cooled.State)
	}

	up.Enqueue(testkit.Raw(404, "application/json", kscNousCredits))
	res := kscTest(t, srv, "key-1", "hermes")
	if res.Passed || res.Rule != "nous-insufficient-credits" || res.State.State != "cooling" {
		t.Fatalf("test = %+v", res)
	}

	up.SetModels("hermes", "hermes-paid")
	n := up.Count()
	srv.Admin.Post("/api/providers/acme/models/refresh", nil).Expect(200)
	listed := false
	for _, r := range up.Requests()[n:] {
		listed = listed || (r.Method == http.MethodGet && r.Bearer() == "sk-test-a")
	}
	if k := readKey(t, srv, "key-1"); !listed || k.State.State != "cooling" || k.State.Rule != "nous-insufficient-credits" || kscUntil(k).Before(kscUntil(cooled)) {
		t.Fatalf("after a model list read (listed %v) = %+v", listed, k.State)
	}
}

func TestAKeyTestLeavesADisabledKeyDisabled(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c")
	caller := srv.Client(issue(t, srv, "pi", all))
	srv.Admin.Post("/api/providers/acme/keys/bulk/disable", map[string]any{"items": []string{"key-1", "key-2"}}).Expect(200)

	up.Enqueue(up.Text("OK"), up.Error(401, "revoked"))
	if res := kscTest(t, srv, "key-1", "gpt-x"); !res.Passed || res.State.State != "disabled" {
		t.Fatalf("passing test = %+v", res)
	}
	if res := kscTest(t, srv, "key-2", "gpt-x"); res.Passed || res.State.State != "disabled" {
		t.Fatalf("failing test = %+v", res)
	}
	for _, n := range []string{"key-1", "key-2"} {
		if k := readKey(t, srv, n); k.Enabled || k.State.State != "disabled" || !strings.HasPrefix(k.State.Reason, "Disabled by ") {
			t.Fatalf("%s = %+v", n, k)
		}
	}
	n := up.Count()
	for range 3 {
		caller.Post(chatPath, chat("gpt-x")).Expect(200)
	}
	if got := bearers(up, n); got != "c,c,c" {
		t.Fatalf("keys used = %s", got)
	}

	srv.Admin.Post("/api/providers/acme/keys/bulk/enable", map[string]any{"items": []string{"key-1", "key-2"}}).Expect(200)
	if k1, k2 := readKey(t, srv, "key-1"), readKey(t, srv, "key-2"); k1.State.State != "active" || k2.State.State != "invalid" {
		t.Fatalf("after enabling: key-1 %+v, key-2 %+v", k1.State, k2.State)
	}
}

func TestBulkKeyTestsRunFiveAtATime(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	secrets := []string{"sk-test-1", "sk-test-2", "sk-test-3", "sk-test-4", "sk-test-5", "sk-test-6"}
	addProvider(t, srv, "acme", up.URL(), secrets...)
	release := make([]chan struct{}, len(secrets))
	for i := range release {
		release[i] = make(chan struct{})
	}
	up.Default(func(r *testkit.Received) testkit.Reply {
		rep := up.Text("OK")(r)
		rep.Wait = release[r.Seq-1]
		return rep
	})
	items := []string{"key-1", "key-2", "key-3", "key-4", "key-5", "key-6", "nope"}
	done := make(chan *testkit.Response, 1)
	go func() {
		done <- srv.Admin.Post("/api/providers/acme/keys/bulk/test?model=gpt-x", map[string]any{"items": items})
	}()

	up.Await(5)
	select {
	case <-time.After(100 * time.Millisecond):
	case <-done:
		t.Fatal("the bulk test answered while every test was held")
	}
	if up.Count() != 5 {
		t.Fatalf("%d tests ran at once, want 5", up.Count())
	}
	close(release[0])
	up.Await(6)
	for _, ch := range release[1:] {
		close(ch)
	}
	var bulk gateway.KeyTestBulk
	(<-done).Expect(200).JSON(&bulk)
	if bulk.Passed != 6 || bulk.Failed != 1 || len(bulk.Items) != 7 || bulk.Items[6].Error == nil || up.Count() != 6 {
		t.Fatalf("bulk = %+v (upstream got %d)", bulk, up.Count())
	}
}

func TestAKeyAddedDuringARequestIsNotUsedByIt(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	roundRobin(t, srv, "acme")
	caller := srv.Client(issue(t, srv, "pi", all))

	srv.SkipShortWaits(time.Second)
	hold := make(chan struct{})
	up.Enqueue(up.Error(500, "boom").HoldUntil(hold))
	done := make(chan *testkit.Response, 1)
	go func() { done <- caller.Post(chatPath, chat("gpt-x")) }()
	up.Await(1)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-b"}).Expect(201)
	close(hold)
	(<-done).Expect(200)
	if got := bearers(up, 0); got != "a,a" {
		t.Fatalf("keys tried = %s", got)
	}
	n := up.Count()
	caller.Post(chatPath, chat("gpt-x")).Expect(200)
	if got := bearers(up, n); got != "b" {
		t.Fatalf("the next Request used %s", got)
	}
}

func TestADeadEndpointFailsOverToALiveOneWithoutAReplay(t *testing.T) {
	srv := testkit.Start(t)
	dead, live := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	dead.Default(testkit.Drop())
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "dead", "url": dead.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "live", "url": live.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-a"}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))

	resp := caller.Post(chatPath, chat("gpt-x")).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Endpoint != "dead" || r.Attempts[0].Status != 0 || r.Attempts[0].Rule != "network" ||
		r.Attempts[0].Outcome != "retry_elsewhere" || r.Attempts[1].Endpoint != "live" || r.Attempts[1].Status != 200 || r.Endpoint != "live" {
		t.Fatalf("request = %+v", r)
	}
	if dead.Count() != 1 || live.Count() != 1 {
		t.Fatalf("calls: dead %d, live %d", dead.Count(), live.Count())
	}
	if k := readKey(t, srv, "key-1"); k.State.State != "active" || len(k.CoolingModels) != 0 {
		t.Fatalf("a network failure changed the key: %+v", k)
	}

	srv.SkipShortWaits(time.Second)
	live.Enqueue(live.Error(500, "boom"), live.Error(500, "boom"))
	var e callerError
	caller.Post(chatPath, chat("gpt-x")).Expect(502).JSON(&e)
	var eps []string
	for _, a := range readRequest(t, srv, e.Error.RequestID).Attempts {
		eps = append(eps, a.Endpoint)
	}
	if got := strings.Join(eps, ","); got != "dead,live,live" || dead.Count() != 2 {
		t.Fatalf("attempts on %s (dead got %d)", got, dead.Count())
	}

	down, up := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	down.Default(testkit.Drop())
	addProvider(t, srv, "down", down.URL(), "sk-test-d")
	addProvider(t, srv, "up", up.URL(), "sk-test-u")
	pool(t, srv, "p", nil, "down", "m-1", "up", "m-2")
	resp = caller.Post("/v1/chat/completions", chatBody("p")).Expect(200)
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Provider != "down" || r.Attempts[0].Rule != "network" || r.Attempts[1].Provider != "up" ||
		r.Provider != "up" || down.Count() != 1 || up.Last().Model != "m-2" {
		t.Fatalf("pool request = %+v (down got %d)", r, down.Count())
	}
}

func TestAStreamBrokenMidwayLeavesTheKeyStateAlone(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))

	stream := up.Stream("Hel", "lo")
	up.Enqueue(func(r *testkit.Received) testkit.Reply {
		rep := stream(r)
		rep.Chunks = rep.Chunks[:2]
		rep.Disconnect = true
		return rep
	})
	s := headers(t, openStream(t, caller))
	e := streamError(t, s.rest())
	if e.Error.Code != "upstream_stream_broken" {
		t.Fatalf("error = %+v", e.Error)
	}
	r := readRequest(t, srv, e.Error.RequestID)
	if len(r.Attempts) != 1 || r.Attempts[0].Rule != "" || r.Attempts[0].Outcome != "" {
		t.Fatalf("attempts = %+v", r.Attempts)
	}
	if k := readKey(t, srv, "key-1"); k.State.State != "active" || len(k.CoolingModels) != 0 || k.State.Since != nil {
		t.Fatalf("key-1 = %+v", k)
	}
	if ev := srv.Logs("kind=key.state"); len(ev) != 0 {
		t.Fatalf("key.state events = %+v", ev)
	}
}

func TestAHealthyKeyServesBeforeKeysBackFromCooling(t *testing.T) {
	srv, up := kscNous(t, "sk-test-a", "sk-test-b", "sk-test-c", "sk-test-d", "sk-test-e")
	caller := srv.Client(issue(t, srv, "pi", all))
	up.Default(func(r *testkit.Received) testkit.Reply {
		if r.Bearer() == "sk-test-e" {
			return up.Text("hi")(r)
		}
		return testkit.Raw(404, "application/json", kscNousCredits)(r)
	})
	for _, k := range []string{"key-1", "key-2", "key-3", "key-4"} {
		if res := kscTest(t, srv, k, "hermes"); res.State.State != "cooling" {
			t.Fatalf("%s test = %+v", k, res)
		}
	}
	srv.Clock.Advance(15*time.Minute + time.Second)
	if k := readKey(t, srv, "key-1"); k.State.State != "active" {
		t.Fatalf("key-1 after its cooling = %+v", k.State)
	}

	n := up.Count()
	for range 5 {
		caller.Post(chatPath, chat("hermes")).Expect(200)
	}
	if got := bearers(up, n); got != "e,e,e,e,e" {
		t.Fatalf("keys tried = %s", got)
	}

	srv.Admin.Post("/api/providers/acme/keys/key-5/disable", nil).Expect(200)
	n = up.Count()
	caller.Post(chatPath, chat("hermes")).Expect(503)
	if got := bearers(up, n); len(strings.Split(got, ",")) != 3 || strings.Contains(got, "e") {
		t.Fatalf("keys tried without the healthy key = %s", got)
	}
}
