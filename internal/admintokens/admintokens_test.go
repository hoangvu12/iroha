package admintokens_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/admintokens"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/testkit"
)

type tokenResult = admintokens.TokenResult
type bulkResult = audit.BulkResult[admintokens.Token]

func names(list admintokens.TokenList) []string {
	var out []string
	for _, t := range list.AdminTokens {
		out = append(out, t.Name)
	}
	return out
}

func TestAdminTokensCreateReadListAndRevokeByNameOrID(t *testing.T) {
	srv := testkit.Start(t)

	var created tokenResult
	srv.Admin.Post("/api/admin-tokens", map[string]any{"name": "agent-1", "note": "zeron fleet"}).Expect(201).JSON(&created)
	tok := created.AdminToken
	if created.Outcome != "created" || created.DryRun || created.AuditEntry == "" ||
		!strings.HasPrefix(tok.Secret, admintokens.SecretPrefix+"_") || tok.Note != "zeron fleet" || tok.Revoked {
		t.Fatalf("create = %+v", created)
	}
	if len(created.Changes) != 1 || created.Changes[0].Op != "create" || created.Changes[0].ID != tok.ID || string(created.Changes[0].Before) != "null" && created.Changes[0].Before != nil {
		t.Fatalf("create changes = %+v", created.Changes)
	}
	if strings.Contains(string(created.Changes[0].After), tok.Secret) {
		t.Fatalf("the change shows the whole secret: %s", created.Changes[0].After)
	}

	agent := srv.Client(tok.Secret)
	var who struct{ Name, Kind string }
	agent.Get("/api/whoami").Expect(200).JSON(&who)
	if who.Name != "agent-1" || who.Kind != "admin_token" {
		t.Fatalf("whoami = %+v", who)
	}

	// Read by name and by ID; the secret is readable.
	for _, ref := range []string{"agent-1", tok.ID} {
		var got admintokens.Token
		srv.Admin.Get("/api/admin-tokens/" + ref).Expect(200).JSON(&got)
		if got.ID != tok.ID || got.Secret != tok.Secret || got.Name != "agent-1" {
			t.Fatalf("read %s = %+v", ref, got)
		}
	}
	var list admintokens.TokenList
	srv.Admin.Get("/api/admin-tokens").Expect(200).JSON(&list)
	if got := names(list); !slices.Equal(got, []string{"bootstrap", "agent-1"}) {
		t.Fatalf("list = %v", got)
	}

	// Revoke by ID.
	var revoked tokenResult
	srv.Admin.Post("/api/admin-tokens/"+tok.ID+"/revoke", nil).Expect(200).JSON(&revoked)
	if revoked.Outcome != "updated" || !revoked.AdminToken.Revoked || revoked.AdminToken.RevokedAt == nil || revoked.AuditEntry == "" {
		t.Fatalf("revoke = %+v", revoked)
	}
	if e := agent.Get("/api/whoami").Expect(401).Err(); e.Code != "admin_token_revoked" {
		t.Fatalf("revoked token: %+v", e)
	}
	srv.Admin.Get("/api/admin-tokens?revoked=true").Expect(200).JSON(&list)
	if got := names(list); !slices.Equal(got, []string{"agent-1"}) {
		t.Fatalf("revoked=true: %v", got)
	}
	srv.Admin.Get("/api/admin-tokens?revoked=false").Expect(200).JSON(&list)
	if got := names(list); !slices.Equal(got, []string{"bootstrap"}) {
		t.Fatalf("revoked=false: %v", got)
	}

	// Revoking again changes nothing and writes no Audit Entry.
	var again tokenResult
	srv.Admin.Post("/api/admin-tokens/agent-1/revoke", nil).Expect(200).JSON(&again)
	if again.Outcome != "unchanged" || again.AuditEntry != "" || len(again.Changes) != 0 {
		t.Fatalf("second revoke = %+v", again)
	}

	e := srv.Admin.Get("/api/admin-tokens/nobody").Expect(404).Err()
	if e.Code != "not_found" || !strings.Contains(e.Hint, "GET /api/admin-tokens") {
		t.Fatalf("unknown token: %+v", e)
	}
}

func TestRepeatingACreateWithTheSameNameUpdatesInsteadOfDuplicating(t *testing.T) {
	srv := testkit.Start(t)
	var first, same, changed tokenResult
	srv.Admin.Post("/api/admin-tokens", map[string]any{"name": "agent-1", "note": "a"}).Expect(201).JSON(&first)

	srv.Admin.Post("/api/admin-tokens", map[string]any{"name": "agent-1"}).Expect(200).JSON(&same)
	if same.Outcome != "unchanged" || same.AuditEntry != "" || same.AdminToken.ID != first.AdminToken.ID ||
		same.AdminToken.Secret != first.AdminToken.Secret || same.AdminToken.Note != "a" {
		t.Fatalf("repeat = %+v", same)
	}
	srv.Admin.Post("/api/admin-tokens", map[string]any{"name": "agent-1", "note": "b"}).Expect(200).JSON(&changed)
	if changed.Outcome != "updated" || changed.AuditEntry == "" || changed.AdminToken.ID != first.AdminToken.ID ||
		changed.AdminToken.Note != "b" || len(changed.Changes) != 1 || !slices.Equal(changed.Changes[0].Fields, []string{"note"}) {
		t.Fatalf("repeat with a new note = %+v", changed)
	}
	var list admintokens.TokenList
	srv.Admin.Get("/api/admin-tokens").JSON(&list)
	if len(list.AdminTokens) != 2 {
		t.Fatalf("tokens = %v", names(list))
	}

	// A revoked name is not silently brought back.
	srv.Admin.Post("/api/admin-tokens/agent-1/revoke", nil).Expect(200)
	if e := srv.Admin.Post("/api/admin-tokens", map[string]any{"name": "agent-1"}).Expect(409).Err(); e.Code != "admin_token_revoked" || e.Hint == "" {
		t.Fatalf("create on a revoked name: %+v", e)
	}
}

func TestRenamingAndNameRules(t *testing.T) {
	srv := testkit.Start(t)
	srv.NewAdminToken("agent-1")
	srv.NewAdminToken("agent-2")

	var r tokenResult
	srv.Admin.Patch("/api/admin-tokens/agent-1", map[string]any{"name": "pi"}).Expect(200).JSON(&r)
	if r.AdminToken.Name != "pi" || r.Outcome != "updated" || !slices.Equal(r.Changes[0].Fields, []string{"name"}) || r.Changes[0].Name != "pi" {
		t.Fatalf("rename = %+v", r)
	}
	if e := srv.Admin.Patch("/api/admin-tokens/pi", map[string]any{"name": "agent-2"}).Expect(409).Err(); e.Code != "name_taken" {
		t.Fatalf("rename onto a taken name: %+v", e)
	}
	for _, bad := range []string{"", "has space", "a/b", "-dash", "bulk", strings.Repeat("x", 65)} {
		e := srv.Admin.Post("/api/admin-tokens", map[string]any{"name": bad}).Expect(400).Err()
		if e.Code != "invalid_request" || e.Hint == "" {
			t.Errorf("name %q: %+v", bad, e)
		}
	}
	if e := srv.Admin.Post("/api/admin-tokens", map[string]any{"name": "x", "nmae": "typo"}).Expect(400).Err(); e.Hint == "" {
		t.Fatalf("unknown field: %+v", e)
	}
}

func TestDryRunReportsTheWouldBeChangeAndWritesNothing(t *testing.T) {
	srv := testkit.Start(t)

	var dry tokenResult
	srv.Admin.Post("/api/admin-tokens?dry_run=true", map[string]any{"name": "agent-1"}).Expect(200).JSON(&dry)
	if !dry.DryRun || dry.Outcome != "created" || dry.AuditEntry != "" || len(dry.Changes) != 1 || dry.Changes[0].Op != "create" || dry.AdminToken.Name != "agent-1" {
		t.Fatalf("dry create = %+v", dry)
	}
	srv.Admin.Get("/api/admin-tokens/agent-1").Expect(404)
	srv.Client(dry.AdminToken.Secret).Get("/api/whoami").Expect(401)

	agent := srv.NewAdminToken("agent-1")
	srv.Admin.Patch("/api/admin-tokens/agent-1?dry_run=true", map[string]any{"name": "renamed", "note": "n"}).Expect(200).JSON(&dry)
	if !dry.DryRun || dry.Outcome != "updated" || !slices.Equal(dry.Changes[0].Fields, []string{"name", "note"}) {
		t.Fatalf("dry patch = %+v", dry)
	}
	srv.Admin.Post("/api/admin-tokens/agent-1/revoke?dry_run=1", nil).Expect(200).JSON(&dry)
	if !dry.DryRun || !dry.AdminToken.Revoked || len(dry.Changes) != 1 {
		t.Fatalf("dry revoke = %+v", dry)
	}
	agent.Get("/api/whoami").Expect(200)
	var got admintokens.Token
	srv.Admin.Get("/api/admin-tokens/agent-1").Expect(200).JSON(&got)
	if got.Revoked || got.Note != "" {
		t.Fatalf("dry runs changed the token: %+v", got)
	}

	var bulk bulkResult
	srv.Admin.Post("/api/admin-tokens/bulk?dry_run=true", map[string]any{"items": []any{map[string]any{"name": "b1"}, map[string]any{"name": "b2"}}}).Expect(200).JSON(&bulk)
	if !bulk.DryRun || bulk.Succeeded != 2 || bulk.AuditEntry != "" || bulk.Items[0].Outcome != "created" {
		t.Fatalf("dry bulk = %+v", bulk)
	}
	srv.Admin.Get("/api/admin-tokens/b1").Expect(404)

	var page audit.EntryPage
	srv.Admin.Get("/api/audit-entries").Expect(200).JSON(&page)
	if len(page.Entries) != 1 || page.Entries[0].Action != "admin_token.create" {
		t.Fatalf("only the real create should be audited: %+v", page.Entries)
	}

	if e := srv.Admin.Post("/api/admin-tokens?dry_run=maybe", map[string]any{"name": "x"}).Expect(400).Err(); e.Hint == "" {
		t.Fatalf("bad dry_run: %+v", e)
	}
}

func TestBulkAppliesEveryGoodItemAndReportsEachOne(t *testing.T) {
	srv := testkit.Start(t)

	var res bulkResult
	srv.Admin.Post("/api/admin-tokens/bulk", map[string]any{"items": []any{
		map[string]any{"name": "a"}, map[string]any{"name": "not valid"}, map[string]any{"name": "c", "note": "third"},
	}}).Expect(200).JSON(&res)
	if res.Succeeded != 2 || res.Failed != 1 || len(res.Items) != 3 || res.AuditEntry == "" {
		t.Fatalf("bulk create = %+v", res)
	}
	if bad := res.Items[1]; bad.OK || bad.Error == nil || bad.Error.Code != "invalid_request" || bad.Error.Hint == "" || bad.Index != 1 || bad.Result != nil {
		t.Fatalf("failed item = %+v", bad)
	}
	if ok := res.Items[2]; !ok.OK || ok.Outcome != "created" || ok.Result.Name != "c" || ok.Result.Note != "third" || len(ok.Changes) != 1 {
		t.Fatalf("good item = %+v", ok)
	}
	srv.Admin.Get("/api/admin-tokens/a").Expect(200)
	srv.Admin.Get("/api/admin-tokens/c").Expect(200)

	var entry audit.Entry
	srv.Admin.Get("/api/audit-entries/" + res.AuditEntry).Expect(200).JSON(&entry)
	if entry.Summary != "Created 2 Admin Tokens" || len(entry.Changes) != 2 {
		t.Fatalf("bulk entry = %+v", entry)
	}

	srv.Admin.Post("/api/admin-tokens/bulk/revoke", map[string]any{"items": []string{"a", "nope", "c"}}).Expect(200).JSON(&res)
	if res.Succeeded != 2 || res.Failed != 1 || res.Items[1].Error.Code != "not_found" || !res.Items[0].Result.Revoked {
		t.Fatalf("bulk revoke = %+v", res)
	}
	var list admintokens.TokenList
	srv.Admin.Get("/api/admin-tokens?revoked=true").JSON(&list)
	if got := names(list); !slices.Equal(got, []string{"a", "c"}) {
		t.Fatalf("revoked = %v", got)
	}
	if e := srv.Admin.Post("/api/admin-tokens/bulk", map[string]any{"items": []any{}}).Expect(400).Err(); e.Hint == "" {
		t.Fatalf("empty bulk: %+v", e)
	}
}

func TestTheLastActiveAdminTokenCannotBeRevoked(t *testing.T) {
	srv := testkit.Start(t)
	e := srv.Admin.Post("/api/admin-tokens/bootstrap/revoke", nil).Expect(409).Err()
	if e.Code != "last_admin_token" || !strings.Contains(e.Hint, "POST /api/admin-tokens") {
		t.Fatalf("revoking the last token: %+v", e)
	}
	// In bulk, every item but the last one applies.
	srv.NewAdminToken("agent-1")
	var res bulkResult
	srv.Admin.Post("/api/admin-tokens/bulk/revoke", map[string]any{"items": []string{"agent-1", "bootstrap"}}).Expect(200).JSON(&res)
	if res.Succeeded != 1 || res.Items[1].Error == nil || res.Items[1].Error.Code != "last_admin_token" {
		t.Fatalf("bulk revoke of every token = %+v", res)
	}
	srv.Admin.Get("/api/whoami").Expect(200)
}

func TestTheLastAdminTokenCanGoOnceTheOwnerCanSignIn(t *testing.T) {
	srv := testkit.Start(t)
	owner := srv.OwnerSession() // sets the Owner password
	srv.Admin.Post("/api/admin-tokens/bootstrap/revoke", nil).Expect(200)
	srv.Admin.Get("/api/whoami").Expect(401)
	// The Owner is not locked out: the session issues a new token.
	var created tokenResult
	owner.Post("/api/admin-tokens", map[string]any{"name": "agent-2"}).Expect(201).JSON(&created)
	srv.Client(created.AdminToken.Secret).Get("/api/whoami").Expect(200)
}
