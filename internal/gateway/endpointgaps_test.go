package gateway_test

import (
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gateway"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func gapped(t *testing.T) (*testkit.Server, *testkit.Client, *testkit.Upstream, *testkit.Upstream) {
	t.Helper()
	srv := testkit.Start(t)
	a, b := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "b", "url": b.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "a", "url": a.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "k", "secret": "sk-test-k", "endpoints": []string{"a"}}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))
	caller.Post(chatPath, chat("m")).Expect(200)
	srv.Admin.Patch("/api/providers/acme/keys/k", map[string]any{"endpoints": []string{}}).Expect(200)
	b.Default(b.Error(401, "Incorrect API key provided"))
	caller.Post(chatPath, chat("m")).Expect(200)
	if k := readKey(t, srv, "k"); len(k.EndpointGaps) != 1 {
		t.Fatalf("setup: key = %+v", k)
	}
	return srv, caller, a, b
}

func gapNames(k providers.UpstreamKey) string {
	var out []string
	for _, g := range k.EndpointGaps {
		out = append(out, g.Endpoint)
	}
	return strings.Join(out, ",")
}

func TestAKeyRefusedOnOneEndpointKeepsServingTheOneItWorksOn(t *testing.T) {
	srv := testkit.Start(t)
	a, b := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "b", "url": b.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "a", "url": a.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "k", "secret": "sk-test-k", "endpoints": []string{"a"}}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))
	caller.Post(chatPath, chat("m")).Expect(200)
	if k := readKey(t, srv, "k"); len(k.WorkedOn) != 1 || k.WorkedOn[0].Endpoint != "a" || k.WorkedOn[0].SucceededAt.IsZero() {
		t.Fatalf("worked_on = %+v", k.WorkedOn)
	}

	srv.Admin.Patch("/api/providers/acme/keys/k", map[string]any{"endpoints": []string{}}).Expect(200)
	b.Default(b.Error(401, "Incorrect API key provided"))
	resp := caller.Post(chatPath, chat("m")).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Endpoint != "b" || r.Attempts[0].Status != 401 || r.Attempts[0].Outcome != "invalid" ||
		!strings.Contains(r.Attempts[0].Action, "Endpoint Gap on b") || r.Attempts[1].Endpoint != "a" || r.Attempts[1].Status != 200 || r.Endpoint != "a" {
		t.Fatalf("attempts = %+v", r.Attempts)
	}
	k := readKey(t, srv, "k")
	if k.State.State != "active" || gapNames(k) != "b" || !strings.Contains(k.EndpointGaps[0].Reason, "401") ||
		!strings.Contains(k.EndpointGaps[0].Reason, "works on a") || k.EndpointGaps[0].RequestID != r.ID {
		t.Fatalf("key = %+v gaps %+v", k.State, k.EndpointGaps)
	}

	before := b.Count()
	for range 3 {
		resp := caller.Post(chatPath, chat("m")).Expect(200)
		if r := readRequest(t, srv, resp.Header.Get("X-Request-Id")); len(r.Attempts) != 1 || r.Endpoint != "a" {
			t.Fatalf("attempts = %+v", r.Attempts)
		}
	}
	if b.Count() != before {
		t.Fatalf("b got %d more", b.Count()-before)
	}

	ev := srv.Logs("kind=endpoint_gap")
	if len(ev) != 1 || ev[0].Attrs["op"] != "created" || ev[0].Attrs["endpoint"] != "b" || ev[0].Attrs["upstream_key"] != "k" || ev[0].RequestID != r.ID || ev[0].Provider != "acme" {
		t.Fatalf("events = %+v", ev)
	}
	if ev := srv.Logs("kind=key.state"); len(ev) != 0 {
		t.Fatalf("key.state events = %+v", ev)
	}

	var pv gateway.RoutePreview
	srv.Admin.Get("/api/route-preview?model=acme/m").Expect(200).JSON(&pv)
	m := pv.Members[0]
	if len(m.Candidates) != 1 || m.Candidates[0].Endpoint != "a" || len(m.Skipped) != 1 || m.Skipped[0].Reason != "endpoint_gap" ||
		m.Skipped[0].Endpoint != "b" || m.Skipped[0].UpstreamKey != "k" || pv.Outcome != nil {
		t.Fatalf("preview = %+v", m)
	}

	var gl providers.EndpointGapList
	srv.Admin.Get("/api/providers/acme/endpoint-gaps").Expect(200).JSON(&gl)
	if len(gl.EndpointGaps) != 1 || gl.EndpointGaps[0].UpstreamKey != "k" || gl.EndpointGaps[0].Endpoint != "b" {
		t.Fatalf("list = %+v", gl)
	}
	srv.Admin.Get("/api/providers/acme/endpoint-gaps?endpoint=a").Expect(200).JSON(&gl)
	if len(gl.EndpointGaps) != 0 {
		t.Fatalf("list on a = %+v", gl)
	}
	var sum providers.ProviderSummary
	srv.Admin.Get("/api/providers/acme/summary").Expect(200).JSON(&sum)
	if len(sum.EndpointGaps) != 1 || sum.Keys.Active != 1 {
		t.Fatalf("summary = %+v", sum)
	}
}

func TestAKeyThatWorkedNowhereElseStillBecomesInvalid(t *testing.T) {
	srv := testkit.Start(t)
	a, b := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "b", "url": b.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "a", "url": a.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "k", "secret": "sk-test-k"}).Expect(201)
	caller := srv.Client(issue(t, srv, "pi", all))

	b.Enqueue(b.Error(401, "Incorrect API key provided"))
	var ce callerError
	caller.Post(chatPath, chat("m")).Expect(502).JSON(&ce)
	if at := ce.Error.Details.Attempts; len(at) != 1 || at[0].Outcome != "invalid" || strings.Contains(at[0].Action, "Endpoint Gap") {
		t.Fatalf("attempts = %+v", at)
	}
	if k := readKey(t, srv, "k"); k.State.State != "invalid" || len(k.EndpointGaps) != 0 || a.Count() != 0 {
		t.Fatalf("key = %+v gaps %+v; a got %d", k.State, k.EndpointGaps, a.Count())
	}
}

func TestAKeyRefusedWhereItLastWorkedBecomesInvalidAndLosesItsGaps(t *testing.T) {
	srv, caller, a, _ := gapped(t)
	a.Enqueue(a.Error(401, "Incorrect API key provided"))
	caller.Post(chatPath, chat("m")).Expect(502)
	k := readKey(t, srv, "k")
	if k.State.State != "invalid" || len(k.EndpointGaps) != 0 {
		t.Fatalf("key = %+v gaps %+v", k.State, k.EndpointGaps)
	}
	ev := srv.Logs("kind=endpoint_gap")
	if len(ev) != 2 || ev[0].Attrs["op"] != "cleared" || ev[0].Attrs["endpoint"] != "b" {
		t.Fatalf("events = %+v", ev)
	}
}

func TestAnOwnerRuleSayingInvalidAlsoMakesAnEndpointGap(t *testing.T) {
	srv, caller, a, b := gapped(t)
	srv.Admin.Patch("/api/providers/acme/keys/k", map[string]any{"endpoints": []string{"a"}}).Expect(200)
	srv.Admin.Post("/api/rules", map[string]any{"name": "region-refused", "status": []string{"400"}, "body": "not available in your region", "outcome": "invalid"}).Expect(201)
	srv.Admin.Patch("/api/providers/acme/keys/k", map[string]any{"endpoints": []string{}}).Expect(200)
	if k := readKey(t, srv, "k"); len(k.EndpointGaps) != 0 {
		t.Fatalf("restriction edit kept gaps %+v", k.EndpointGaps)
	}
	b.Default(b.Error(400, "This model is not available in your region"))
	resp := caller.Post(chatPath, chat("m")).Expect(200)
	r := readRequest(t, srv, resp.Header.Get("X-Request-Id"))
	if len(r.Attempts) != 2 || r.Attempts[0].Rule != "region-refused" || !strings.Contains(r.Attempts[0].Action, "Endpoint Gap on b") || r.Endpoint != "a" {
		t.Fatalf("attempts = %+v", r.Attempts)
	}
	if k := readKey(t, srv, "k"); k.State.State != "active" || gapNames(k) != "b" || a.Count() < 2 {
		t.Fatalf("key = %+v gaps %+v", k.State, k.EndpointGaps)
	}
}

func TestTheOwnerClearsAnEndpointGapAndCanUndoIt(t *testing.T) {
	srv, _, _, _ := gapped(t)
	var res providers.UpstreamKeyResult
	srv.Admin.Post("/api/providers/acme/keys/k/clear-endpoint-gaps?endpoint=a", nil).Expect(200).JSON(&res)
	if res.Outcome != "unchanged" || gapNames(res.UpstreamKey) != "b" {
		t.Fatalf("clearing a = %+v", res)
	}
	srv.Admin.Post("/api/providers/acme/keys/k/clear-endpoint-gaps", nil).Expect(200).JSON(&res)
	if res.AuditEntry == "" || len(res.UpstreamKey.EndpointGaps) != 0 || len(readKey(t, srv, "k").EndpointGaps) != 0 {
		t.Fatalf("clear = %+v", res)
	}
	if ev := srv.Logs("kind=endpoint_gap"); len(ev) != 2 || ev[0].Attrs["op"] != "cleared" {
		t.Fatalf("events = %+v", ev)
	}
	srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(200)
	if k := readKey(t, srv, "k"); gapNames(k) != "b" {
		t.Fatalf("after revert = %+v", k.EndpointGaps)
	}

	var bulk struct {
		AuditEntry string `json:"audit_entry"`
		Succeeded  int
	}
	srv.Admin.Post("/api/providers/acme/keys/bulk/clear-endpoint-gaps", map[string]any{"items": []string{"k"}}).Expect(200).JSON(&bulk)
	if bulk.AuditEntry == "" || len(readKey(t, srv, "k").EndpointGaps) != 0 {
		t.Fatalf("bulk = %+v", bulk)
	}
}

func TestAPassingKeyTestOnTheEndpointClearsItsGap(t *testing.T) {
	srv, _, _, b := gapped(t)
	var res gateway.KeyTestResult
	srv.Admin.Post("/api/providers/acme/keys/k/test?model=m", nil).Expect(200).JSON(&res)
	if !res.Passed || res.Endpoint != "a" || gapNames(readKey(t, srv, "k")) != "b" {
		t.Fatalf("test on a = %+v", res)
	}
	srv.Admin.Post("/api/providers/acme/keys/k/test?model=m&endpoint=b", nil).Expect(200).JSON(&res)
	if res.Passed || res.Outcome != "invalid" || res.State.State != "active" || !strings.Contains(res.Action, "Endpoint Gap") {
		t.Fatalf("failing test on b = %+v", res)
	}
	b.Enqueue(b.Text("OK"))
	srv.Admin.Post("/api/providers/acme/keys/k/test?model=m&endpoint=b", nil).Expect(200).JSON(&res)
	k := readKey(t, srv, "k")
	if !res.Passed || len(k.EndpointGaps) != 0 || len(k.WorkedOn) != 2 {
		t.Fatalf("test on b = %+v; key gaps %+v worked %+v", res, k.EndpointGaps, k.WorkedOn)
	}
}

func TestEditingTheKeysSecretOrRestrictionClearsItsGaps(t *testing.T) {
	t.Run("secret", func(t *testing.T) {
		srv, caller, a, _ := gapped(t)
		var res providers.UpstreamKeyResult
		srv.Admin.Patch("/api/providers/acme/keys/k", map[string]any{"secret": "sk-test-new"}).Expect(200).JSON(&res)
		if len(res.UpstreamKey.EndpointGaps) != 0 || len(res.UpstreamKey.WorkedOn) != 0 {
			t.Fatalf("after secret change = %+v", res.UpstreamKey)
		}
		caller.Post(chatPath, chat("m")).Expect(502)
		if k := readKey(t, srv, "k"); k.State.State != "invalid" || a.Last().Bearer() == "sk-test-new" {
			t.Fatalf("key = %+v", k.State)
		}
		srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(200)
		if k := readKey(t, srv, "k"); k.Secret != "sk-test-k" || gapNames(k) != "b" {
			t.Fatalf("after revert = %+v", k)
		}
	})
	t.Run("restriction", func(t *testing.T) {
		srv, _, _, _ := gapped(t)
		var res providers.UpstreamKeyResult
		srv.Admin.Patch("/api/providers/acme/keys/k", map[string]any{"endpoints": []string{"a", "b"}}).Expect(200).JSON(&res)
		if len(res.UpstreamKey.EndpointGaps) != 0 || len(res.UpstreamKey.WorkedOn) != 1 {
			t.Fatalf("after restriction = %+v", res.UpstreamKey)
		}
		srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(200)
		srv.Admin.Patch("/api/providers/acme/keys/k", map[string]any{"name": "k2"}).Expect(200)
		srv.Admin.Post("/api/providers/acme/keys/k2/disable", nil).Expect(200)
		var k providers.UpstreamKey
		srv.Admin.Get("/api/providers/acme/keys/k2").Expect(200).JSON(&k)
		if gapNames(k) != "b" {
			t.Fatalf("rename and disable cleared the gap: %+v", k)
		}
	})
}

func TestRestrictingAKeyToTheEndpointsItWorksOn(t *testing.T) {
	srv, caller, _, b := gapped(t)
	var res providers.UpstreamKeyResult
	srv.Admin.Post("/api/providers/acme/keys/k/restrict-to-working-endpoints?dry_run=true", nil).Expect(200).JSON(&res)
	if !res.DryRun || !slices.Equal(res.UpstreamKey.Endpoints, []string{"a"}) || len(readKey(t, srv, "k").Endpoints) != 0 {
		t.Fatalf("dry run = %+v", res)
	}
	srv.Admin.Post("/api/providers/acme/keys/k/restrict-to-working-endpoints", nil).Expect(200).JSON(&res)
	k := readKey(t, srv, "k")
	if res.Outcome != "updated" || !slices.Equal(k.Endpoints, []string{"a"}) || len(k.EndpointGaps) != 0 || res.AuditEntry == "" {
		t.Fatalf("restricted = %+v; key %+v", res, k)
	}
	var again providers.UpstreamKeyResult
	srv.Admin.Post("/api/providers/acme/keys/k/restrict-to-working-endpoints", nil).Expect(200).JSON(&again)
	if again.Outcome != "unchanged" || again.AuditEntry != "" {
		t.Fatalf("again = %+v", again)
	}
	before := b.Count()
	caller.Post(chatPath, chat("m")).Expect(200)
	if b.Count() != before {
		t.Fatal("the restricted key reached b")
	}
	var entries struct {
		Entries []struct{ ID, Summary string } `json:"entries"`
	}
	srv.Admin.Get("/api/audit-entries?record=acme/k").Expect(200).JSON(&entries)
	if len(entries.Entries) == 0 || !strings.Contains(entries.Entries[0].Summary, "Restricted") {
		t.Fatalf("entries = %+v", entries)
	}
	srv.Admin.Post("/api/audit-entries/"+entries.Entries[0].ID+"/revert", nil).Expect(200)
	if k := readKey(t, srv, "k"); len(k.Endpoints) != 0 || gapNames(k) != "b" {
		t.Fatalf("after revert = %+v", k)
	}

	var bulk struct {
		Succeeded, Failed int
	}
	srv.Admin.Post("/api/providers/acme/keys/bulk/restrict-to-working-endpoints", map[string]any{"items": []string{"k"}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 1 || !slices.Equal(readKey(t, srv, "k").Endpoints, []string{"a"}) {
		t.Fatalf("bulk = %+v", bulk)
	}
}

func TestRestrictingAKeyGappedOnEveryEndpointItMayUseIsRefused(t *testing.T) {
	srv, _, _, _ := gapped(t)
	srv.Admin.Delete("/api/providers/acme/endpoints/a").Expect(200)
	e := srv.Admin.Post("/api/providers/acme/keys/k/restrict-to-working-endpoints", nil).Expect(409).Err()
	if e.Code != "no_working_endpoint" || e.Hint == "" {
		t.Fatalf("error = %+v", e)
	}
	var ce callerError
	srv.Client(issue(t, srv, "pi2", all)).Post(chatPath, chat("m")).Expect(503).JSON(&ce)
	if !strings.Contains(ce.Error.Message, "Endpoint Gap") {
		t.Fatalf("caller error = %+v", ce.Error)
	}
}

func TestWhereAKeyWorkedIsWrittenAtMostOnceAMinute(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, "acme", up.URL(), "sk-test-k")
	caller := srv.Client(issue(t, srv, "pi", all))
	caller.Post(chatPath, chat("m")).Expect(200)
	first := readKey(t, srv, "key-1").WorkedOn[0].SucceededAt
	srv.Clock.Advance(30 * time.Second)
	caller.Post(chatPath, chat("m")).Expect(200)
	if got := readKey(t, srv, "key-1").WorkedOn[0].SucceededAt; !got.Equal(first) {
		t.Fatalf("rewritten within a minute: %v then %v", first, got)
	}
	srv.Clock.Advance(31 * time.Second)
	caller.Post(chatPath, chat("m")).Expect(200)
	if got := readKey(t, srv, "key-1").WorkedOn[0].SucceededAt; !got.Equal(first.Add(61 * time.Second)) {
		t.Fatalf("after a minute: %v then %v", first, got)
	}
}
