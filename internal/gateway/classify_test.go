package gateway_test

import (
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/testkit"
)

const classifyPath = "/api/providers/acme/rules/classify"

func classify(t *testing.T, srv *testkit.Server, body map[string]any) gateway.Classification {
	t.Helper()
	var c gateway.Classification
	srv.Admin.Post(classifyPath, body).Expect(200).JSON(&c)
	return c
}

func TestClassifyNamesTheBuiltInRuleThatMatchesAndWhatItDoes(t *testing.T) {
	srv := testkit.Start(t)
	addProvider(t, srv, "acme", "https://api.example.com/v1", "sk-test-a")

	c := classify(t, srv, map[string]any{"status": 401, "body": `{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}`})
	if !c.Failure || c.Rule != "unauthorized" || c.Outcome != "invalid" || c.Status != 401 || c.KeyEffect != "Mark invalid" || c.RequestEffect != "Try next key" {
		t.Fatalf("401 = %+v", c)
	}
	if c.Reason != "401 invalid_api_key: Incorrect API key provided" {
		t.Fatalf("reason = %q", c.Reason)
	}

	c = classify(t, srv, map[string]any{"status": 429, "body": `{"error":{"type":"rate_limit_error","message":"slow down"}}`, "headers": map[string]string{"Retry-After": "30"}, "model": "gpt-x"})
	if c.Rule != "rate-limited" || c.Outcome != "cooling_key_model" || c.CoolingSeconds != 30 || c.CoolingFrom != "response" || c.KeyEffect != "Cool 30 s for gpt-x" {
		t.Fatalf("429 = %+v", c)
	}
	c = classify(t, srv, map[string]any{"status": 429, "body": "slow down"})
	if c.CoolingSeconds != 60 || c.CoolingFrom != "default" || c.KeyEffect != "Cool 60 s for the model" {
		t.Fatalf("429 without Retry-After = %+v", c)
	}
	c = classify(t, srv, map[string]any{"status": 404, "body": `{"error":{"code":"model_not_found","message":"The model gpt-x does not exist"}}`, "model": "gpt-x"})
	if c.Rule != "model-not-found" || c.Outcome != "model_gap" || c.KeyEffect != "Record Model Gap for gpt-x" {
		t.Fatalf("404 = %+v", c)
	}
	c = classify(t, srv, map[string]any{"status": 400, "body": `{"error":{"message":"bad temperature"}}`})
	if c.Rule != "bad-request" || c.Outcome != "fail_request" || c.RequestEffect != "Return to Caller" || c.KeyEffect != "No change" {
		t.Fatalf("400 = %+v", c)
	}
}

func TestClassifyUsesTheOwnersRulesAndSkipsSwitchedOffOnes(t *testing.T) {
	srv := testkit.Start(t)
	addProvider(t, srv, "acme", "https://api.example.com/v1", "sk-test-a")

	srv.Admin.Post("/api/rules", map[string]any{"name": "quota-words", "provider": "acme", "status": []string{"429"}, "body": "quota",
		"outcome": "cooling_key", "cooling_seconds": 900}).Expect(201)
	c := classify(t, srv, map[string]any{"status": 429, "body": `{"error":{"message":"Daily quota exceeded"}}`})
	if c.Rule != "quota-words" || c.Outcome != "cooling_key" || c.CoolingSeconds != 900 || c.CoolingFrom != "rule" || c.KeyEffect != "Cool 15 min" {
		t.Fatalf("owner rule = %+v", c)
	}
	srv.Admin.Put("/api/rules/unauthorized", map[string]any{"outcome": "cooling_key"}).Expect(200)
	if c := classify(t, srv, map[string]any{"status": 401, "body": "nope"}); c.Rule != "unauthorized" || c.Outcome != "cooling_key" {
		t.Fatalf("override = %+v", c)
	}

	srv.Admin.Post("/api/rules/quota-words/disable", nil).Expect(200)
	if c := classify(t, srv, map[string]any{"status": 429, "body": `{"error":{"message":"Daily quota exceeded"}}`}); c.Rule != "rate-limited" {
		t.Fatalf("after switching off = %+v", c)
	}
	srv.Admin.Post("/api/rules/bad-request/disable", nil).Expect(200)
	if c := classify(t, srv, map[string]any{"status": 418, "body": "I'm a teapot"}); !c.Failure || c.Rule != "" || c.Outcome != "fail_request" || c.Reason != "418: I'm a teapot" {
		t.Fatalf("no match = %+v", c)
	}
	srv.Admin.Post("/api/rules/network/disable", nil).Expect(200)
	if c := classify(t, srv, map[string]any{"status": 0}); c.Rule != "" || c.Outcome != "retry_elsewhere" || c.Status != 0 {
		t.Fatalf("no response, no rule = %+v", c)
	}

	entries := func() int {
		var p struct{ Entries []any }
		srv.Admin.Get("/api/audit-entries").Expect(200).JSON(&p)
		return len(p.Entries)
	}
	n := entries()
	classify(t, srv, map[string]any{"status": 401, "body": "nope"})
	if entries() != n {
		t.Fatal("trying a failure wrote an Audit Entry")
	}
	var l struct {
		Rules []struct {
			Name string
			Hits int
		}
	}
	srv.Admin.Get("/api/rules?provider=acme").Expect(200).JSON(&l)
	for _, r := range l.Rules {
		if r.Hits != 0 {
			t.Fatalf("rule %s has %d hits after trying failures", r.Name, r.Hits)
		}
	}
}

func TestClassifyReadsErrorsInside2xxAnswersAndStreamsAsAnAttemptDoes(t *testing.T) {
	srv := testkit.Start(t)
	addProvider(t, srv, "acme", "https://api.example.com/v1", "sk-test-a")

	c := classify(t, srv, map[string]any{"status": 200, "body": `{"error":{"code":429,"message":"Too many requests"}}`})
	if !c.Failure || !c.Embedded || c.Status != 429 || c.Rule != "rate-limited" || !strings.HasSuffix(c.Reason, "(sent inside a 2xx answer)") {
		t.Fatalf("error inside a 200 = %+v", c)
	}
	sse := "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n"
	c = classify(t, srv, map[string]any{"status": 200, "body": sse})
	if !c.Failure || c.Status != 529 || c.Rule != "server-error" || c.RequestEffect != "Try next key" {
		t.Fatalf("error event in a 200 stream = %+v", c)
	}
	c = classify(t, srv, map[string]any{"status": 400, "body": ": keep-alive\n\ndata: {\"error\":{\"code\":\"insufficient_quota\",\"message\":\"You exceeded your current quota\"}}\n\n"})
	if c.Rule != "insufficient-quota" || c.Outcome != "cooling_key" {
		t.Fatalf("stream body on a 400 = %+v", c)
	}
	c = classify(t, srv, map[string]any{"status": 200, "body": `{"choices":[{"message":{"content":"hi"}}]}`})
	if c.Failure || c.Rule != "" || c.RequestEffect != "Relay the answer" {
		t.Fatalf("an answer = %+v", c)
	}
}

func TestClassifySaysEmbeddedOnlyForAnErrorInsideA2xxAndReadsTranslatedAnswers(t *testing.T) {
	srv := testkit.Start(t)
	addProvider(t, srv, "acme", "https://api.z.ai/api/paas/v4", "sk-test-a")

	c := classify(t, srv, map[string]any{"status": 200, "body": `{"choices":[{"index":0,"finish_reason":"network_error","message":{"role":"assistant","content":"half"}}]}`})
	if !c.Failure || c.Embedded {
		t.Fatalf("normaliser failure = %+v", c)
	}

	page := map[string]any{"status": 200, "body": "<html><body>Sign in</body></html>"}
	if c := classify(t, srv, page); c.Failure || c.RequestEffect != "Relay the answer" {
		t.Fatalf("HTML on passthrough = %+v", c)
	}
	page["translated"] = true
	c = classify(t, srv, page)
	if !c.Failure || c.Embedded || c.Status != 502 || c.Rule != "server-error" || c.RequestEffect != "Try next key" {
		t.Fatalf("HTML on a translated path = %+v", c)
	}
	c = classify(t, srv, map[string]any{"status": 200, "body": `{"error":{"code":429,"message":"Too many requests"}}`, "translated": true})
	if !c.Failure || !c.Embedded || c.Status != 429 {
		t.Fatalf("error inside a translated 200 = %+v", c)
	}
}

func TestClassifyAppliesHostScopesAndKeylessEndpointsOfTheProvider(t *testing.T) {
	srv := testkit.Start(t)
	addProvider(t, srv, "acme", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "sk-test-a")
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "relay", "url": "https://relay.example.com/v1", "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "open", "url": "https://open.example.com/v1", "shape": "openai-chat", "auth_style": "none"}).Expect(201)

	c := classify(t, srv, map[string]any{"status": 400, "body": arrearage})
	if c.Rule != "dashscope-arrearage" || c.Host != "dashscope-intl.aliyuncs.com" || c.KeyEffect != "Cool 15 min" {
		t.Fatalf("on DashScope = %+v", c)
	}
	if c := classify(t, srv, map[string]any{"status": 400, "body": arrearage, "endpoint": "relay"}); c.Rule != "bad-request" || c.Endpoint != "relay" {
		t.Fatalf("on the relay = %+v", c)
	}
	if c := classify(t, srv, map[string]any{"status": 401, "body": "unauthorized", "endpoint": "open"}); c.Rule != "unauthorized" || c.Outcome != "retry_elsewhere" || c.KeyEffect != "No change" {
		t.Fatalf("keyless 401 = %+v", c)
	}
	srv.Admin.Post(classifyPath, map[string]any{"status": 401, "endpoint": "nowhere"}).Expect(404)
	srv.Admin.Post(classifyPath, map[string]any{"status": 42}).Expect(400)
	srv.Admin.Post("/api/providers/nobody/rules/classify", map[string]any{"status": 401}).Expect(404)
}
