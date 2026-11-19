package audit_test

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/admintokens"
	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// Admin Tokens are the resource these tests drive the machinery through.

func entries(t *testing.T, c *testkit.Client, query string) []audit.Entry {
	t.Helper()
	var page audit.EntryPage
	c.Get("/api/audit-entries?" + query).Expect(200).JSON(&page)
	return page.Entries
}

func ids(es []audit.Entry) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.ID)
	}
	return out
}

func create(t *testing.T, c *testkit.Client, body map[string]any) admintokens.TokenResult {
	t.Helper()
	var r admintokens.TokenResult
	c.Post("/api/admin-tokens", body).OK().JSON(&r)
	return r
}

func token(t *testing.T, srv *testkit.Server, ref string) admintokens.Token {
	t.Helper()
	var tok admintokens.Token
	srv.Admin.Get("/api/admin-tokens/" + ref).Expect(200).JSON(&tok)
	return tok
}

func revert(t *testing.T, c *testkit.Client, entry string, status int, query ...string) *testkit.Response {
	t.Helper()
	path := "/api/audit-entries/" + entry + "/revert"
	if len(query) > 0 {
		path += "?" + query[0]
	}
	return c.Post(path, nil).Expect(status)
}

func TestAuditEntriesNameTheActorAndCanBeFiltered(t *testing.T) {
	srv := testkit.Start(t)
	agent := srv.NewAdminToken("agent-1") // entry 1, by bootstrap
	srv.Clock.Advance(time.Hour)
	byAgent := create(t, agent, map[string]any{"name": "worker", "note": "made by an agent"}) // entry 2, by agent-1
	srv.Clock.Advance(time.Hour)
	var patched admintokens.TokenResult
	srv.Admin.Patch("/api/admin-tokens/worker", map[string]any{"note": "edited"}).Expect(200).JSON(&patched) // entry 3

	all := entries(t, srv.Admin, "")
	if len(all) != 3 || all[0].ID != patched.AuditEntry || all[1].ID != byAgent.AuditEntry {
		t.Fatalf("entries newest first = %+v", all)
	}
	e := all[1]
	if e.Actor.Kind != api.ActorAdminToken || e.Actor.Name != "agent-1" || e.Action != "admin_token.create" ||
		e.Summary != "Created Admin Token worker" || !e.Revertible || !e.Time.Equal(testkit.Epoch.Add(time.Hour)) {
		t.Fatalf("entry = %+v", e)
	}
	if c := e.Changes[0]; c.Resource != "admin_token" || c.Name != "worker" || c.Op != "create" || string(c.Before) != "null" {
		t.Fatalf("change = %+v (before %s)", c, c.Before)
	}
	if u := all[0].Changes[0]; u.Op != "update" || !slices.Equal(u.Fields, []string{"note"}) || !strings.Contains(string(u.Before), "made by an agent") || !strings.Contains(string(u.After), "edited") {
		t.Fatalf("update change = %+v", u)
	}

	cases := map[string][]string{
		"actor=agent-1":                   {byAgent.AuditEntry},
		"actor=" + e.Actor.ID:             {byAgent.AuditEntry},
		"actor=bootstrap":                 {patched.AuditEntry, all[2].ID},
		"record=worker":                   {patched.AuditEntry, byAgent.AuditEntry},
		"record=" + byAgent.AdminToken.ID: {patched.AuditEntry, byAgent.AuditEntry},
		"resource=admin_token":            ids(all),
		"resource=provider":               nil,
		"action=admin_token.update":       {patched.AuditEntry},
		"action=admin_token.*":            ids(all),
		"q=agent-1":                       {all[2].ID},
		"since=30m":                       {patched.AuditEntry},
		"until=" + testkit.Epoch.Add(time.Minute).Format(time.RFC3339): {all[2].ID},
		"limit=1&before=" + patched.AuditEntry:                         {byAgent.AuditEntry},
	}
	for q, want := range cases {
		if got := ids(entries(t, srv.Admin, q)); !slices.Equal(got, want) {
			t.Errorf("%s: got %v, want %v", q, got, want)
		}
	}
	var page audit.EntryPage
	srv.Admin.Get("/api/audit-entries?limit=2").Expect(200).JSON(&page)
	if page.NextBefore != all[1].ID {
		t.Fatalf("next_before = %q, want %q", page.NextBefore, all[1].ID)
	}
	for _, bad := range []string{"limit=0", "since=yesterday"} {
		if e := srv.Admin.Get("/api/audit-entries?" + bad).Expect(400).Err(); e.Hint == "" {
			t.Errorf("%s: no hint", bad)
		}
	}

	// Secrets never appear whole in Audit Entries or in the change log events.
	raw := srv.Admin.Get("/api/audit-entries").Text()
	if strings.Contains(raw, byAgent.AdminToken.Secret) || strings.Contains(raw, agent.Token) {
		t.Fatal("an Audit Entry shows a whole secret")
	}
	events := srv.Logs("kind=config.change")
	if len(events) != 3 || events[0].Attrs["audit_entry"] != patched.AuditEntry || events[0].Attrs["actor"] != "bootstrap" {
		t.Fatalf("config.change events = %+v", events)
	}
	if strings.Contains(srv.Console(), byAgent.AdminToken.Secret) {
		t.Fatal("a secret reached the console")
	}
	if e := srv.Admin.Get("/api/audit-entries/ae_nope").Expect(404).Err(); !strings.Contains(e.Hint, "/api/audit-entries") {
		t.Fatalf("unknown entry: %+v", e)
	}
}

func TestRevertRestoresTheBeforeStateAndIsItselfAudited(t *testing.T) {
	srv := testkit.Start(t)
	agent := srv.NewAdminToken("agent-1")
	created := create(t, srv.Admin, map[string]any{"name": "worker", "note": "first"})
	var edit admintokens.TokenResult
	srv.Admin.Patch("/api/admin-tokens/worker", map[string]any{"name": "renamed", "note": "second"}).Expect(200).JSON(&edit)

	// A dry run of the revert reports and writes nothing.
	var dry audit.RevertResult
	revert(t, agent, edit.AuditEntry, 200, "dry_run=true").JSON(&dry)
	if !dry.DryRun || dry.AuditEntry != "" || dry.Reverted != edit.AuditEntry || len(dry.Changes) != 1 || !slices.Equal(dry.Changes[0].Fields, []string{"name", "note"}) {
		t.Fatalf("dry revert = %+v", dry)
	}
	if tok := token(t, srv, created.AdminToken.ID); tok.Name != "renamed" {
		t.Fatalf("dry revert changed the token: %+v", tok)
	}

	// The agent reverts the Owner's edit.
	var undo audit.RevertResult
	revert(t, agent, edit.AuditEntry, 200).JSON(&undo)
	if tok := token(t, srv, created.AdminToken.ID); tok.Name != "worker" || tok.Note != "first" || tok.Secret != created.AdminToken.Secret {
		t.Fatalf("after revert: %+v", tok)
	}
	var undoEntry, original audit.Entry
	srv.Admin.Get("/api/audit-entries/" + undo.AuditEntry).Expect(200).JSON(&undoEntry)
	srv.Admin.Get("/api/audit-entries/" + edit.AuditEntry).Expect(200).JSON(&original)
	if undoEntry.Action != "audit_entry.revert" || undoEntry.RevertOf != edit.AuditEntry || undoEntry.Actor.Name != "agent-1" ||
		!strings.HasPrefix(undoEntry.Summary, "Reverted: ") || !undoEntry.Revertible {
		t.Fatalf("revert entry = %+v", undoEntry)
	}
	if original.RevertedBy != undo.AuditEntry || original.Revertible || original.NotRevertible == "" {
		t.Fatalf("reverted entry = %+v", original)
	}
	if e := revert(t, srv.Admin, edit.AuditEntry, 409).Err(); e.Code != "audit_already_reverted" || !strings.Contains(e.Hint, undo.AuditEntry) {
		t.Fatalf("second revert: %+v", e)
	}

	// Reverting the revert redoes the change.
	revert(t, srv.Admin, undo.AuditEntry, 200)
	if tok := token(t, srv, created.AdminToken.ID); tok.Name != "renamed" || tok.Note != "second" {
		t.Fatalf("after redo: %+v", tok)
	}

	// The create cannot be reverted while the record differs from what it created.
	if e := revert(t, srv.Admin, created.AuditEntry, 409).Err(); e.Code != "audit_conflict" {
		t.Fatalf("create revert after edits must conflict (the record changed since): %+v", e)
	}
}

func TestAuditEntryFiltersListTheActorsAndResourcesInUse(t *testing.T) {
	srv := testkit.Start(t)
	var empty audit.FilterOptions
	srv.Admin.Get("/api/audit-entries/filters").Expect(200).JSON(&empty)
	if len(empty.Actors) != 0 || len(empty.Resources) != 0 {
		t.Fatalf("no entries yet, filters = %+v", empty)
	}

	agent := srv.NewAdminToken("agent-1")                                                         // bootstrap: 1 entry
	create(t, agent, map[string]any{"name": "worker"})                                            // agent-1: 1 entry
	owner := srv.OwnerSession()                                                                   // bootstrap sets the password: 2 entries
	srv.Clock.Advance(time.Minute)                                                                //
	create(t, owner, map[string]any{"name": "from-ui"})                                           // Owner: 1 entry
	owner.Patch("/api/admin-tokens/agent-1", map[string]any{"name": "agent-renamed"}).Expect(200) // Owner: 2 entries
	create(t, agent, map[string]any{"name": "worker-2"})                                          // agent, now named agent-renamed: 2 entries

	var f audit.FilterOptions
	srv.Admin.Get("/api/audit-entries/filters").Expect(200).JSON(&f)
	if len(f.Actors) != 3 {
		t.Fatalf("actors = %+v", f.Actors)
	}
	// The Owner comes first, then Admin Tokens by most recent change; a
	// renamed token shows its newest name and filters by ID.
	o, a, b := f.Actors[0], f.Actors[1], f.Actors[2]
	if o.Kind != api.ActorOwnerSession || o.Name != "Owner" || o.ID != "" || o.Filter != "Owner" || o.Entries != 2 {
		t.Fatalf("Owner = %+v", o)
	}
	if a.Kind != api.ActorAdminToken || a.Name != "agent-renamed" || a.Filter != a.ID || a.Entries != 2 {
		t.Fatalf("agent = %+v", a)
	}
	if b.Name != "bootstrap" || b.Entries != 2 {
		t.Fatalf("bootstrap = %+v", b)
	}
	for _, actor := range f.Actors {
		if got := entries(t, srv.Admin, "actor="+actor.Filter); len(got) != actor.Entries {
			t.Errorf("actor=%s gives %d entries, want %d", actor.Filter, len(got), actor.Entries)
		}
	}

	want := []audit.ResourceOption{
		{Name: "admin_token", Label: "Admin Token", Plural: "Admin Tokens", Entries: 5},
		{Name: "owner_password", Label: "Owner password", Plural: "Owner passwords", Entries: 1},
	}
	if !slices.Equal(f.Resources, want) {
		t.Fatalf("resources = %+v, want %+v", f.Resources, want)
	}
	for _, r := range f.Resources {
		if got := entries(t, srv.Admin, "resource="+r.Name); len(got) != r.Entries {
			t.Errorf("resource=%s gives %d entries, want %d", r.Name, len(got), r.Entries)
		}
	}
}

func TestRevertFromTheOwnerSessionIsRecordedAsTheOwner(t *testing.T) {
	srv := testkit.Start(t)
	created := create(t, srv.Admin, map[string]any{"name": "worker"})
	owner := srv.OwnerSession()

	var undo audit.RevertResult
	revert(t, owner, created.AuditEntry, 200).JSON(&undo)
	var e audit.Entry
	srv.Admin.Get("/api/audit-entries/" + undo.AuditEntry).Expect(200).JSON(&e)
	if e.Action != "audit_entry.revert" || e.RevertOf != created.AuditEntry || e.Actor.Kind != api.ActorOwnerSession || e.Actor.Name != "Owner" {
		t.Fatalf("revert entry = %+v", e)
	}
	if got := ids(entries(t, srv.Admin, "actor=Owner&action=audit_entry.revert")); !slices.Equal(got, []string{undo.AuditEntry}) {
		t.Fatalf("the Owner's reverts = %v", got)
	}
}

func TestRevertingACreateDeletesTheRecordAndRedoBringsItBack(t *testing.T) {
	srv := testkit.Start(t)
	created := create(t, srv.Admin, map[string]any{"name": "worker"})
	worker := srv.Client(created.AdminToken.Secret)

	var undo audit.RevertResult
	revert(t, srv.Admin, created.AuditEntry, 200).JSON(&undo)
	if undo.Outcome != "deleted" || undo.Changes[0].Op != "delete" {
		t.Fatalf("undo create = %+v", undo)
	}
	srv.Admin.Get("/api/admin-tokens/worker").Expect(404)
	worker.Get("/api/whoami").Expect(401)

	revert(t, srv.Admin, undo.AuditEntry, 200)
	if tok := token(t, srv, "worker"); tok.ID != created.AdminToken.ID || tok.Secret != created.AdminToken.Secret {
		t.Fatalf("redo create: %+v", tok)
	}
	worker.Get("/api/whoami").Expect(200)
}

func TestRevertRefusesIrreversibleAndConflictingEntries(t *testing.T) {
	srv := testkit.Start(t)
	srv.NewAdminToken("worker")
	var revoked admintokens.TokenResult
	srv.Admin.Post("/api/admin-tokens/worker/revoke", nil).Expect(200).JSON(&revoked)
	var entry audit.Entry
	srv.Admin.Get("/api/audit-entries/" + revoked.AuditEntry).JSON(&entry)
	if entry.Revertible || !strings.Contains(entry.NotRevertible, "never work again") {
		t.Fatalf("revoke entry = %+v", entry)
	}
	if e := revert(t, srv.Admin, revoked.AuditEntry, 409).Err(); e.Code != "audit_irreversible" || e.Hint == "" {
		t.Fatalf("revert of a revoke: %+v", e)
	}

	// Two edits of one record: the older cannot be reverted over the newer.
	create(t, srv.Admin, map[string]any{"name": "pi"})
	var e1, e2 admintokens.TokenResult
	srv.Admin.Patch("/api/admin-tokens/pi", map[string]any{"note": "x"}).Expect(200).JSON(&e1)
	srv.Admin.Patch("/api/admin-tokens/pi", map[string]any{"note": "y"}).Expect(200).JSON(&e2)
	var conflict struct {
		Error struct {
			Code    string
			Hint    string
			Details struct{ Conflicts []audit.Conflict }
		}
	}
	revert(t, srv.Admin, e1.AuditEntry, 409).JSON(&conflict)
	c := conflict.Error.Details.Conflicts
	if conflict.Error.Code != "audit_conflict" || conflict.Error.Hint == "" || len(c) != 1 || c[0].Name != "pi" || !slices.Equal(c[0].Later, []string{e2.AuditEntry}) {
		t.Fatalf("conflict = %+v", conflict)
	}
	if tok := token(t, srv, "pi"); tok.Note != "y" {
		t.Fatalf("a refused revert changed the token: %+v", tok)
	}
	// Newest first works.
	revert(t, srv.Admin, e2.AuditEntry, 200)
	revert(t, srv.Admin, e1.AuditEntry, 200)
	if tok := token(t, srv, "pi"); tok.Note != "" {
		t.Fatalf("after reverting both: %+v", tok)
	}
}

func TestRevertingABulkEntryRestoresEveryRecord(t *testing.T) {
	srv := testkit.Start(t)
	var bulk audit.BulkResult[admintokens.Token]
	srv.Admin.Post("/api/admin-tokens/bulk", map[string]any{"items": []any{
		map[string]any{"name": "a", "note": "1"}, map[string]any{"name": "b"}, map[string]any{"name": "a", "note": "2"},
	}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 3 || bulk.Items[2].Outcome != "updated" {
		t.Fatalf("bulk = %+v", bulk)
	}
	var entry audit.Entry
	srv.Admin.Get("/api/audit-entries/" + bulk.AuditEntry).JSON(&entry)
	if len(entry.Changes) != 2 || entry.Changes[0].Op != "create" || !strings.Contains(string(entry.Changes[0].After), `"note":"2"`) {
		t.Fatalf("one record touched twice is one change from first before to last after: %+v", entry.Changes)
	}
	revert(t, srv.Admin, bulk.AuditEntry, 200)
	srv.Admin.Get("/api/admin-tokens/a").Expect(404)
	srv.Admin.Get("/api/admin-tokens/b").Expect(404)
}

// Every error the admin API returns carries a code, a message and a hint.
func TestErrorResponsesAlwaysIncludeAHint(t *testing.T) {
	srv := testkit.Start(t)
	srv.NewAdminToken("worker")
	calls := []struct {
		method, path string
		body         any
	}{
		{http.MethodGet, "/api/admin-tokens/nobody", nil},
		{http.MethodGet, "/api/admin-tokens?revoked=sometimes", nil},
		{http.MethodPost, "/api/admin-tokens", "not json"},
		{http.MethodPost, "/api/admin-tokens", ""},
		{http.MethodPost, "/api/admin-tokens", map[string]any{"name": "a b"}},
		{http.MethodPost, "/api/admin-tokens?dry_run=perhaps", map[string]any{"name": "ok"}},
		{http.MethodPatch, "/api/admin-tokens/worker", map[string]any{"name": "bootstrap"}},
		{http.MethodPost, "/api/admin-tokens/nobody/revoke", nil},
		{http.MethodPost, "/api/admin-tokens/bulk", map[string]any{"items": []any{}}},
		{http.MethodPost, "/api/admin-tokens/bulk/revoke", map[string]any{"wrong": 1}},
		{http.MethodGet, "/api/audit-entries/ae_missing", nil},
		{http.MethodPost, "/api/audit-entries/ae_missing/revert", nil},
		{http.MethodGet, "/api/audit-entries?limit=-1", nil},
		{http.MethodDelete, "/api/admin-tokens/worker", nil},
		{http.MethodGet, "/api/nothing-here", nil},
	}
	for _, c := range calls {
		r := srv.Admin.Do(c.method, c.path, c.body)
		if r.Status < 400 {
			t.Errorf("%s %s: status %d, want an error", c.method, c.path, r.Status)
			continue
		}
		if e := r.Err(); e.Code == "" || e.Message == "" || e.Hint == "" {
			t.Errorf("%s %s: error without code, message or hint: %+v", c.method, c.path, e)
		}
	}
}

// The conventions are described once in the served documents, and every
// mutating admin route takes dry_run.
func TestDocumentsDescribeTheConventionsOnce(t *testing.T) {
	srv := testkit.Start(t)
	for _, r := range srv.App.Routes() {
		if r.Method == http.MethodGet || !strings.HasPrefix(r.Path, "/api/") || r.Auth != api.AuthAdmin {
			continue
		}
		if !slices.ContainsFunc(r.Query, func(p api.Param) bool { return p.Name == "dry_run" }) {
			t.Errorf("%s does not take dry_run (add audit.DryRun to its Query)", r.Pattern())
		}
	}
	skill := srv.Anon.Get("/skill.md").Expect(200).Text()
	for _, want := range []string{"## Conventions of every admin resource", "dry_run=true", "/bulk", "Create-or-update", "audit_conflict", "POST /api/audit-entries/{entry}/revert"} {
		if !strings.Contains(skill, want) {
			t.Errorf("skill lacks %q", want)
		}
	}
	if n := strings.Count(skill, "## Conventions of every admin resource"); n != 1 {
		t.Errorf("conventions section appears %d times", n)
	}
	var doc struct {
		Info       struct{ Description string }
		Components struct{ Schemas map[string]any }
	}
	srv.Anon.Get("/api/openapi.json").Expect(200).JSON(&doc)
	if !strings.Contains(doc.Info.Description, "dry_run=true") || !strings.Contains(doc.Info.Description, "revert") {
		t.Errorf("openapi info lacks the conventions: %s", doc.Info.Description)
	}
	for _, name := range []string{"BulkResult_Token", "BulkItem_Token", "TokenResult", "Entry", "Change"} {
		if _, ok := doc.Components.Schemas[name]; !ok {
			t.Errorf("openapi lacks schema %s", name)
		}
	}
}
