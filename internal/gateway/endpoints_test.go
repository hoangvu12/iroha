package gateway_test

import (
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// credentials renders where a received request carried a credential.
func credentials(r *testkit.Received) string {
	var out []string
	for _, h := range []string{"Authorization", "X-Api-Key", "Api-Key"} {
		if v := r.Header.Get(h); v != "" {
			out = append(out, h+"="+v)
		}
	}
	if v := r.Query.Get("key"); v != "" {
		out = append(out, "?key="+v)
	}
	return strings.Join(out, " ")
}

func TestEachAuthStyleSendsTheKeyItsWayAndKeylessSendsNothing(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	cases := []struct {
		handle string
		ep     map[string]any
		key    map[string]any
		want   string
	}{
		{"bearer", map[string]any{}, map[string]any{"secret": "sk-test-1"}, "Authorization=Bearer sk-test-1"},
		{"xapikey", map[string]any{"auth_style": "x-api-key"}, map[string]any{"secret": "sk-test-2"}, "X-Api-Key=sk-test-2"},
		{"header", map[string]any{"auth_style": "header", "auth_param": "api-key"}, map[string]any{"secret": "sk-test-3"}, "Api-Key=sk-test-3"},
		{"query", map[string]any{"auth_style": "query", "auth_param": "key"}, map[string]any{"secret": "sk-test-4"}, "?key=sk-test-4"},
		{"none", map[string]any{"auth_style": "none"}, map[string]any{"name": "key-1", "secret": "sk-test-5"}, ""}, // the Endpoint also added the key "keyless" (41)
		{"keyless", map[string]any{"auth_style": "header", "auth_param": "X-Custom-Auth"}, map[string]any{"name": "free"}, ""},
	}
	for _, tc := range cases {
		srv.Admin.Post("/api/providers", map[string]any{"handle": tc.handle}).Expect(201)
		tc.ep["url"], tc.ep["shape"] = up.URL(), "openai-chat"
		tc.ep["static_headers"] = map[string]string{"X-Title": "Iroha", "OpenAI-Beta": "fixed"}
		srv.Admin.Post("/api/providers/"+tc.handle+"/endpoints", tc.ep).Expect(201)
		srv.Admin.Post("/api/providers/"+tc.handle+"/keys", tc.key).Expect(201)
	}
	// The Caller sends its Gateway Key and headers that collide with auth
	// slots and static headers.
	caller := srv.Anon.WithHeader("x-api-key", issue(t, srv, "pi", all)).
		WithHeader("X-Custom-Auth", "caller-value").WithHeader("OpenAI-Beta", "caller").WithHeader("X-Trace", "kept")
	for _, tc := range cases {
		caller.Post("/providers/"+tc.handle+"/v1/chat/completions", chat("m")).Expect(200)
		got := up.Last()
		if c := credentials(got); c != tc.want {
			t.Errorf("%s: upstream got credentials %q, want %q", tc.handle, c, tc.want)
		}
		if got.Header.Get("X-Title") != "Iroha" || got.Header.Get("OpenAI-Beta") != "fixed" || got.Header.Get("X-Trace") != "kept" || got.Path != "/v1/chat/completions" {
			t.Errorf("%s: headers %v path %s", tc.handle, got.Header, got.Path)
		}
		// A Caller header in the auth slot never passes, even when no key is sent.
		if slot := got.Header.Get("X-Custom-Auth"); (tc.handle == "keyless") != (slot == "") {
			t.Errorf("%s: X-Custom-Auth = %q", tc.handle, slot)
		}
	}

	// The key test sends the key in the Endpoint's auth style too.
	for _, tc := range cases {
		key := "key-1"
		if tc.handle == "keyless" {
			key = "free"
		}
		var res gateway.KeyTestResult
		srv.Admin.Post("/api/providers/"+tc.handle+"/keys/"+key+"/test?model=m", nil).Expect(200).JSON(&res)
		if !res.Passed {
			t.Errorf("%s: test = %+v", tc.handle, res)
		}
		if c := credentials(up.Last()); c != tc.want {
			t.Errorf("%s: key test sent credentials %q, want %q", tc.handle, c, tc.want)
		}
	}
	if strings.Contains(srv.Console(), "sk-test-") {
		t.Fatal("a secret reached the logs")
	}
}

func TestKeyTestsSpeakTheEndpointsShape(t *testing.T) {
	srv := testkit.Start(t)
	claude := testkit.NewAnthropic(t)
	gemini := testkit.NewGemini(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "claude", "url": claude.URL(), "shape": "anthropic-messages", "auth_style": "x-api-key",
		"renames": map[string]string{"sonnet": "claude-sonnet-4-5"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "gemini", "url": gemini.URL(), "shape": "gemini", "auth_style": "query", "auth_param": "key"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "claude-key", "secret": "sk-test-c", "endpoints": []string{"claude"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "any", "secret": "sk-test-g"}).Expect(201)

	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/claude-key/test?model=sonnet", nil).Expect(200).JSON(&res)
	got := claude.Last()
	if !res.Passed || res.Endpoint != "claude" || res.Model != "claude-sonnet-4-5" || got.Path != "/v1/messages" ||
		got.Header.Get("X-Api-Key") != "sk-test-c" || got.Header.Get("Authorization") != "" || got.Header.Get("Anthropic-Version") == "" || got.Model != "claude-sonnet-4-5" {
		t.Fatalf("anthropic test = %+v; upstream got %s %v %s", res, got.Path, got.Header, got.Body)
	}
	// A key restricted elsewhere cannot be tested on gemini.
	if e := srv.Admin.Post("/api/providers/acme/keys/claude-key/test?model=g&endpoint=gemini", nil).Expect(409).Err(); e.Code != "endpoint_not_allowed" || e.Hint == "" {
		t.Fatalf("restricted test: %+v", e)
	}
	srv.Admin.Post("/api/providers/acme/keys/any/test?model=gemini-2.5-flash&endpoint=gemini", nil).Expect(200).JSON(&res)
	got = gemini.Last()
	if !res.Passed || got.Path != "/v1beta/models/gemini-2.5-flash:generateContent" || got.Query.Get("key") != "sk-test-g" || credentials(got) != "?key=sk-test-g" {
		t.Fatalf("gemini test = %+v; upstream got %s?%s %v", res, got.Path, got.Query.Encode(), got.Header)
	}
}

func TestAKeylessRefusalDoesNotMakeTheKeyInvalid(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL())
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "free"}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))

	up.Enqueue(up.Error(401, "this relay needs a key"))
	var ce callerError
	caller.Post(chatPath, chat("m")).Expect(502).JSON(&ce)
	if a := ce.Error.Details.Attempts; len(a) != 1 || a[0].Outcome != "retry_elsewhere" || !strings.Contains(a[0].Reason, "no credential") {
		t.Fatalf("attempts = %+v", ce.Error.Details.Attempts)
	}
	if k := readKey(t, srv, "free"); k.State.State != "active" {
		t.Fatalf("keyless key = %+v", k.State)
	}
	up.Enqueue(up.Error(401, "this relay needs a key"))
	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/free/test?model=m", nil).Expect(200).JSON(&res)
	if res.Passed || res.Outcome != "retry_elsewhere" || res.State.State != "active" {
		t.Fatalf("keyless test = %+v", res)
	}
}

func TestARestrictedKeyIsNeverSentToOtherEndpoints(t *testing.T) {
	srv := testkit.Start(t)
	eu, us := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "eu", "url": eu.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "us", "url": us.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys/bulk", map[string]any{"items": []any{
		map[string]any{"name": "plan", "secret": "sk-test-plan", "endpoints": []string{"us"}},
		map[string]any{"name": "any", "secret": "sk-test-any"},
	}}).Expect(200)
	roundRobin(t, srv, "acme") // the assertions follow round-robin key order
	caller := srv.Client(issue(t, srv, "pi", all))

	// eu fails every time, so each Request walks every candidate it has.
	eu.Default(eu.Error(503, "down"))
	for range 4 {
		caller.Post(chatPath, chat("m")).Expect(200)
	}
	for _, r := range eu.Requests() {
		if r.Bearer() == "sk-test-plan" {
			t.Fatal("the key restricted to us reached eu")
		}
	}
	if !strings.Contains(bearers(us, 0), "plan") || eu.Count() == 0 {
		t.Fatalf("us got %s, eu got %d", bearers(us, 0), eu.Count())
	}

	// Restricted to an Endpoint of another Shape, the key serves only
	// through translation (ticket 13), and only on that Endpoint.
	claude := testkit.NewAnthropic(t)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "claude", "url": claude.URL(), "shape": "anthropic-messages"}).Expect(201)
	srv.Admin.Patch("/api/providers/acme/keys/plan", map[string]any{"endpoints": []string{"claude"}}).Expect(200)
	srv.Admin.Delete("/api/providers/acme/keys/any").Expect(200)
	before := eu.Count() + us.Count()
	resp := caller.Post(chatPath, chat("m")).Expect(200)
	if claude.Count() != 1 || claude.Last().Bearer() != "sk-test-plan" || eu.Count()+us.Count() != before {
		t.Fatalf("claude got %d, eu+us got %d more", claude.Count(), eu.Count()+us.Count()-before)
	}
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Endpoint != "claude" || r.ShapeOut != "anthropic-messages" {
		t.Fatalf("request = %+v", r)
	}
}

func TestRenamesApplyPerAttemptSoFailoverSendsTheRightWireModel(t *testing.T) {
	srv := testkit.Start(t)
	a, b := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "a", "url": a.URL(), "shape": "openai-chat",
		"renames": map[string]string{"glm-4.6": "zai-org/GLM-4.6"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "b", "url": b.URL(), "shape": "openai-chat",
		"renames": map[string]string{"glm-4.6": "glm-4.6-fp8"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-k"}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))

	a.Enqueue(a.Error(500, "overloaded"))
	resp := caller.Post(chatPath, chat("glm-4.6")).Expect(200)
	if a.Last().Model != "zai-org/GLM-4.6" || b.Last().Model != "glm-4.6-fp8" {
		t.Fatalf("a got %q, b got %q", a.Last().Model, b.Last().Model)
	}
	if m := resp.Map(); m["model"] != "glm-4.6" {
		t.Fatalf("the Caller saw model %v", m["model"])
	}
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].WireModel != "zai-org/GLM-4.6" || r.Attempts[1].WireModel != "glm-4.6-fp8" || r.WireModel != "glm-4.6-fp8" || r.Endpoint != "b" {
		t.Fatalf("request = %+v", r)
	}
}
