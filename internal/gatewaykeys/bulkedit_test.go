package gatewaykeys_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestManyGatewayKeysAreEditedInOneRevertibleCall(t *testing.T) {
	srv := testkit.Start(t)
	all := map[string]any{"all": true}
	var a gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "a", "scope": all}).Expect(201).JSON(&a)
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "b", "scope": all, "capture": true}).Expect(201)
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "old", "scope": all}).Expect(201)
	srv.Admin.Post("/api/gateway-keys/old/revoke", nil).Expect(200)

	var res audit.BulkResult[gatewaykeys.GatewayKey]
	srv.Admin.Post("/api/gateway-keys/bulk/update", map[string]any{"items": []any{
		map[string]any{"key": a.GatewayKey.ID, "capture": true},
		map[string]any{"key": "b", "capture": true},
		map[string]any{"key": "old", "capture": true},
		map[string]any{"key": "nope", "capture": true},
	}}).Expect(200).JSON(&res)
	if res.Succeeded != 2 || res.Failed != 2 || res.AuditEntry == "" {
		t.Fatalf("bulk update = %+v", res)
	}
	if res.Items[0].Outcome != "updated" || res.Items[1].Outcome != "unchanged" {
		t.Fatalf("outcomes = %+v", res.Items)
	}
	if e := res.Items[2].Error; e == nil || e.Code != "gateway_key_revoked" {
		t.Fatalf("revoked item = %+v", res.Items[2])
	}
	if e := res.Items[3].Error; e == nil || e.Code != "not_found" {
		t.Fatalf("missing item = %+v", res.Items[3])
	}
	var k gatewaykeys.GatewayKey
	srv.Admin.Get("/api/gateway-keys/a").Expect(200).JSON(&k)
	if !k.Capture || !k.Scope.All {
		t.Fatalf("a = %+v", k)
	}
	srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(200)
	srv.Admin.Get("/api/gateway-keys/a").Expect(200).JSON(&k)
	if k.Capture {
		t.Fatalf("after revert a = %+v", k)
	}
	srv.Admin.Post("/api/gateway-keys/bulk/update", map[string]any{"items": []any{map[string]any{"key": "a", "name": "z"}}}).Expect(400)
	srv.Admin.Post("/api/gateway-keys/bulk/update", map[string]any{"items": []any{map[string]any{"key": "a", "scope": all}}}).Expect(400)
}
