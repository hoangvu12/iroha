package gateway_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// Ticket 41: keyless Providers end to end.

// noCredential fails when r carried any credential: an auth header of any
// style Iroha writes, the header a test named, or any query parameter.
func noCredential(t *testing.T, what string, r *testkit.Received, slots ...string) {
	t.Helper()
	if c := credentials(r); c != "" {
		t.Errorf("%s: upstream got credentials %q", what, c)
	}
	for _, h := range slots {
		if v, ok := r.Header[http.CanonicalHeaderKey(h)]; ok {
			t.Errorf("%s: upstream got %s: %q", what, h, v)
		}
	}
	if len(r.Query) != 0 {
		t.Errorf("%s: upstream got query %q", what, r.Query.Encode())
	}
}

// PRV-07, FAIL-128: a Provider whose Endpoint needs no auth serves Callers
// with no key added by hand. Adding an Endpoint with auth style none to a
// Provider holding no Upstream Keys adds one keyless key in the same Audit
// Entry, so the key has a Key State like any other; nothing upstream ever
// receives a credential, on inference, streams, key tests or discovery.
func TestAKeylessProviderServesWithNoKeyAddedByHand(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("llama-3")
	other := testkit.NewOpenAIChat(t)
	caller := srv.Client(issue(t, srv, "pi", all))

	// A Provider without keys says how to fix it, keyless included.
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "keyed", "url": other.URL(), "shape": "openai-chat"}).Expect(201)
	var ce callerError
	caller.Post(chatPath, chat("llama-3")).Expect(503).JSON(&ce)
	if ce.Error.Code != "no_candidate" || !strings.Contains(ce.Error.Hint, "keyless") {
		t.Fatalf("no key: %+v", ce.Error)
	}
	srv.Admin.Delete("/api/providers/acme/endpoints/keyed").Expect(200)

	var created providers.EndpointResult
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "local", "url": up.URL(), "shape": "openai-chat", "auth_style": "none"}).
		Expect(201).JSON(&created)
	if k := created.KeylessKey; k == nil || k.Name != "keyless" || k.Secret != "" || k.State.State != "active" {
		t.Fatalf("created = %+v", created)
	}
	if len(created.Changes) != 2 || created.Changes[1].Resource != "upstream_key" {
		t.Fatalf("one Audit Entry for the Endpoint and its key: %+v", created.Changes)
	}

	// The Caller's Gateway Key arrives as Bearer, x-api-key and ?key=; none of it passes.
	caller = caller.WithHeader("X-Api-Key", "caller-value")
	caller.Post(chatPath+"?key=caller-value", chat("llama-3")).Expect(200)
	noCredential(t, "chat", up.Last())
	stream := chat("llama-3")
	stream["stream"] = true
	caller.Post(chatPath, stream).Expect(200).Events()
	noCredential(t, "stream", up.Last())
	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/keyless/test?model=llama-3", nil).Expect(200).JSON(&res)
	if !res.Passed {
		t.Fatalf("key test = %+v", res)
	}
	noCredential(t, "key test", up.Last())
	srv.Admin.Post("/api/providers/acme/models/refresh", nil).Expect(200)
	if got := up.Last(); got.Method != http.MethodGet {
		t.Fatalf("last upstream call %s %s, want the model list", got.Method, got.Path)
	} else {
		noCredential(t, "discovery", got)
	}

	// The keyless key is a key like any other: one Key State, counted by the summary.
	var sum providers.ProviderSummary
	srv.Admin.Get("/api/providers/acme/summary").Expect(200).JSON(&sum)
	if sum.Keys.Total != 1 || sum.Keys.Active != 1 || sum.Keys.Keyless != 1 {
		t.Fatalf("summary keys = %+v", sum.Keys)
	}

	// A second keyless Endpoint adds no second key, nor does one on a
	// Provider that already holds keys.
	second := testkit.NewOpenAIChat(t)
	var again providers.EndpointResult
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "second", "url": second.URL(), "shape": "openai-chat", "auth_style": "none"}).
		Expect(201).JSON(&again)
	if again.KeylessKey != nil || len(again.Changes) != 1 {
		t.Fatalf("second Endpoint = %+v", again)
	}
	addProvider(t, srv, "paid", other.URL(), "sk-test-paid")
	var paid providers.EndpointResult
	srv.Admin.Post("/api/providers/paid/endpoints", map[string]any{"name": "free", "url": second.URL(), "shape": "openai-chat", "auth_style": "none"}).
		Expect(201).JSON(&paid)
	if paid.KeylessKey != nil {
		t.Fatalf("a Provider with keys got a keyless key: %+v", paid)
	}

	// Switching an Endpoint to none by PATCH does the same, and one revert
	// takes the Endpoint change and the key back.
	srv.Admin.Post("/api/providers", map[string]any{"handle": "relay"}).Expect(201)
	srv.Admin.Post("/api/providers/relay/endpoints", map[string]any{"name": "r", "url": up.URL(), "shape": "openai-chat"}).Expect(201)
	var patched providers.EndpointResult
	srv.Admin.Patch("/api/providers/relay/endpoints/r", map[string]any{"auth_style": "none"}).Expect(200).JSON(&patched)
	if patched.KeylessKey == nil || patched.KeylessKey.Name != "keyless" {
		t.Fatalf("patched = %+v", patched)
	}
	caller.Post("/providers/relay/v1/chat/completions", chat("llama-3")).Expect(200)
	noCredential(t, "relay", up.Last())
	srv.Admin.Post("/api/audit-entries/"+patched.AuditEntry+"/revert", nil).Expect(200)
	var kl providers.UpstreamKeyList
	srv.Admin.Get("/api/providers/relay/keys").Expect(200).JSON(&kl)
	if len(kl.UpstreamKeys) != 0 {
		t.Fatalf("after revert relay keeps %+v", kl.UpstreamKeys)
	}

	// A dry run says what would happen and writes nothing.
	var dry providers.EndpointResult
	srv.Admin.Patch("/api/providers/relay/endpoints/r?dry_run=true", map[string]any{"auth_style": "none"}).Expect(200).JSON(&dry)
	srv.Admin.Get("/api/providers/relay/keys").Expect(200).JSON(&kl)
	if dry.KeylessKey == nil || len(kl.UpstreamKeys) != 0 {
		t.Fatalf("dry run = %+v, keys %+v", dry, kl.UpstreamKeys)
	}
	if strings.Contains(srv.Console(), "caller-value") {
		t.Fatal("the Caller's credential reached the logs")
	}
}

// REQ-15, PRV-07: a key with no secret sends nothing in every auth style,
// on Attempts and key tests, and drops a Caller header in the auth slot.
func TestAKeylessKeySendsNothingInEveryAuthStyle(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	styles := []map[string]any{
		{"auth_style": "bearer"},
		{"auth_style": "x-api-key"},
		{"auth_style": "header", "auth_param": "Api-Key"},
		{"auth_style": "query", "auth_param": "key"},
		{"auth_style": "none"},
	}
	handles := []string{"bearer", "xapikey", "header", "query", "none"}
	for i, ep := range styles {
		h := handles[i]
		srv.Admin.Post("/api/providers", map[string]any{"handle": h}).Expect(201)
		// The hand-made key comes first, so auth style none adds no twin.
		srv.Admin.Post("/api/providers/"+h+"/keys", map[string]any{"name": "free"}).Expect(201)
		ep["name"], ep["url"], ep["shape"] = "main", up.URL(), "openai-chat"
		srv.Admin.Post("/api/providers/"+h+"/endpoints", ep).Expect(201)
	}
	caller := srv.Client(issue(t, srv, "pi", all)).WithHeader("Api-Key", "caller-value")
	for _, h := range handles {
		caller.Post("/providers/"+h+"/v1/chat/completions", chat("m")).Expect(200)
		noCredential(t, h, up.Last(), "Api-Key")
		var res gateway.KeyTestResult
		srv.Admin.Post("/api/providers/"+h+"/keys/free/test?model=m", nil).Expect(200).JSON(&res)
		if !res.Passed {
			t.Errorf("%s: key test = %+v", h, res)
		}
		noCredential(t, h+" key test", up.Last(), "Api-Key")
		var keys providers.UpstreamKeyList
		srv.Admin.Get("/api/providers/" + h + "/keys").Expect(200).JSON(&keys)
		if len(keys.UpstreamKeys) != 1 {
			t.Errorf("%s: keys %+v (a hand-made keyless key must not get a twin)", h, keys.UpstreamKeys)
		}
	}
}

// PRV-47: a static header with an empty value is never sent, and removes a
// Caller header of that name; a header the Endpoint does not name passes.
// So a keyless Endpoint can blank a header without sending "Name: ".
func TestAnEmptyStaticHeaderIsNotSent(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	up.SetModels("m")
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat", "auth_style": "none",
		"static_headers": map[string]string{"Authorization": "", "X-Blank": "", "X-Set": "v"}}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all)).WithHeader("X-Blank", "caller").WithHeader("X-Other", "kept")

	caller.Post(chatPath, chat("m")).Expect(200)
	got := up.Last()
	noCredential(t, "chat", got, "X-Blank", "Authorization")
	if got.Header.Get("X-Set") != "v" || got.Header.Get("X-Other") != "kept" {
		t.Fatalf("headers %v", got.Header)
	}
	srv.Admin.Post("/api/providers/acme/keys/keyless/test?model=m", nil).Expect(200)
	noCredential(t, "key test", up.Last(), "X-Blank", "Authorization")
	srv.Admin.Post("/api/providers/acme/models/refresh", nil).Expect(200)
	noCredential(t, "discovery", up.Last(), "X-Blank", "Authorization")
	if up.Last().Header.Get("X-Set") != "v" {
		t.Fatalf("discovery headers %v", up.Last().Header)
	}
}

// The route preview plans the keyless key like live traffic does, and says
// no_upstream_key while a Provider has no key at all.
func TestTheRoutePreviewShowsTheKeylessKey(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "local"}).Expect(201)
	srv.Admin.Post("/api/providers/local/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat"}).Expect(201)

	var pv gateway.RoutePreview
	srv.Admin.Get("/api/route-preview?model=local/m").Expect(200).JSON(&pv)
	if pv.Ready != 0 || pv.Members[0].Empty == nil || pv.Members[0].Empty.Code != "no_upstream_key" {
		t.Fatalf("preview without keys = %+v", pv)
	}
	srv.Admin.Patch("/api/providers/local/endpoints/default", map[string]any{"auth_style": "none"}).Expect(200)
	pv = gateway.RoutePreview{} // decoding into the old value would keep its pointers
	srv.Admin.Get("/api/route-preview?model=local/m").Expect(200).JSON(&pv)
	if pv.Ready != 1 || pv.Outcome != nil || pv.Members[0].Candidates[0].UpstreamKey != "keyless" || pv.Members[0].Keys != 1 {
		t.Fatalf("preview with the keyless key = %+v", pv)
	}
}

// The test chat (ticket 23) reaches a keyless Provider with no credential,
// unpinned and pinned to the keyless key.
func TestTheTestChatReachesAKeylessProviderWithNoCredential(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "local"}).Expect(201)
	srv.Admin.Post("/api/providers/local/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat", "auth_style": "none"}).Expect(201)
	for _, body := range []map[string]any{
		{"model": "local/llama-3", "stream": false},
		{"model": "local/llama-3", "upstream_key": "keyless"},
	} {
		srv.Admin.Post("/api/test", body).Expect(200)
		noCredential(t, "test chat", up.Last())
	}
}

// A Model Pool with a keyless member serves from it with no credential, and
// a refusal there (the relay wanted a key after all) moves on to the next
// member without marking the keyless key invalid.
func TestAPoolWithAKeylessMember(t *testing.T) {
	srv := testkit.Start(t)
	free, paid := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "free"}).Expect(201)
	srv.Admin.Post("/api/providers/free/endpoints", map[string]any{"url": free.URL(), "shape": "openai-chat", "auth_style": "none"}).Expect(201)
	addProvider(t, srv, "paid", paid.URL(), "sk-test-paid")
	pool(t, srv, "llama", nil, "free", "llama-3", "paid", "meta/llama-3")
	caller := srv.Client(issue(t, srv, "pi", all))

	caller.Post("/v1/chat/completions", chat("llama")).Expect(200)
	if free.Count() != 1 || paid.Count() != 0 {
		t.Fatalf("calls: free %d, paid %d", free.Count(), paid.Count())
	}
	noCredential(t, "pool member", free.Last())

	free.Enqueue(free.Error(401, "this relay needs a key now"))
	resp := caller.Post("/v1/chat/completions", chat("llama")).Expect(200)
	if paid.Count() != 1 || paid.Last().Bearer() != "sk-test-paid" {
		t.Fatalf("paid got %d calls, bearer %q", paid.Count(), paid.Last().Bearer())
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Outcome != "retry_elsewhere" || r.Provider != "paid" {
		t.Fatalf("request = %+v", r)
	}
	var k providers.UpstreamKey
	srv.Admin.Get("/api/providers/free/keys/keyless").Expect(200).JSON(&k)
	if k.State.State != "active" {
		t.Fatalf("keyless key = %+v", k.State)
	}
}
