package gateway_test

import (
	"fmt"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestTheRoutePreviewMatchesWhatTheNextRequestDoes(t *testing.T) {
	t.Run("round-robin", func(t *testing.T) { previewMatchesNextRequest(t, "") })
	t.Run("a conversation", func(t *testing.T) { previewMatchesNextRequest(t, "sess-7") })
}

func previewMatchesNextRequest(t *testing.T, session string) {
	srv := testkit.Start(t)
	zai, chutes := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	addProvider(t, srv, "zai", zai.URL(), "sk-test-z1", "sk-test-z2", "sk-test-z3")
	addProvider(t, srv, "chutes", chutes.URL(), "sk-test-c1", "sk-test-c2")
	pool(t, srv, "glm-4.6", map[string]any{"budget": map[string]any{"max_attempts": 10}}, "zai", "glm-4.6", "chutes", "zai-org/GLM-4.6")
	caller := srv.Client(issue(t, srv, "pi", all))
	ups := map[string]*testkit.Upstream{"zai": zai, "chutes": chutes}

	type hop struct{ provider, key, model string }
	preview := func(model string) []hop {
		t.Helper()
		var pv gateway.RoutePreview
		q := ""
		if session != "" {
			q = "&as=pi&affinity=" + session
		}
		srv.Admin.Get("/api/route-preview?model=" + model + q).Expect(200).JSON(&pv)
		var out []hop
		for _, m := range pv.Members {
			for _, c := range m.Candidates {
				out = append(out, hop{m.Provider, c.UpstreamKey, c.WireModel})
			}
		}
		return out
	}
	send := func(model string, want []hop, fail int, refuse func(u *testkit.Upstream) testkit.Responder) []hop {
		t.Helper()
		for i := 0; i < fail && i < len(want); i++ {
			ups[want[i].provider].Enqueue(refuse(ups[want[i].provider]))
		}
		body := map[string]any{"model": model, "messages": []any{}}
		c := caller
		if session != "" {
			body, c = chatBody(model), caller.WithHeader("Iroha-Session", session)
		}
		resp := c.Post("/v1/chat/completions", body)
		r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
		var out []hop
		for _, a := range r.Attempts {
			out = append(out, hop{a.Provider, a.UpstreamKey, a.WireModel})
		}
		return out
	}
	check := func(round string, plan, got []hop) {
		t.Helper()
		if len(got) == 0 || len(got) > len(plan) {
			t.Fatalf("%s: preview %v, Attempts %v", round, plan, got)
		}
		for i := range got {
			if got[i] != plan[i] {
				t.Fatalf("%s: Attempt %d went to %v, the preview said %v (preview %v, Attempts %v)", round, i+1, got[i], plan[i], plan, got)
			}
		}
	}

	retry := func(u *testkit.Upstream) testkit.Responder { return u.Error(500, "boom") }
	for round := 1; round <= 6; round++ {
		plan := preview("glm-4.6")
		check(fmt.Sprintf("round %d", round), plan, send("glm-4.6", plan, round%3, retry))
	}

	plan := preview("glm-4.6")
	cool := func(u *testkit.Upstream) testkit.Responder {
		return u.Error(429, "slow down").Header("Retry-After", "60")
	}
	check("cooling", plan, send("glm-4.6", plan, 1, cool))
	plan = preview("glm-4.6")
	gap := func(u *testkit.Upstream) testkit.Responder {
		return u.ErrorCode(404, "model_not_found", "The model glm-4.6 does not exist")
	}
	check("model gap", plan, send("glm-4.6", plan, 1, gap))
	srv.Admin.Post("/api/providers/zai/keys/"+plan[0].key+"/disable", nil).OK()

	for round := 1; round <= 3; round++ {
		plan = preview("glm-4.6")
		if len(plan) != 3 || plan[0].provider != "zai" {
			t.Fatalf("plan after disable = %v", plan)
		}
		check(fmt.Sprintf("after disable %d", round), plan, send("glm-4.6", plan, 1, retry))
	}

	for round := 1; round <= 3; round++ {
		plan = preview("chutes/zai-org/GLM-4.6")
		check(fmt.Sprintf("provider route %d", round), plan, send("chutes/zai-org/GLM-4.6", plan, 1, retry))
	}

	srv.Clock.Advance(2 * time.Minute)
	plan = preview("glm-4.6")
	check("after cooling", plan, send("glm-4.6", plan, 0, retry))
}
