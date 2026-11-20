package gateway_test

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// turn is turn n (from 1) of a coding-agent conversation: the same system
// prompt, tools and first user message, then the history so far.
func turn(convo string, n int) map[string]any {
	msgs := []any{
		map[string]any{"role": "system", "content": "You are a coding agent."},
		map[string]any{"role": "user", "content": "Task " + convo + ": fix the failing test"},
	}
	for i := 1; i < n; i++ {
		msgs = append(msgs, map[string]any{"role": "assistant", "content": fmt.Sprintf("step %d done", i)},
			map[string]any{"role": "user", "content": "continue"})
	}
	return map[string]any{"model": "gpt-x", "messages": msgs,
		"tools": []any{map[string]any{"type": "function", "function": map[string]any{"name": "read_file"}}}}
}

func sixKeys(t *testing.T, srv *testkit.Server, up *testkit.Upstream) {
	t.Helper()
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c", "sk-test-d", "sk-test-e", "sk-test-f")
}

func lastKey(up *testkit.Upstream) string { return strings.TrimPrefix(up.Last().Bearer(), "sk-test-") }

func affinityOf(t *testing.T, srv *testkit.Server, resp *testkit.Response) requests.Affinity {
	t.Helper()
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if r.Affinity == nil {
		t.Fatalf("request %s records no affinity", r.ID)
	}
	return *r.Affinity
}

// Every turn of a conversation goes to one key, found from the prompt's
// start when the Caller sends no session; each conversation has its own.
func TestTurnsOfAConversationLandOnOneKey(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	sixKeys(t, srv, up)
	caller := srv.Client(issue(t, srv, "pi", all))

	firsts := map[string]bool{}
	for c := range 8 {
		convo := fmt.Sprintf("c%d", c)
		var key string
		for n := 1; n <= 4; n++ {
			resp := caller.Post(chatPath, turn(convo, n)).Expect(200)
			if n == 1 {
				key = lastKey(up)
			} else if got := lastKey(up); got != key {
				t.Fatalf("%s turn %d went to key %s, turn 1 to %s", convo, n, got, key)
			}
			if a := affinityOf(t, srv, resp); a.Source != "prefix" || a.Mode != "on" || a.PreferredServed == nil || !*a.PreferredServed {
				t.Fatalf("%s turn %d affinity = %+v", convo, n, a)
			}
		}
		firsts[key] = true
	}
	if len(firsts) < 3 {
		t.Fatalf("8 conversations shared %d keys", len(firsts))
	}
}

// A key that cools moves its conversation to one second key, the same on
// every turn; the conversation comes back once the key works again. The
// Iroha-Session header names the conversation and is never forwarded.
func TestACooledKeyMovesTheConversationToTheSameSecondKey(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	sixKeys(t, srv, up)
	caller := srv.Client(issue(t, srv, "pi", all)).WithHeader("Iroha-Session", "sess-42")

	resp := caller.Post(chatPath, chatBody("gpt-x")).Expect(200)
	first := lastKey(up)
	if up.Last().Header.Get("Iroha-Session") != "" {
		t.Fatal("Iroha-Session was forwarded")
	}
	if a := affinityOf(t, srv, resp); a.Source != "header" || a.Mode != "on" {
		t.Fatalf("affinity = %+v", a)
	}

	up.Enqueue(up.Error(429, "slow down").Header("Retry-After", "60"))
	resp = caller.Post(chatPath, chatBody("gpt-x")).Expect(200)
	second := lastKey(up)
	if second == first {
		t.Fatal("the cooled key served")
	}
	if a := affinityOf(t, srv, resp); a.PreferredServed == nil || *a.PreferredServed {
		t.Fatalf("the preferred key failed, yet affinity = %+v", a)
	}
	for range 4 {
		resp = caller.Post(chatPath, chatBody("gpt-x")).Expect(200)
		if got := lastKey(up); got != second {
			t.Fatalf("while %s cools the conversation went to %s, not %s", first, got, second)
		}
		if a := affinityOf(t, srv, resp); a.PreferredServed == nil || !*a.PreferredServed {
			t.Fatalf("the second key is now the one affinity puts first, yet affinity = %+v", a)
		}
	}

	// Cooling over: the key is back once it works again (here a key test).
	srv.Clock.Advance(2 * time.Minute)
	var keys struct {
		Keys []struct{ Name, Secret string } `json:"upstream_keys"`
	}
	srv.Admin.Get("/api/providers/acme/keys").Expect(200).JSON(&keys)
	for _, k := range keys.Keys {
		if k.Secret == "sk-test-"+first {
			srv.Admin.Post("/api/providers/acme/keys/"+k.Name+"/test?model=gpt-x", nil).Expect(200)
		}
	}
	caller.Post(chatPath, chatBody("gpt-x")).Expect(200)
	if got := lastKey(up); got != first {
		t.Fatalf("after the key recovered the conversation went to %s, not back to %s", got, first)
	}
}

// Two Callers sending the same session ID are two conversations.
func TestCallersSendingTheSameSessionDoNotShareIt(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	sixKeys(t, srv, up)
	a := srv.Client(issue(t, srv, "a", all))
	b := srv.Client(issue(t, srv, "b", all))
	differ := 0
	for i := range 10 {
		s := fmt.Sprintf("shared-%d", i)
		a.WithHeader("Iroha-Session", s).Post(chatPath, chatBody("gpt-x")).Expect(200)
		ka := lastKey(up)
		b.WithHeader("Iroha-Session", s).Post(chatPath, chatBody("gpt-x")).Expect(200)
		if lastKey(up) != ka {
			differ++
		}
	}
	if differ == 0 {
		t.Fatal("two Callers' sessions with the same ID always landed on the same key")
	}
}

// With affinity off the Provider's keys round-robin, conversation or not.
func TestAffinityOffKeepsRoundRobin(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c")
	var p struct {
		Provider struct{ Affinity string } `json:"provider"`
	}
	srv.Admin.Patch("/api/providers/acme", map[string]any{"affinity": "off"}).Expect(200).JSON(&p)
	if p.Provider.Affinity != "off" {
		t.Fatalf("affinity = %q", p.Provider.Affinity)
	}
	caller := srv.Client(issue(t, srv, "pi", all))
	var got []string
	var resp *testkit.Response
	for n := 1; n <= 6; n++ {
		resp = caller.Post(chatPath, turn("c", n)).Expect(200)
		got = append(got, lastKey(up))
	}
	if strings.Join(got, "") != "abcabc" {
		t.Fatalf("keys = %v", got)
	}
	if a := affinityOf(t, srv, resp); a.Source != "prefix" || a.Mode != "off" || a.PreferredServed != nil {
		t.Fatalf("affinity = %+v", a)
	}
	// A new Provider has it on.
	srv.Admin.Post("/api/providers", map[string]any{"handle": "fresh"}).Expect(201).JSON(&p)
	if p.Provider.Affinity != "on" {
		t.Fatalf("a new Provider has affinity %q", p.Provider.Affinity)
	}
}

// In a Pool mixing Providers with affinity on and off, the Request records
// the mode of the Provider whose key served it, so round-robin traffic is
// never filed as affinity on; when nothing serves, the last Attempt's.
func TestAPoolRecordsTheAffinityOfTheProviderThatServed(t *testing.T) {
	srv := testkit.Start(t)
	zai, chutes := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	addProvider(t, srv, "zai", zai.URL(), "sk-test-z")
	addProvider(t, srv, "chutes", chutes.URL(), "sk-test-c")
	roundRobin(t, srv, "zai")
	pool(t, srv, "glm", nil, "zai", "glm-4.6", "chutes", "glm-4.6")
	caller := srv.Client(issue(t, srv, "pi", all)).WithHeader("Iroha-Session", "s-1")

	if a := affinityOf(t, srv, caller.Post("/v1/chat/completions", chatBody("glm")).Expect(200)); a.Mode != "off" || a.PreferredServed != nil {
		t.Fatalf("zai (affinity off) served, yet affinity = %+v", a)
	}
	zai.Enqueue(zai.Error(429, "slow down"))
	if a := affinityOf(t, srv, caller.Post("/v1/chat/completions", chatBody("glm")).Expect(200)); a.Mode != "on" {
		t.Fatalf("chutes (affinity on) served, yet affinity = %+v", a)
	}

	// Nothing serves: the last Attempt's Provider decides.
	srv.Clock.Advance(2 * time.Minute)
	pool(t, srv, "glm", nil, "chutes", "glm-4.6", "zai", "glm-4.6")
	chutes.Enqueue(chutes.Error(429, "slow down"))
	zai.Enqueue(zai.Error(429, "slow down"))
	if a := affinityOf(t, srv, caller.Post("/v1/chat/completions", chatBody("glm")).Expect(503)); a.Mode != "off" || a.PreferredServed != nil {
		t.Fatalf("the last Attempt was zai's, yet affinity = %+v", a)
	}
}

// preferred_served says the key affinity put first gave the Caller a
// successful answer: a redirect it answered with is not one.
func TestPreferredServedNeedsASuccess(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	sixKeys(t, srv, up)
	caller := srv.Client(issue(t, srv, "pi", all)).WithHeader("Iroha-Session", "s-1")
	up.Enqueue(testkit.Raw(302, "text/plain", "moved").Header("Location", "https://elsewhere.example/v1"))
	if a := affinityOf(t, srv, caller.Post(chatPath, chatBody("gpt-x")).Expect(502)); a.Mode != "on" || a.PreferredServed == nil || *a.PreferredServed {
		t.Fatalf("the preferred key answered a redirect, yet affinity = %+v", a)
	}
	if a := affinityOf(t, srv, caller.Post(chatPath, chatBody("gpt-x")).Expect(200)); a.PreferredServed == nil || !*a.PreferredServed {
		t.Fatalf("affinity = %+v", a)
	}
}

// With the experiment at half, about half the conversations round-robin
// (mode control) and half keep their key (mode on); the Requests stats
// filter tells the halves apart.
func TestTheExperimentSplitsConversationsAndStatsFilterThem(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	sixKeys(t, srv, up)
	srv.Admin.Put("/api/settings/affinity.experiment", map[string]any{"value": "half"}).Expect(200)
	caller := srv.Client(issue(t, srv, "pi", all))
	for i := range 40 {
		caller.WithHeader("Iroha-Session", fmt.Sprintf("s%d", i)).Post(chatPath, chatBody("gpt-x")).Expect(200)
	}
	caller.Post(chatPath, map[string]any{"model": "gpt-x", "messages": []any{}}).Expect(200)
	count := func(q string) int {
		var s requests.Stats
		srv.Admin.Get("/api/requests/stats?" + q).Expect(200).JSON(&s)
		return s.Requests
	}
	on, control, none := count("affinity=on"), count("affinity=control"), count("affinity=none")
	if on+control != 40 || on < 5 || control < 5 || none != 1 {
		t.Fatalf("on %d, control %d, none %d", on, control, none)
	}
	if n := count("affinity_source=header"); n != 40 {
		t.Fatalf("affinity_source=header matched %d", n)
	}
	srv.Admin.Get("/api/requests/stats?affinity=sometimes").Expect(400)
	srv.Admin.Put("/api/settings/affinity.experiment", map[string]any{"value": "most"}).Expect(400)
}

// The route preview takes a conversation: the order it shows is the one
// that conversation's next Request gets.
func TestTheRoutePreviewShowsAConversationsOrder(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	sixKeys(t, srv, up)
	caller := srv.Client(issue(t, srv, "pi", all))
	for i := range 6 {
		s := fmt.Sprintf("s%d", i)
		var pv gateway.RoutePreview
		srv.Admin.Get("/api/route-preview?model=acme/gpt-x&as=pi&affinity=" + s).Expect(200).JSON(&pv)
		if len(pv.Members) != 1 || pv.Members[0].KeyOrder != "affinity" || len(pv.Members[0].Candidates) != 6 {
			t.Fatalf("preview = %+v", pv)
		}
		caller.WithHeader("Iroha-Session", s).Post("/v1/chat/completions", chatBody("acme/gpt-x")).Expect(200)
		if got := lastKey(up); "sk-test-"+got != secretOf(t, srv, pv.Members[0].Candidates[0].UpstreamKey) {
			t.Fatalf("%s: preview put %s first, the Request used %s", s, pv.Members[0].Candidates[0].UpstreamKey, got)
		}
	}
}

func secretOf(t *testing.T, srv *testkit.Server, key string) string {
	t.Helper()
	var k struct{ Secret string }
	srv.Admin.Get("/api/providers/acme/keys/" + key).Expect(200).JSON(&k)
	return k.Secret
}

// roundRobin switches affinity off on Provider handle, for tests whose
// assertions follow the round-robin key order.
func roundRobin(t *testing.T, srv *testkit.Server, handle string) {
	t.Helper()
	srv.Admin.Patch("/api/providers/"+handle, map[string]any{"affinity": "off"}).Expect(200)
}
