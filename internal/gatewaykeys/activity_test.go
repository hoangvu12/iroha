package gatewaykeys_test

import (
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func keyNamed(t *testing.T, srv *testkit.Server, name string) gatewaykeys.GatewayKey {
	t.Helper()
	var list gatewaykeys.GatewayKeyList
	srv.Admin.Get("/api/gateway-keys").Expect(200).JSON(&list)
	for _, k := range list.GatewayKeys {
		if k.Name == name {
			return k
		}
	}
	t.Fatalf("no key %s in %+v", name, list)
	return gatewaykeys.GatewayKey{}
}

func TestGatewayKeysShowLastUseAndRecentRequests(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-acme"}).Expect(201)

	var made gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "linh", "scope": map[string]any{"all": true}}).Expect(201).JSON(&made)
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "idle", "scope": map[string]any{"all": true}}).Expect(201)
	if made.GatewayKey.RecentRequests != 0 || made.GatewayKey.LastUsedAt != nil {
		t.Fatalf("new key = %+v", made.GatewayKey)
	}

	caller := srv.Client(made.GatewayKey.Secret)
	chat := map[string]any{"model": "m", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}
	up.Enqueue(up.Text("one"), up.Text("two"))
	caller.Post("/providers/acme/v1/chat/completions", chat).Expect(200)
	caller.Post("/providers/acme/v1/chat/completions", chat).Expect(200)

	k := keyNamed(t, srv, "linh")
	if k.RecentRequests != 2 || k.LastUsedAt == nil || !k.LastUsedAt.Equal(srv.Clock.Now().Truncate(time.Millisecond)) {
		t.Fatalf("after 2 Requests: recent %d, last used %v (now %v)", k.RecentRequests, k.LastUsedAt, srv.Clock.Now())
	}
	if idle := keyNamed(t, srv, "idle"); idle.RecentRequests != 0 || idle.LastUsedAt != nil {
		t.Fatalf("idle = %+v", idle)
	}
	var one gatewaykeys.GatewayKey
	srv.Admin.Get("/api/gateway-keys/linh").Expect(200).JSON(&one)
	if one.RecentRequests != 2 {
		t.Fatalf("read one: recent %d", one.RecentRequests)
	}

	srv.Clock.Advance(24*time.Hour + time.Minute)
	up.Enqueue(up.Text("three"))
	caller.Post("/providers/acme/v1/chat/completions", chat).Expect(200)
	if k := keyNamed(t, srv, "linh"); k.RecentRequests != 1 || !k.LastUsedAt.Equal(srv.Clock.Now().Truncate(time.Millisecond)) {
		t.Fatalf("a day later: recent %d, last used %v", k.RecentRequests, k.LastUsedAt)
	}
}

func TestDeletingAGatewayKeyIsRevertible(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	var made gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend", "capture": true,
		"scope": map[string]any{"providers": []any{map[string]any{"provider": "acme", "models": []string{"glm-4.6"}}}}}).Expect(201).JSON(&made)

	srv.Admin.Delete("/api/gateway-keys/friend?dry_run=true").Expect(200)
	srv.Admin.Get("/api/gateway-keys/friend").Expect(200)

	var del gatewaykeys.GatewayKeyResult
	srv.Admin.Delete("/api/gateway-keys/friend").Expect(200).JSON(&del)
	if del.Outcome != "deleted" || del.AuditEntry == "" || del.GatewayKey.Name != "friend" {
		t.Fatalf("delete = %+v", del)
	}
	srv.Admin.Get("/api/gateway-keys/friend").Expect(404)
	srv.Client(made.GatewayKey.Secret).Get("/providers/acme/v1/models").Expect(401)

	srv.Admin.Post("/api/audit-entries/"+del.AuditEntry+"/revert", nil).Expect(200)
	var back gatewaykeys.GatewayKey
	srv.Admin.Get("/api/gateway-keys/friend").Expect(200).JSON(&back)
	if back.ID != made.GatewayKey.ID || back.Secret != made.GatewayKey.Secret || !back.Capture ||
		len(back.Scope.Providers) != 1 || back.Scope.Providers[0].Models[0] != "glm-4.6" {
		t.Fatalf("after revert = %+v", back)
	}

	srv.Admin.Post("/api/gateway-keys/friend/revoke", nil).Expect(200)
	srv.Admin.Delete("/api/gateway-keys/friend").Expect(200)
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend", "scope": map[string]any{"all": true}}).Expect(201)
	srv.Admin.Delete("/api/gateway-keys/nope").Expect(404)
}
