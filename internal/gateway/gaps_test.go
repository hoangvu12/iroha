package gateway_test

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// entitlements makes up refuse some models to some keys the way providers
// do (404 model_not_found), and serve everything else.
type entitlements struct {
	mu      sync.Mutex
	refused map[string]bool // "<bearer> <model>"
}

func refuse(t *testing.T, up *testkit.Upstream, pairs ...string) *entitlements {
	t.Helper()
	e := &entitlements{refused: map[string]bool{}}
	for _, p := range pairs {
		e.refused[p] = true
	}
	up.Default(func(r *testkit.Received) testkit.Reply {
		e.mu.Lock()
		no := e.refused[r.Bearer()+" "+r.Model]
		e.mu.Unlock()
		if no {
			return up.ErrorCode(404, "model_not_found", "The model "+r.Model+" does not exist or you do not have access to it.")(r)
		}
		return up.Text("hi")(r)
	})
	return e
}

func (e *entitlements) allow(pair string) {
	e.mu.Lock()
	delete(e.refused, pair)
	e.mu.Unlock()
}

func gapsOf(k providers.UpstreamKey) string {
	var out []string
	for _, g := range k.ModelGaps {
		out = append(out, g.Model)
	}
	return strings.Join(out, ",")
}

func TestARefusedModelCreatesAModelGapAndTheKeyKeepsServingOtherModels(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))
	refuse(t, up, "sk-test-a gpt-x")

	// key-1 is refused gpt-x; key-2 serves it in the same Request.
	resp := caller.Post(chatPath, chat("gpt-x")).Expect(200)
	if got := bearers(up, 0); got != "a,b" {
		t.Fatalf("keys tried = %s", got)
	}
	id := resp.Header.Get("X-Request-Id")
	r := readRequest(t, srv, id)
	if r.Attempts[0].Outcome != "model_gap" || r.Attempts[0].Rule != "model-not-found" || !strings.Contains(r.Attempts[0].Action, "Model Gap for gpt-x until 2026-01-02T00:00:00Z") {
		t.Fatalf("attempt 1 = %+v", r.Attempts[0])
	}

	// The key stays active; the gap is on the key with its reason and expiry.
	k1 := readKey(t, srv, "key-1")
	if k1.State.State != "active" || len(k1.ModelGaps) != 1 {
		t.Fatalf("key-1 = %+v", k1)
	}
	g := k1.ModelGaps[0]
	if g.Model != "gpt-x" || g.Rule != "model-not-found" || g.RequestID != id || !strings.Contains(g.Reason, "does not exist") ||
		!g.CreatedAt.Equal(testkit.Epoch) || !g.ExpiresAt.Equal(testkit.Epoch.Add(24*time.Hour)) {
		t.Fatalf("gap = %+v", g)
	}
	ev := srv.Logs("kind=model_gap&request_id=" + id)
	if len(ev) != 1 || ev[0].Provider != "acme" || ev[0].Attrs["op"] != "created" || ev[0].Attrs["upstream_key"] != "key-1" ||
		ev[0].Attrs["model"] != "gpt-x" || ev[0].Attrs["until"] != "2026-01-02T00:00:00Z" {
		t.Fatalf("model_gap events = %+v", ev)
	}
	if ev := srv.Logs("kind=key.state&provider=acme"); len(ev) != 0 {
		t.Fatalf("a Model Gap changed a Key State: %+v", ev)
	}

	// Visible per Provider: the list and the summary.
	var list providers.GapList
	srv.Admin.Get("/api/providers/acme/model-gaps").Expect(200).JSON(&list)
	if len(list.ModelGaps) != 1 || list.ModelGaps[0].UpstreamKey != "key-1" || list.ModelGaps[0].Model != "gpt-x" {
		t.Fatalf("list = %+v", list)
	}
	srv.Admin.Get("/api/providers/acme/model-gaps?upstream_key=key-2").Expect(200).JSON(&list)
	if len(list.ModelGaps) != 0 {
		t.Fatalf("key-2's list = %+v", list)
	}
	var sum providers.ProviderSummary
	srv.Admin.Get("/api/providers/acme/summary").Expect(200).JSON(&sum)
	if sum.Keys.Active != 2 || len(sum.ModelGaps) != 1 || sum.ModelGaps[0].UpstreamKey != "key-1" || !sum.ModelGaps[0].ExpiresAt.Equal(g.ExpiresAt) {
		t.Fatalf("summary = %+v", sum)
	}

	// gpt-x never reaches key-1 again; other models still do.
	n := up.Count()
	for range 4 {
		caller.Post(chatPath, chat("gpt-x")).Expect(200)
	}
	if got := bearers(up, n); got != "b,b,b,b" {
		t.Fatalf("gpt-x went to = %s", got)
	}
	n = up.Count()
	for range 4 {
		caller.Post(chatPath, chat("gpt-y")).Expect(200)
	}
	if got := bearers(up, n); !strings.Contains(got, "a") {
		t.Fatalf("a key with a Model Gap stopped serving other models: %s", got)
	}

	// Still out a second before 24 hours; back after them, logged as expired.
	srv.Clock.Advance(24*time.Hour - time.Second)
	n = up.Count()
	for range 2 {
		caller.Post(chatPath, chat("gpt-x")).Expect(200)
	}
	if got := bearers(up, n); got != "b,b" {
		t.Fatalf("before expiry gpt-x went to = %s", got)
	}
	srv.Clock.Advance(time.Second)
	if k := readKey(t, srv, "key-1"); len(k.ModelGaps) != 0 {
		t.Fatalf("an expired gap is still shown: %+v", k.ModelGaps)
	}
	n = up.Count()
	for range 2 {
		caller.Post(chatPath, chat("gpt-x")).Expect(200)
	}
	if got := bearers(up, n); !strings.Contains(got, "a") {
		t.Fatalf("after expiry gpt-x went to = %s", got)
	}
	expired := 0
	for _, e := range srv.Logs("kind=model_gap&provider=acme") {
		if e.Attrs["op"] == "expired" && e.Attrs["model"] == "gpt-x" && e.Attrs["upstream_key"] == "key-1" && e.Attrs["until"] == "2026-01-02T00:00:00Z" {
			expired++
		}
	}
	if expired != 1 {
		t.Fatalf("%d expired events", expired)
	}
}

func TestAModelEveryKeyIsRefusedIsAnsweredWithoutAnAttempt(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b")
	caller := srv.Client(issue(t, srv, "pi", all))
	refuse(t, up, "sk-test-a gpt-x", "sk-test-b gpt-x")

	var e callerError
	resp := caller.Post(chatPath, chat("gpt-x")).Expect(404).JSON(&e)
	if e.Error.Code != "model_unavailable" || e.Error.Details.Reason != "model_gap" || len(e.Error.Details.Attempts) != 2 || e.Error.Hint == "" {
		t.Fatalf("first refusal = %s", resp.Body)
	}
	n := up.Count()
	resp = caller.Post(chatPath, chat("gpt-x")).Expect(404).JSON(&e)
	if e.Error.Code != "model_unavailable" || e.Error.Details.Reason != "model_gap" || e.Error.Details.Until != "2026-01-02T00:00:00Z" || up.Count() != n {
		t.Fatalf("planned refusal = %s (upstream got %d more)", resp.Body, up.Count()-n)
	}
	caller.Post(chatPath, chat("gpt-y")).Expect(200)
}

func TestModelGapsClearOnKeyTestKeyEditAndByHand(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c")
	caller := srv.Client(issue(t, srv, "pi", all))
	ents := refuse(t, up, "sk-test-a gpt-x", "sk-test-b gpt-x", "sk-test-c gpt-x")
	caller.Post(chatPath, chat("gpt-x")).Expect(404)
	for _, k := range []string{"key-1", "key-2", "key-3"} {
		if g := gapsOf(readKey(t, srv, k)); g != "gpt-x" {
			t.Fatalf("%s gaps = %q", k, g)
		}
	}

	// A key test refused the model renews the gap; a passing test clears every gap of the key.
	srv.Clock.Advance(time.Hour)
	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=gpt-x", nil).Expect(200).JSON(&res)
	if res.Passed || res.Outcome != "model_gap" || !strings.Contains(res.Action, "Model Gap") ||
		!readKey(t, srv, "key-1").ModelGaps[0].ExpiresAt.Equal(srv.Clock.Now().Add(24*time.Hour)) {
		t.Fatalf("refused test = %+v", res)
	}
	srv.Admin.Post("/api/providers/acme/keys/key-1/test?model=gpt-y", nil).Expect(200).JSON(&res)
	if !res.Passed || gapsOf(readKey(t, srv, "key-1")) != "" {
		t.Fatalf("passing test = %+v, gaps %q", res, gapsOf(readKey(t, srv, "key-1")))
	}
	if ev := srv.Logs("kind=model_gap&provider=acme"); ev[0].Attrs["op"] != "cleared" || ev[0].Attrs["upstream_key"] != "key-1" || !strings.Contains(ev[0].Attrs["reason"].(string), "key test passed") {
		t.Fatalf("cleared by test = %+v", ev[0])
	}

	// Editing the key (a rename) clears its gaps; enabling or disabling does not.
	srv.Admin.Post("/api/providers/acme/keys/key-2/disable", nil).Expect(200)
	srv.Admin.Post("/api/providers/acme/keys/key-2/enable", nil).Expect(200)
	if gapsOf(readKey(t, srv, "key-2")) != "gpt-x" {
		t.Fatal("enable/disable cleared a gap")
	}
	var edit providers.UpstreamKeyResult
	srv.Admin.Patch("/api/providers/acme/keys/key-2", map[string]any{"name": "key-two"}).Expect(200).JSON(&edit)
	if len(edit.UpstreamKey.ModelGaps) != 0 || len(edit.Changes) != 2 || edit.Changes[1].Resource != "model_gap" || edit.Changes[1].Op != "delete" {
		t.Fatalf("edit = %+v", edit)
	}
	if ev := srv.Logs("kind=model_gap&provider=acme"); ev[0].Attrs["op"] != "cleared" || ev[0].Attrs["upstream_key"] != "key-two" {
		t.Fatalf("cleared by edit = %+v", ev[0])
	}

	// By hand: a dry run changes nothing; the clear is audited and revert restores the gap.
	var cleared providers.UpstreamKeyResult
	srv.Admin.Post("/api/providers/acme/keys/key-3/clear-model-gaps?dry_run=true", nil).Expect(200).JSON(&cleared)
	if !cleared.DryRun || cleared.Outcome != "deleted" || len(cleared.Changes) != 1 || gapsOf(readKey(t, srv, "key-3")) != "gpt-x" {
		t.Fatalf("dry run = %+v", cleared)
	}
	srv.Admin.Post("/api/providers/acme/keys/key-3/clear-model-gaps?model=other", nil).Expect(200).JSON(&cleared)
	if cleared.Outcome != "unchanged" || cleared.AuditEntry != "" || gapsOf(cleared.UpstreamKey) != "gpt-x" {
		t.Fatalf("clear of another model = %+v", cleared)
	}
	owner := srv.OwnerSession()
	owner.Post("/api/providers/acme/keys/key-3/clear-model-gaps?model=gpt-x", nil).Expect(200).JSON(&cleared)
	if cleared.Outcome != "deleted" || cleared.AuditEntry == "" || len(cleared.UpstreamKey.ModelGaps) != 0 {
		t.Fatalf("clear = %+v", cleared)
	}
	ev := srv.Logs("kind=model_gap&provider=acme")
	if ev[0].Attrs["op"] != "cleared" || ev[0].Attrs["upstream_key"] != "key-3" || ev[0].Attrs["reason"] != "Cleared by Owner." {
		t.Fatalf("cleared by hand = %+v", ev[0])
	}
	var entries audit.EntryPage
	srv.Admin.Get("/api/audit-entries?resource=model_gap").Expect(200).JSON(&entries)
	if len(entries.Entries) == 0 || entries.Entries[0].Summary != "Cleared Model Gap acme/key-3/gpt-x" {
		t.Fatalf("audit entries = %+v", entries)
	}
	srv.Admin.Post("/api/audit-entries/"+cleared.AuditEntry+"/revert", nil).Expect(200)
	if k := readKey(t, srv, "key-3"); gapsOf(k) != "gpt-x" || !k.ModelGaps[0].CreatedAt.Equal(testkit.Epoch) {
		t.Fatalf("after revert = %+v", k.ModelGaps)
	}

	// Once cleared, the model reaches the key again.
	ents.allow("sk-test-a gpt-x")
	n := up.Count()
	caller.Post(chatPath, chat("gpt-x")).Expect(200)
	if got := bearers(up, n); !strings.HasSuffix(got, "a") {
		t.Fatalf("after clearing gpt-x went to = %s", got)
	}
}

func TestModelGapsClearInBulkForSelectedKeys(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a", "sk-test-b", "sk-test-c")
	caller := srv.Client(issue(t, srv, "pi", all))
	refuse(t, up, "sk-test-a gpt-x", "sk-test-b gpt-x", "sk-test-c gpt-x", "sk-test-a gpt-y")
	caller.Post(chatPath, chat("gpt-x")).Expect(404)
	for range 3 { // the third starts at key-1
		caller.Post(chatPath, chat("gpt-y")).Expect(200)
	}
	if g := gapsOf(readKey(t, srv, "key-1")); g != "gpt-x,gpt-y" {
		t.Fatalf("key-1 gaps = %q", g)
	}

	var bulk audit.BulkResult[providers.UpstreamKey]
	srv.Admin.Post("/api/providers/acme/keys/bulk/clear-model-gaps?model=gpt-x", map[string]any{"items": []string{"key-1", "key-2", "nope"}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 2 || bulk.Failed != 1 || bulk.AuditEntry == "" || bulk.Items[0].Outcome != "deleted" {
		t.Fatalf("bulk = %+v", bulk)
	}
	if a, b, c := gapsOf(readKey(t, srv, "key-1")), gapsOf(readKey(t, srv, "key-2")), gapsOf(readKey(t, srv, "key-3")); a != "gpt-y" || b != "" || c != "gpt-x" {
		t.Fatalf("after bulk: key-1 %q key-2 %q key-3 %q", a, b, c)
	}
	if ev := srv.Logs("kind=model_gap&provider=acme&since=1m"); len(ev) < 2 || ev[0].Attrs["op"] != "cleared" || ev[1].Attrs["op"] != "cleared" {
		t.Fatalf("bulk clear events = %+v", ev)
	}
	// One revert puts both back.
	srv.Admin.Post("/api/audit-entries/"+bulk.AuditEntry+"/revert", nil).Expect(200)
	if a, b := gapsOf(readKey(t, srv, "key-1")), gapsOf(readKey(t, srv, "key-2")); a != "gpt-x,gpt-y" || b != "gpt-x" {
		t.Fatalf("after revert: key-1 %q key-2 %q", a, b)
	}
	// Without a model, every gap of the selected keys goes.
	srv.Admin.Post("/api/providers/acme/keys/bulk/clear-model-gaps", map[string]any{"items": []string{"key-1"}}).Expect(200).JSON(&bulk)
	if gapsOf(readKey(t, srv, "key-1")) != "" || len(bulk.Items[0].Changes) != 2 {
		t.Fatalf("clear all = %+v", bulk)
	}
}

// FAIL-66: a refusal scoped to one key and model (Model Gap, model
// cooling) keeps the key serving other wire models in the same Request: on
// an Endpoint that renames the Caller's model differently, or a Pool member
// naming another model.
func TestAPerModelRefusalLeavesTheKeyForOtherWireModelsInTheSameRequest(t *testing.T) {
	srv := testkit.Start(t)
	a, b := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "a", "url": a.URL(), "shape": "openai-chat",
		"renames": map[string]string{"m": "gpt-x", "n": "gpt-n1"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "b", "url": b.URL(), "shape": "openai-chat",
		"renames": map[string]string{"m": "gpt-y", "n": "gpt-n2"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-a"}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))
	refuse(t, a, "sk-test-a gpt-x")

	resp := caller.Post(chatPath, chat("m")).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Outcome != "model_gap" || r.Attempts[1].Endpoint != "b" || r.Attempts[1].WireModel != "gpt-y" {
		t.Fatalf("model gap: attempts = %+v", r.Attempts)
	}

	a.Enqueue(a.ErrorCode(429, "rate_limit_exceeded", "Slow down."))
	resp = caller.Post(chatPath, chat("n")).Expect(200)
	r = readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Outcome != "cooling_key_model" || r.Attempts[1].WireModel != "gpt-n2" {
		t.Fatalf("model cooling: attempts = %+v", r.Attempts)
	}
}

// Spec "Model Gap": cleared on key edit, and changing which Endpoints a key
// may use is an edit (the same model may be served on the new ones).
func TestChangingAKeysEndpointRestrictionClearsItsModelGaps(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-a")
	caller := srv.Client(issue(t, srv, "pi", all))
	refuse(t, up, "sk-test-a gpt-x")
	caller.Post(chatPath, chat("gpt-x")).Expect(404)
	if g := gapsOf(readKey(t, srv, "key-1")); g != "gpt-x" {
		t.Fatalf("gaps = %q", g)
	}

	// The same restriction again changes nothing.
	srv.Admin.Patch("/api/providers/acme/keys/key-1", map[string]any{"endpoints": []string{}}).Expect(200)
	if g := gapsOf(readKey(t, srv, "key-1")); g != "gpt-x" {
		t.Fatalf("an unchanged restriction cleared gaps: %q", g)
	}
	var edit providers.UpstreamKeyResult
	srv.Admin.Patch("/api/providers/acme/keys/key-1", map[string]any{"endpoints": []string{"default"}}).Expect(200).JSON(&edit)
	if len(edit.UpstreamKey.ModelGaps) != 0 || gapsOf(readKey(t, srv, "key-1")) != "" {
		t.Fatalf("edit = %+v", edit)
	}
	if ev := srv.Logs("kind=model_gap&provider=acme"); ev[0].Attrs["op"] != "cleared" || ev[0].Attrs["upstream_key"] != "key-1" {
		t.Fatalf("cleared by restriction = %+v", ev[0])
	}
}
