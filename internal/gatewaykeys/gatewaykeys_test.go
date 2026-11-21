package gatewaykeys_test

import (
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestGatewayKeysAreIssuedReadableScopedAndRevoked(t *testing.T) {
	srv := testkit.Start(t)
	var acme struct {
		Provider struct{ ID string } `json:"provider"`
	}
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201).JSON(&acme)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "other"}).Expect(201)

	for _, body := range []map[string]any{
		{"name": "friend"},
		{"name": "friend", "scope": map[string]any{"all": true, "providers": []any{map[string]any{"provider": "acme"}}}},
		{"name": "friend", "scope": map[string]any{"providers": []any{map[string]any{"provider": "acme", "models": []string{" "}}}}},
		{"name": "bad name", "scope": map[string]any{"all": true}},
	} {
		if e := srv.Admin.Post("/api/gateway-keys", body).Expect(400).Err(); e.Hint == "" {
			t.Errorf("%v: no hint", body)
		}
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend", "scope": map[string]any{"providers": []any{map[string]any{"provider": "nope"}}}}).Expect(404)

	var all gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "zeron-fleet", "scope": map[string]any{"all": true}}).Expect(201).JSON(&all)
	if !strings.HasPrefix(all.GatewayKey.Secret, gatewaykeys.SecretPrefix+"_") || !all.GatewayKey.Scope.All {
		t.Fatalf("all = %+v", all)
	}
	if strings.Contains(string(all.Changes[0].After), all.GatewayKey.Secret) {
		t.Fatal("the change shows the whole secret")
	}

	var friend gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend", "scope": map[string]any{"providers": []any{
		map[string]any{"provider": acme.Provider.ID, "models": []string{"glm-4.6", " glm-4.6 ", "kimi-k2"}},
		map[string]any{"provider": "other"},
	}}}).Expect(201).JSON(&friend)
	sc := friend.GatewayKey.Scope
	if sc.All || len(sc.Providers) != 2 || sc.Providers[0].Provider != "acme" || strings.Join(sc.Providers[0].Models, ",") != "glm-4.6,kimi-k2" ||
		sc.Providers[1].Provider != "other" || sc.Providers[1].Models != nil {
		t.Fatalf("scope = %+v", sc)
	}
	for _, ref := range []string{"friend", friend.GatewayKey.ID} {
		var got gatewaykeys.GatewayKey
		srv.Admin.Get("/api/gateway-keys/" + ref).Expect(200).JSON(&got)
		if got.Secret != friend.GatewayKey.Secret || got.Scope.Providers[0].Provider != "acme" {
			t.Fatalf("read %s = %+v", ref, got)
		}
	}
	var again, narrowed gatewaykeys.GatewayKeyResult
	if e := srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend", "scope": map[string]any{"all": true}}).Expect(409).Err(); e.Code != "name_taken" {
		t.Fatalf("second issue = %+v", e)
	}
	srv.Admin.Put("/api/gateway-keys/friend", map[string]any{"name": "friend"}).Expect(200).JSON(&again)
	if again.Outcome != "unchanged" || again.GatewayKey.Secret != friend.GatewayKey.Secret {
		t.Fatalf("repeat = %+v", again)
	}
	srv.Admin.Patch("/api/gateway-keys/friend", map[string]any{"scope": map[string]any{"providers": []any{map[string]any{"provider": "acme"}}}}).Expect(200).JSON(&narrowed)
	if narrowed.Outcome != "updated" || len(narrowed.GatewayKey.Scope.Providers) != 1 {
		t.Fatalf("patch = %+v", narrowed)
	}
	srv.Admin.Post("/api/audit-entries/"+narrowed.AuditEntry+"/revert", nil).Expect(200)
	var reverted gatewaykeys.GatewayKey
	srv.Admin.Get("/api/gateway-keys/friend").Expect(200).JSON(&reverted)
	if len(reverted.Scope.Providers) != 2 {
		t.Fatalf("after revert = %+v", reverted.Scope)
	}

	var revoked gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys/friend/revoke", nil).Expect(200).JSON(&revoked)
	if !revoked.GatewayKey.Revoked || revoked.AuditEntry == "" {
		t.Fatalf("revoke = %+v", revoked)
	}
	if e := srv.Admin.Post("/api/audit-entries/"+revoked.AuditEntry+"/revert", nil).Expect(409).Err(); e.Code != "audit_irreversible" {
		t.Fatalf("revert a revoke: %+v", e)
	}
	if e := srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend", "scope": map[string]any{"all": true}}).Expect(409).Err(); e.Code != "gateway_key_revoked" {
		t.Fatalf("reissue: %+v", e)
	}
	var list gatewaykeys.GatewayKeyList
	srv.Admin.Get("/api/gateway-keys?revoked=false").Expect(200).JSON(&list)
	if len(list.GatewayKeys) != 1 || list.GatewayKeys[0].Name != "zeron-fleet" {
		t.Fatalf("active = %+v", list)
	}

	var bulk struct{ Succeeded, Failed int }
	srv.Admin.Post("/api/gateway-keys/bulk", map[string]any{"items": []any{
		map[string]any{"name": "a", "scope": map[string]any{"all": true}}, map[string]any{"name": "b"},
	}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 1 || bulk.Failed != 1 {
		t.Fatalf("bulk = %+v", bulk)
	}
	srv.Admin.Post("/api/gateway-keys/bulk/revoke", map[string]any{"items": []string{"a", "zeron-fleet"}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 2 {
		t.Fatalf("bulk revoke = %+v", bulk)
	}
}

func TestARevokedGatewayKeyStaysRevokedAndCannotBeEdited(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend", "scope": map[string]any{"all": true}}).Expect(201)
	var first, second gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys/friend/revoke", nil).Expect(200).JSON(&first)
	if first.Outcome != "updated" || first.AuditEntry == "" || !first.GatewayKey.Revoked {
		t.Fatalf("revoke = %+v", first)
	}
	srv.Admin.Post("/api/gateway-keys/friend/revoke", nil).Expect(200).JSON(&second)
	if second.Outcome != "unchanged" || second.AuditEntry != "" || !second.GatewayKey.Revoked {
		t.Fatalf("second revoke = %+v", second)
	}
	for _, body := range []map[string]any{
		{"name": "friend-2"},
		{"scope": map[string]any{"all": true}},
		{"capture": true},
	} {
		e := srv.Admin.Patch("/api/gateway-keys/friend", body).Expect(409).Err()
		if e.Code != "gateway_key_revoked" || e.Hint == "" {
			t.Errorf("PATCH %v: %+v", body, e)
		}
	}
	var entries struct{ Entries []struct{ ID string } }
	srv.Admin.Get("/api/audit-entries?record=friend").Expect(200).JSON(&entries)
	if len(entries.Entries) != 2 {
		t.Fatalf("audit entries = %+v", entries.Entries)
	}
	var k gatewaykeys.GatewayKey
	srv.Admin.Get("/api/gateway-keys/friend").Expect(200).JSON(&k)
	if !k.Revoked || k.Name != "friend" || k.Capture {
		t.Fatalf("after refused edits = %+v", k)
	}
	if e := srv.Client(k.Secret).Get("/v1/models").Expect(401).Err(); e.Code != "gateway_key_invalid" {
		t.Fatalf("revoked key on /v1/models: %+v", e)
	}
}

func TestLastUsedIsRecordedOnSuccessfulUseToTheMinute(t *testing.T) {
	srv := testkit.Start(t)
	var issued gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend", "scope": map[string]any{"all": true}}).Expect(201).JSON(&issued)
	lastUsed := func() *time.Time {
		t.Helper()
		var k gatewaykeys.GatewayKey
		srv.Admin.Get("/api/gateway-keys/friend").Expect(200).JSON(&k)
		return k.LastUsedAt
	}
	if at := lastUsed(); at != nil {
		t.Fatalf("last used before any use = %v", at)
	}
	friend := srv.Client(issued.GatewayKey.Secret)

	srv.Client(issued.GatewayKey.Secret + "x").Get("/v1/models").Expect(401)
	if at := lastUsed(); at != nil {
		t.Fatalf("last used after a refused key = %v", at)
	}
	friend.Get("/v1/models").Expect(200)
	if at := lastUsed(); at == nil || !at.Equal(testkit.Epoch) {
		t.Fatalf("last used after a call = %v, want %v", at, testkit.Epoch)
	}
	srv.Clock.Advance(59 * time.Second)
	friend.Get("/v1/models").Expect(200)
	if at := lastUsed(); !at.Equal(testkit.Epoch) {
		t.Fatalf("rewritten within the minute: %v", at)
	}
	srv.Clock.Advance(time.Second)
	srv.Anon.WithHeader("x-api-key", issued.GatewayKey.Secret).Get("/v1/models").Expect(200)
	if at := lastUsed(); !at.Equal(testkit.Epoch.Add(time.Minute)) {
		t.Fatalf("last used a minute later = %v", at)
	}
	srv.Admin.Post("/api/gateway-keys/friend/revoke", nil).Expect(200)
	srv.Clock.Advance(time.Hour)
	friend.Get("/v1/models").Expect(401)
	if at := lastUsed(); !at.Equal(testkit.Epoch.Add(time.Minute)) {
		t.Fatalf("last used after a revoked use = %v", at)
	}
}
