package failurerules_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/failurerules"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/testkit"
)

const chatPath = "/providers/acme/v1/chat/completions"

func chat() map[string]any {
	return map[string]any{"model": "qwen-max", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
}

func addProvider(t *testing.T, srv *testkit.Server, handle, url string, secrets ...string) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": handle}).Expect(201)
	srv.Admin.Post("/api/providers/"+handle+"/endpoints", map[string]any{"url": url, "shape": "openai-chat"}).Expect(201)
	for _, s := range secrets {
		srv.Admin.Post("/api/providers/"+handle+"/keys", map[string]any{"secret": s}).Expect(201)
	}
}

func caller(t *testing.T, srv *testkit.Server) *testkit.Client {
	t.Helper()
	var out struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "pi", "scope": map[string]any{"all": true}}).Expect(201).JSON(&out)
	return srv.Client(out.GatewayKey.Secret)
}

func list(t *testing.T, srv *testkit.Server, query string) failurerules.RuleList {
	t.Helper()
	var l failurerules.RuleList
	srv.Admin.Get("/api/rules" + query).Expect(200).JSON(&l)
	return l
}

func find(l failurerules.RuleList, name string) (failurerules.RuleView, bool) {
	i := slices.IndexFunc(l.Rules, func(r failurerules.RuleView) bool { return r.Name == name })
	if i < 0 {
		return failurerules.RuleView{}, false
	}
	return l.Rules[i], true
}

func ruleEntries(t *testing.T, srv *testkit.Server) []audit.Entry {
	t.Helper()
	var p audit.EntryPage
	srv.Admin.Get("/api/audit-entries?resource=failure_rule").Expect(200).JSON(&p)
	return p.Entries
}

func readRequest(t *testing.T, srv *testkit.Server, id string) requests.Request {
	t.Helper()
	var r requests.Request
	srv.Admin.Get("/api/requests/" + id).Expect(200).JSON(&r)
	return r
}

// arrearage is DashScope's answer for an account in arrears: a 400 that the
// built-in rules read as the request's fault.
func arrearage() testkit.Responder {
	return testkit.JSON(400, map[string]any{"code": "Arrearage", "message": "Access denied, please make sure your account is in good standing."})
}

func TestBuiltinRulesAreListedOverriddenByNameAndNeverDeleted(t *testing.T) {
	srv := testkit.Start(t)

	l := list(t, srv, "")
	if len(l.Rules) != len(rules.Builtin) || !l.HitsSince.Equal(testkit.Epoch.Add(-24*time.Hour)) {
		t.Fatalf("list = %+v", l)
	}
	for i, r := range l.Rules {
		if r.Source != failurerules.SourceBuiltin || !r.Enabled || r.Order != i+1 || r.Hits != 0 || r.Name != rules.Builtin[i].Name {
			t.Fatalf("rule %d = %+v", i, r)
		}
	}
	rl, _ := find(l, "rate-limited")
	br, _ := find(l, "bad-request")
	inv, _ := find(l, "unauthorized")
	if rl.KeyEffect != "Cool 60 s for the model" || rl.RequestEffect != "Try next key" ||
		br.KeyEffect != "No change" || br.RequestEffect != "Return to Caller" || inv.KeyEffect != "Mark invalid" {
		t.Fatalf("effects: %+v / %+v / %+v", rl, br, inv)
	}

	// Built-ins cannot be deleted.
	e := srv.Admin.Delete("/api/rules/rate-limited").Expect(409).Err()
	if e.Code != "builtin_rule" || !strings.Contains(e.Hint, "/api/rules/rate-limited/disable") {
		t.Fatalf("delete built-in: %+v", e)
	}
	srv.Admin.Delete("/api/rules/nope").Expect(404)
	srv.Admin.Patch("/api/rules/nope", map[string]any{"enabled": false}).Expect(404)

	// Overriding by name keeps the fields not sent.
	var over failurerules.RuleResult
	srv.Admin.Post("/api/rules", map[string]any{"name": "rate-limited", "outcome": "cooling_key", "cooling_seconds": 120}).Expect(200).JSON(&over)
	r := over.Rule
	if over.Outcome != "updated" || over.AuditEntry == "" || r.Source != failurerules.SourceOwner || r.Outcome != rules.CoolingKey ||
		!slices.Equal(r.Status, []string{"429"}) || r.KeyEffect != "Cool 2 min" || r.Overrides == nil || r.Overrides.Outcome != rules.CoolingKeyModel ||
		over.Replay != nil {
		t.Fatalf("override = %+v", over)
	}
	if !slices.Equal(over.Changes[0].Fields, []string{"cooling_seconds", "outcome"}) {
		t.Fatalf("changes = %+v", over.Changes)
	}
	var again failurerules.RuleResult
	srv.Admin.Post("/api/rules", map[string]any{"name": "rate-limited", "outcome": "cooling_key"}).Expect(200).JSON(&again)
	if again.Outcome != "unchanged" || again.AuditEntry != "" {
		t.Fatalf("repeat = %+v", again)
	}

	// A new rule is tried before the built-ins of its group; rules limited to
	// a Provider or host (the Owner's first, then the built-in quirks) before
	// global ones.
	scoped := 0
	for _, r := range rules.Builtin {
		if r.Scoped() {
			scoped++
		}
	}
	var created failurerules.RuleResult
	srv.Admin.Post("/api/rules", map[string]any{"name": "arrears", "code": []string{"Arrearage"}, "outcome": "invalid",
		"description": "DashScope: account in arrears."}).Expect(201).JSON(&created)
	if created.Outcome != "created" || created.Rule.Source != failurerules.SourceOwner || created.Rule.Overrides != nil || created.Rule.Order != scoped+1 {
		t.Fatalf("created = %+v", created)
	}
	srv.Admin.Post("/api/providers", map[string]any{"handle": "dashscope"}).Expect(201)
	srv.Admin.Post("/api/rules", map[string]any{"name": "dashscope-quota", "provider": "dashscope", "status": []string{"429"},
		"body": "Throttling.RateQuota", "outcome": "cooling_key", "reset": []string{"json:reset_at"}}).Expect(201)
	l = list(t, srv, "")
	if l.Rules[0].Name != "dashscope-quota" || l.Rules[scoped+1].Name != "arrears" || l.Rules[0].KeyEffect != "Cool until reset" || len(l.Rules) != len(rules.Builtin)+2 {
		t.Fatalf("order = %+v", l.Rules[:3])
	}
	var one failurerules.RuleView
	srv.Admin.Get("/api/rules/arrears").Expect(200).JSON(&one)
	if one.Order != scoped+2 || one.Description != "DashScope: account in arrears." {
		t.Fatalf("read = %+v", one)
	}

	// Switching a built-in off keeps it built-in; deleting an override brings the built-in back.
	var off failurerules.RuleResult
	srv.Admin.Post("/api/rules/server-error/disable", nil).Expect(200).JSON(&off)
	if off.Rule.Enabled || off.Rule.Source != failurerules.SourceBuiltin || off.Outcome != "updated" {
		t.Fatalf("disable = %+v", off)
	}
	var restored failurerules.RuleResult
	srv.Admin.Delete("/api/rules/rate-limited").Expect(200).JSON(&restored)
	if restored.Outcome != "updated" || restored.Rule.Source != failurerules.SourceBuiltin || restored.Rule.Outcome != rules.CoolingKeyModel {
		t.Fatalf("drop override = %+v", restored)
	}
	var deleted failurerules.RuleResult
	srv.Admin.Delete("/api/rules/arrears").Expect(200).JSON(&deleted)
	if deleted.Outcome != "deleted" || deleted.Rule.Name != "arrears" {
		t.Fatalf("delete = %+v", deleted)
	}
	srv.Admin.Get("/api/rules/arrears").Expect(404)

	// Every change wrote an Audit Entry, and reverting one restores the rule.
	entries := ruleEntries(t, srv)
	var actions []string
	for _, e := range entries {
		actions = append(actions, e.Action)
	}
	want := []string{"failure_rule.delete", "failure_rule.delete", "failure_rule.disable", "failure_rule.create", "failure_rule.create", "failure_rule.create"}
	if !slices.Equal(actions, want) {
		t.Fatalf("audit actions = %v", actions)
	}
	if entries[1].Summary != "Restored built-in Failure Rule rate-limited" {
		t.Fatalf("summary = %q", entries[1].Summary)
	}
	srv.Admin.Post("/api/audit-entries/"+deleted.AuditEntry+"/revert", nil).Expect(200)
	srv.Admin.Get("/api/rules/arrears").Expect(200).JSON(&one)
	if one.Outcome != rules.Invalid || !one.Enabled {
		t.Fatalf("after revert = %+v", one)
	}
	srv.Admin.Post("/api/audit-entries/"+off.AuditEntry+"/revert", nil).Expect(200)
	srv.Admin.Get("/api/rules/server-error").Expect(200).JSON(&one)
	if !one.Enabled {
		t.Fatalf("server-error after revert = %+v", one)
	}
}

func TestInvalidRulesAreRefusedWithTheReason(t *testing.T) {
	srv := testkit.Start(t)
	for _, body := range []map[string]any{
		{"name": "x", "status": []string{"429"}},                       // no outcome
		{"name": "x", "outcome": "invalid"},                            // nothing to match
		{"name": "x", "body": "(", "outcome": "invalid"},               // bad regexp
		{"name": "x", "status": []string{"6xx"}, "outcome": "invalid"}, // bad status
		{"name": "x", "status": []string{"500"}, "outcome": "retry_elsewhere", "cooling_seconds": 5},
		{"name": "x y", "status": []string{"500"}, "outcome": "retry_elsewhere"}, // bad name
	} {
		if e := srv.Admin.Post("/api/rules", body).Expect(400).Err(); e.Hint == "" || e.Message == "" {
			t.Errorf("%v: %+v", body, e)
		}
	}
	e := srv.Admin.Post("/api/rules", map[string]any{"name": "x", "provider": "nope", "status": []string{"429"}, "outcome": "cooling_key"}).Expect(404).Err()
	if !strings.Contains(e.Hint, "/api/providers") {
		t.Fatalf("unknown provider: %+v", e)
	}

	// A change of outcome away from cooling clears the cooling fields.
	srv.Admin.Post("/api/rules", map[string]any{"name": "slow", "status": []string{"429"}, "outcome": "cooling_key", "cooling_seconds": 30}).Expect(201)
	var res failurerules.RuleResult
	srv.Admin.Patch("/api/rules/slow", map[string]any{"outcome": "retry_elsewhere"}).Expect(200).JSON(&res)
	if res.Rule.Outcome != rules.RetryElsewhere || res.Rule.CoolingSeconds != 0 {
		t.Fatalf("patch = %+v", res.Rule)
	}
	// Provider IDs are stored as the handle.
	var p struct {
		Provider struct{ ID string } `json:"provider"`
	}
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201).JSON(&p)
	srv.Admin.Patch("/api/rules/slow", map[string]any{"provider": p.Provider.ID}).Expect(200).JSON(&res)
	if res.Rule.Provider != "acme" {
		t.Fatalf("provider = %q", res.Rule.Provider)
	}
}

func TestRuleChangesApplyToTheNextAttempt(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c")
	c := caller(t, srv)

	// Built-in: a 400 is the request's fault.
	up.Enqueue(arrearage())
	if e := c.Post(chatPath, chat()).Expect(400).Err(); e.Code != "upstream_rejected" {
		t.Fatalf("before the rule: %+v", e)
	}

	srv.Admin.Post("/api/rules", map[string]any{"name": "arrears", "provider": "acme", "code": []string{"Arrearage"}, "outcome": "invalid"}).Expect(201)
	up.Enqueue(arrearage(), up.Text("hello"))
	resp := c.Post(chatPath, chat()).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Rule != "arrears" || r.Attempts[0].Outcome != "invalid" {
		t.Fatalf("with the rule: %+v", r.Attempts)
	}

	off := srv.Admin.Post("/api/rules/arrears/disable", nil).Expect(200).Map()
	up.Enqueue(arrearage())
	c.Post(chatPath, chat()).Expect(400)

	// A revert is a change too.
	srv.Admin.Post("/api/audit-entries/"+off["audit_entry"].(string)+"/revert", nil).Expect(200)
	up.Enqueue(arrearage(), up.Text("hello"))
	resp = c.Post(chatPath, chat()).Expect(200)
	if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); r.Attempts[0].Rule != "arrears" {
		t.Fatalf("after revert: %+v", r.Attempts)
	}

	// Rules survive a restart.
	srv.Restart()
	var v failurerules.RuleView
	srv.Admin.Get("/api/rules/arrears").Expect(200).JSON(&v)
	if !v.Enabled || v.Hits != 2 {
		t.Fatalf("after restart = %+v", v)
	}
}

func TestDryRunReplaysRecentFailedAttemptsAndHitsAreCounted(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	addProvider(t, srv, "other", up.URL(), "sk-test-o")
	c := caller(t, srv)
	for range 3 {
		up.Enqueue(arrearage())
		c.Post(chatPath, chat()).Expect(400)
	}
	up.Enqueue(up.Error(500, "boom"), up.Error(500, "boom")) // replayed once on the same key
	c.Post(chatPath, chat()).Expect(502)
	srv.Clock.Advance(time.Minute)

	var dry failurerules.RuleResult
	srv.Admin.Post("/api/rules?dry_run=true", map[string]any{"name": "arrears", "provider": "acme", "code": []string{"arrearage"}, "outcome": "invalid"}).
		Expect(200).JSON(&dry)
	rp := dry.Replay
	if !dry.DryRun || dry.Outcome != "created" || rp == nil || rp.Attempts != 5 || rp.Changed != 3 || len(rp.Examples) != 3 {
		t.Fatalf("dry run = %+v / replay %+v", dry, rp)
	}
	counts := map[string][2]int{}
	for _, r := range rp.Rules {
		counts[r.Rule] = [2]int{r.Now, r.After}
	}
	if counts["arrears"] != [2]int{0, 3} || counts["bad-request"] != [2]int{3, 0} || counts["server-error"] != [2]int{2, 2} || rp.Rules[2].Rule != "server-error" {
		t.Fatalf("replay rules = %+v", rp.Rules)
	}
	ex := rp.Examples[0]
	if ex.Provider != "acme" || ex.Status != 400 || ex.RequestID == "" || ex.UpstreamKey != "key-1" || ex.Model != "qwen-max" ||
		ex.Now != (failurerules.ReplayDecision{Rule: "bad-request", Outcome: rules.FailRequest}) ||
		ex.After != (failurerules.ReplayDecision{Rule: "arrears", Outcome: rules.Invalid}) {
		t.Fatalf("example = %+v", ex)
	}
	// Nothing was written.
	srv.Admin.Get("/api/rules/arrears").Expect(404)
	if n := len(ruleEntries(t, srv)); n != 0 {
		t.Fatalf("audit entries after a dry run: %d", n)
	}
	// A rule limited to another Provider changes nothing here.
	var elsewhere failurerules.RuleResult
	srv.Admin.Post("/api/rules?dry_run=true", map[string]any{"name": "arrears", "provider": "other", "code": []string{"arrearage"}, "outcome": "invalid"}).
		Expect(200).JSON(&elsewhere)
	if elsewhere.Replay.Changed != 0 || elsewhere.Replay.Attempts != 5 {
		t.Fatalf("other provider replay = %+v", elsewhere.Replay)
	}
	// Disabling a rule replays too.
	var dis failurerules.RuleResult
	srv.Admin.Post("/api/rules/bad-request/disable?dry_run=true", nil).Expect(200).JSON(&dis)
	if dis.Replay.Changed != 3 || dis.Rule.Enabled || dis.Replay.Examples[0].After != (failurerules.ReplayDecision{Outcome: rules.FailRequest}) {
		t.Fatalf("disable replay = %+v", dis.Replay) // with no rule a 400 still fails the Request
	}

	// Hits: per rule, on the Provider asked for, within the window.
	srv.Admin.Post("/api/rules", map[string]any{"name": "other-quota", "provider": "other", "status": []string{"429"}, "outcome": "cooling_key"}).Expect(201)
	l := list(t, srv, "?provider=acme")
	if _, ok := find(l, "other-quota"); ok || l.Provider != "acme" {
		t.Fatalf("rules for acme include another Provider's: %+v", l.Rules[0])
	}
	br, _ := find(l, "bad-request")
	se, _ := find(l, "server-error")
	if br.Hits != 3 || se.Hits != 2 || br.LastHitAt == nil || !br.LastHitAt.Equal(testkit.Epoch) || l.Rules[0].Order != 1 {
		t.Fatalf("hits: %+v / %+v", br, se)
	}
	if l := list(t, srv, "?provider=other"); l.Rules[0].Name != "other-quota" {
		t.Fatalf("rules for other: %+v", l.Rules[0])
	}
	if br, _ := find(list(t, srv, "?since=30s"), "bad-request"); br.Hits != 0 {
		t.Fatalf("hits in the last 30 s = %d", br.Hits)
	}
	srv.Admin.Get("/api/rules?since=yesterday").Expect(400)
}
