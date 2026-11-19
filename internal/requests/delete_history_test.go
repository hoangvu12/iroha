package requests_test

import (
	"testing"

	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// KEY-14: deleting a Gateway Key never removes its history: its Requests keep
// the Caller's name and key ID, and caller=<key ID> still finds them.
func TestDeletingAGatewayKeyKeepsItsRequests(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, up.URL())
	var key gatewaykeys.GatewayKeyResult
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "friend", "scope": map[string]any{"all": true}}).Expect(201).JSON(&key)
	friend := srv.Client(key.GatewayKey.Secret)
	id := friend.Post(chatPath, `{"model":"gpt-x","messages":[{"role":"user","content":"hi"}]}`).Expect(200).Header.Get("X-Request-Id")

	srv.Admin.Post("/api/gateway-keys/friend/revoke", nil).Expect(200)
	srv.Admin.Delete("/api/gateway-keys/friend").Expect(200)
	srv.Admin.Get("/api/gateway-keys/friend").Expect(404)

	if r := request(t, srv, id); r.Caller.Name != "friend" || r.Caller.GatewayKeyID != key.GatewayKey.ID || len(r.Attempts) != 1 {
		t.Fatalf("request after the key was deleted = %+v", r)
	}
	var page requests.RequestPage
	srv.Admin.Get("/api/requests?caller=" + key.GatewayKey.ID).Expect(200).JSON(&page)
	if len(page.Requests) != 1 || page.Requests[0].ID != id {
		t.Fatalf("caller=<deleted key ID> = %+v", page.Requests)
	}
}
