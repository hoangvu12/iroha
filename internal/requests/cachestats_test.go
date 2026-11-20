package requests_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func chatAnswer(prompt, cached, written int) testkit.Responder {
	return testkit.JSON(200, map[string]any{
		"id": "c", "object": "chat.completion", "model": "m1",
		"choices": []any{map[string]any{"index": 0, "message": map[string]any{"role": "assistant", "content": "ok"}, "finish_reason": "stop"}},
		"usage": map[string]any{"prompt_tokens": prompt, "completion_tokens": 1,
			"prompt_tokens_details": map[string]any{"cached_tokens": cached, "cache_write_tokens": written}},
	})
}

// The cached share per Upstream Key (and Provider, model, Caller): stats
// filtered by key and Endpoint, and grouped, one row per group.
func TestStatsGroupCacheUsageByKeyProviderModelAndCaller(t *testing.T) {
	srv := testkit.Start(t)
	warm, cold := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "first", "url": warm.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "second", "url": cold.URL(), "shape": "openai-chat"}).Expect(201)
	// Each key goes to one Endpoint, so which upstream answered says which key served.
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "k1", "secret": "sk-test-1", "endpoints": []string{"first"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "k2", "secret": "sk-test-2", "endpoints": []string{"second"}}).Expect(201)
	var keys struct {
		UpstreamKeys []providers.UpstreamKey `json:"upstream_keys"`
	}
	srv.Admin.Get("/api/providers/acme/keys").Expect(200).JSON(&keys)
	ids := map[string]string{}
	for _, k := range keys.UpstreamKeys {
		ids[k.Name] = k.ID
	}

	warm.Enqueue(chatAnswer(1000, 600, 100), chatAnswer(1000, 600, 100))
	cold.Enqueue(chatAnswer(500, 0, 400), chatAnswer(500, 0, 400))
	alice, _ := keyNamed(t, srv, "alice")
	for range 4 { // round-robin: two Requests per key
		alice.Post(chatPath, `{"model":"m1","messages":[]}`).Expect(200)
	}
	insert(t, srv, "req_test1", requests.CallerTest, "", "Test", "m1", "", 200, 0)

	s := statsOf(t, srv, "")
	if s.Requests != 5 || s.CacheHits != 2 || s.Tokens.Input != 3000 || s.Tokens.CacheRead != 1200 || s.Tokens.CacheWrite != 1000 {
		t.Fatalf("stats = %+v", s)
	}
	if s.Groups != nil {
		t.Fatalf("groups without group_by: %+v", s.Groups)
	}

	for _, tc := range []struct{ q, want string }{
		{"upstream_key=k1", "k1"},
		{"upstream_key=" + ids["k2"], "k2"},
		{"endpoint=second", "k2"},
		{"provider=acme&upstream_key=k1&upstream_key=k2", ""},
	} {
		got := page(t, srv, tc.q).Requests
		want := 2
		if tc.want == "" {
			want = 4
		}
		if len(got) != want || statsOf(t, srv, tc.q).Requests != want {
			t.Fatalf("%s: %d Requests, want %d", tc.q, len(got), want)
		}
		for _, r := range got {
			if tc.want != "" && r.UpstreamKey != tc.want {
				t.Errorf("%s: Request served by %s", tc.q, r.UpstreamKey)
			}
		}
	}

	// One row per key; tests left out with caller_kind=gateway_key.
	s = statsOf(t, srv, "group_by=upstream_key&caller_kind=gateway_key")
	want := []requests.StatsGroup{
		{Provider: "acme", UpstreamKeyID: ids["k1"], UpstreamKey: "k1", Requests: 2, CacheHits: 2,
			Tokens: requests.Tokens{Input: 2000, Output: 2, CacheRead: 1200, CacheWrite: 200, Total: 2002}},
		{Provider: "acme", UpstreamKeyID: ids["k2"], UpstreamKey: "k2", Requests: 2,
			Tokens: requests.Tokens{Input: 1000, Output: 2, CacheWrite: 800, Total: 1002}},
	}
	if len(s.Groups) != 2 || s.Groups[0] != want[0] && s.Groups[0] != want[1] || s.Groups[1] != want[0] && s.Groups[1] != want[1] || s.Groups[0] == s.Groups[1] {
		t.Fatalf("groups by key = %+v\nwant %+v", s.Groups, want)
	}

	// Groups combine: Provider and model; Caller (test Requests apart).
	s = statsOf(t, srv, "group_by=provider&group_by=model&caller_kind=gateway_key")
	if len(s.Groups) != 1 || s.Groups[0].Provider != "acme" || s.Groups[0].Model != "m1" || s.Groups[0].UpstreamKey != "" || s.Groups[0].Requests != 4 || s.Groups[0].Tokens.CacheRead != 1200 {
		t.Fatalf("groups by Provider and model = %+v", s.Groups)
	}
	s = statsOf(t, srv, "group_by=caller")
	if len(s.Groups) != 2 || s.Groups[0].Caller == nil || s.Groups[0].Caller.Name != "alice" || s.Groups[0].Requests != 4 || s.Groups[0].Caller.GatewayKeyID == "" ||
		s.Groups[1].Caller == nil || *s.Groups[1].Caller != (requests.Caller{Kind: requests.CallerTest, Name: "Test"}) || s.Groups[1].Requests != 1 {
		t.Fatalf("groups by Caller = %+v", s.Groups)
	}

	if e := srv.Admin.Get("/api/requests/stats?group_by=colour").Expect(400).Err(); e.Hint == "" {
		t.Error("an unknown group_by has no hint")
	}
}

// exclude_tests=true leaves out the Requests sent from the test chat, on
// the stats and the list alike; caller_kind keeps working.
func TestExcludeTestsLeavesOutTestRequests(t *testing.T) {
	srv := testkit.Start(t)
	insert(t, srv, "req_key1", requests.CallerGatewayKey, "gk_1", "alice", "m1", "acme", 200, 0)
	insert(t, srv, "req_key2", requests.CallerGatewayKey, "gk_1", "alice", "m1", "acme", 200, 0)
	insert(t, srv, "req_test1", requests.CallerTest, "", "Test", "m1", "acme", 200, 0)
	insert(t, srv, "req_test2", requests.CallerTest, "gk_1", "Test (as alice)", "m1", "acme", 200, 0)

	for q, want := range map[string]int{
		"":                                   4,
		"exclude_tests=true":                 2,
		"exclude_tests=false":                4,
		"exclude_tests=true&group_by=caller": 2,
		"caller_kind=gateway_key":            2,
		"caller_kind=test":                   2,
	} {
		if n := statsOf(t, srv, q).Requests; n != want {
			t.Errorf("stats?%s: %d Requests, want %d", q, n, want)
		}
		if n := len(page(t, srv, q).Requests); n != want {
			t.Errorf("requests?%s: %d Requests, want %d", q, n, want)
		}
	}
	if s := statsOf(t, srv, "exclude_tests=true&group_by=caller"); len(s.Groups) != 1 || s.Groups[0].Caller.Name != "alice" {
		t.Errorf("groups = %+v", s.Groups)
	}
	if e := srv.Admin.Get("/api/requests/stats?exclude_tests=maybe").Expect(400).Err(); e.Hint == "" {
		t.Error("a bad exclude_tests has no hint")
	}
}
