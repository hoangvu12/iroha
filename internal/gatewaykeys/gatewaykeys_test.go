package gatewaykeys_test

import (
	"strings"
	"testing"

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

	// A scope names Providers by handle or ID and answers with handles.
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
	// Readable by name or ID, any time.
	for _, ref := range []string{"friend", friend.GatewayKey.ID} {
		var got gatewaykeys.GatewayKey
		srv.Admin.Get("/api/gateway-keys/" + ref).Expect(200).JSON(&got)
		if got.Secret != friend.GatewayKey.Secret || got.Scope.Providers[0].Provider != "acme" {
			t.Fatalf("read %s = %+v", ref, got)
		}
	}
	// Repeating the create is safe; a new scope updates it.
	var again, narrowed gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend"}).Expect(200).JSON(&again)
	if again.Outcome != "unchanged" || again.GatewayKey.Secret != friend.GatewayKey.Secret {
		t.Fatalf("repeat = %+v", again)
	}
	srv.Admin.Patch("/api/gateway-keys/friend", map[string]any{"scope": map[string]any{"providers": []any{map[string]any{"provider": "acme"}}}}).Expect(200).JSON(&narrowed)
	if narrowed.Outcome != "updated" || len(narrowed.GatewayKey.Scope.Providers) != 1 {
		t.Fatalf("patch = %+v", narrowed)
	}
	// Scope changes are revertible.
	srv.Admin.Post("/api/audit-entries/"+narrowed.AuditEntry+"/revert", nil).Expect(200)
	var reverted gatewaykeys.GatewayKey
	srv.Admin.Get("/api/gateway-keys/friend").Expect(200).JSON(&reverted)
	if len(reverted.Scope.Providers) != 2 {
		t.Fatalf("after revert = %+v", reverted.Scope)
	}

	// Revoke: permanent, and the name is not issued again.
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

	// Bulk issue and revoke.
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
