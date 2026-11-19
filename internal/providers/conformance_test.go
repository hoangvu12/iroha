package providers_test

import (
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// PRV-23: a Provider's display name is 1 to 128 printable characters; blank,
// too long and control characters are refused with a hint.
func TestProviderDisplayNamesAreOneTo128PrintableCharacters(t *testing.T) {
	srv := testkit.Start(t)
	for _, bad := range []string{"", "   ", strings.Repeat("n", 129), "Z.ai\x07plan", "line\nbreak"} {
		e := srv.Admin.Post("/api/providers", map[string]any{"handle": "acme", "name": bad}).Expect(400).Err()
		if !strings.Contains(e.Hint, "128") {
			t.Errorf("name %q: %+v", bad, e)
		}
	}
	var p providers.ProviderResult
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme", "name": strings.Repeat("n", 128)}).Expect(201).JSON(&p)
	if len(p.Provider.Name) != 128 {
		t.Fatalf("name = %q", p.Provider.Name)
	}
	for _, bad := range []string{" ", strings.Repeat("n", 129), "tab\there"} {
		srv.Admin.Patch("/api/providers/acme", map[string]any{"name": bad}).Expect(400)
	}
	srv.Admin.Patch("/api/providers/acme", map[string]any{"name": "Acme relay"}).Expect(200)
}

// PRV-10, RED-02: the same secret is accepted on a second Provider but
// refused twice within one, and the 409 never echoes the secret.
func TestTheSameSecretIsAcceptedOnAnotherProviderButRefusedTwiceWithinOne(t *testing.T) {
	const secret = "sk-test-shared-5555"
	srv := testkit.Start(t)
	for _, h := range []string{"acme", "other"} {
		srv.Admin.Post("/api/providers", map[string]any{"handle": h}).Expect(201)
	}
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": secret}).Expect(201)
	var k providers.UpstreamKeyResult
	srv.Admin.Post("/api/providers/other/keys", map[string]any{"name": "team", "secret": secret}).Expect(201).JSON(&k)
	if k.UpstreamKey.Provider != "other" || k.UpstreamKey.Secret != secret {
		t.Fatalf("second Provider's key = %+v", k.UpstreamKey)
	}

	// Within acme: a new name with the same secret, and a key changed to it.
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-mine-6666"}).Expect(201)
	for _, r := range []*testkit.Response{
		srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "again", "secret": secret}).Expect(409),
		srv.Admin.Patch("/api/providers/acme/keys/key-2", map[string]any{"secret": secret}).Expect(409),
	} {
		if e := r.Err(); e.Code != "upstream_key_duplicate" || !strings.Contains(e.Hint, "key-1") {
			t.Fatalf("duplicate = %+v", e)
		}
		if strings.Contains(r.Text(), secret) {
			t.Fatalf("the 409 echoes the secret: %s", r.Text())
		}
	}
	var bulk keyBulk
	resp := srv.Admin.Post("/api/providers/acme/keys/bulk", map[string]any{"items": []any{map[string]any{"name": "third", "secret": secret}}}).Expect(200)
	resp.JSON(&bulk)
	if bulk.Failed != 1 || bulk.Items[0].Error.Code != "upstream_key_duplicate" || strings.Contains(resp.Text(), secret) {
		t.Fatalf("bulk duplicate = %s", resp.Text())
	}
	var list providers.UpstreamKeyList
	srv.Admin.Get("/api/providers/acme/keys").Expect(200).JSON(&list)
	if len(list.UpstreamKeys) != 2 || list.UpstreamKeys[1].Secret != "sk-test-mine-6666" {
		t.Fatalf("acme's keys = %+v", list.UpstreamKeys)
	}
}

// SCR-11: one URL and Shape is one Endpoint per Provider. Without a name a
// create matches the Endpoint by URL and Shape (as keys match by secret), so
// re-running a script updates it; under another name, in bulk, by PATCH or by
// reverting a delete the duplicate is refused with 409 endpoint_duplicate
// naming the Endpoint that has it. The same URL in another Shape is fine.
func TestAnEndpointURLAndShapeIsHeldOnceWithinAProvider(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	base := "/api/providers/acme/endpoints"
	const a, b = "https://api.example.com/v1", "https://eu.example.com/v1"
	srv.Admin.Post(base, map[string]any{"url": a, "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post(base, map[string]any{"name": "eu", "url": b, "shape": "openai-chat"}).Expect(201)

	// No name: matched by URL and Shape, not moved onto "default".
	var again providers.EndpointResult
	srv.Admin.Post(base, map[string]any{"url": b + "/", "shape": "openai-chat"}).Expect(200).JSON(&again)
	if again.Outcome != "unchanged" || again.Endpoint.Name != "eu" {
		t.Fatalf("repeat without a name = %+v", again)
	}
	var renamed providers.EndpointResult
	srv.Admin.Post(base, map[string]any{"url": "HTTPS://EU.example.com/v1", "shape": "openai-chat", "renames": map[string]string{"glm": "glm-fp8"}}).Expect(200).JSON(&renamed)
	if renamed.Outcome != "updated" || renamed.Endpoint.Name != "eu" || renamed.Endpoint.Renames["glm"] != "glm-fp8" {
		t.Fatalf("update by URL and Shape = %+v", renamed)
	}

	duplicate := func(r *testkit.Response, holder string) {
		t.Helper()
		if e := r.Expect(409).Err(); e.Code != "endpoint_duplicate" || !strings.Contains(e.Hint, holder) {
			t.Fatalf("duplicate = %+v", e)
		}
	}
	duplicate(srv.Admin.Post(base, map[string]any{"name": "again", "url": "https://API.example.com/v1/", "shape": "openai-chat"}), "default")
	duplicate(srv.Admin.Patch(base+"/eu", map[string]any{"url": a}), "default")
	srv.Admin.Post(base, map[string]any{"name": "messages", "url": a, "shape": "anthropic-messages"}).Expect(201)
	duplicate(srv.Admin.Patch(base+"/messages", map[string]any{"shape": "openai-chat"}), "default")

	var bulk audit.BulkResult[providers.Endpoint]
	srv.Admin.Post(base+"/bulk", map[string]any{"items": []any{
		map[string]any{"name": "copy", "url": b, "shape": "openai-chat"},
		map[string]any{"name": "us", "url": "https://us.example.com/v1", "shape": "openai-chat"},
		map[string]any{"name": "us-2", "url": "https://us.example.com/v1", "shape": "openai-chat"},
		map[string]any{"url": a, "shape": "openai-chat"},
	}}).Expect(200).JSON(&bulk)
	if bulk.Failed != 2 || bulk.Items[0].Error.Code != "endpoint_duplicate" || bulk.Items[2].Error.Code != "endpoint_duplicate" ||
		bulk.Items[1].Outcome != "created" || bulk.Items[3].Outcome != "unchanged" {
		t.Fatalf("bulk = %+v", bulk)
	}

	// A delete cannot be reverted onto a URL another Endpoint took since.
	var deleted providers.EndpointResult
	srv.Admin.Delete(base + "/us").Expect(200).JSON(&deleted)
	srv.Admin.Post(base, map[string]any{"name": "us-new", "url": "https://us.example.com/v1", "shape": "openai-chat"}).Expect(201)
	duplicate(srv.Admin.Post("/api/audit-entries/"+deleted.AuditEntry+"/revert", nil), "us-new")

	var list providers.EndpointList
	srv.Admin.Get(base).Expect(200).JSON(&list)
	if len(list.Endpoints) != 4 { // default, eu, messages, us-new
		t.Fatalf("endpoints = %+v", list.Endpoints)
	}
}

// MOD-13: renames {} clears an Endpoint's renames, so the Caller's model
// name goes upstream unchanged again.
func TestEmptyRenamesClearTheSetSoTheCallersNameIsSent(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat",
		"renames": map[string]string{"glm-4.6": "glm-4.6-fp8"}}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-one"}).Expect(201)
	var gk struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "pi", "scope": map[string]any{"all": true}}).Expect(201).JSON(&gk)
	caller := srv.Client(gk.GatewayKey.Secret)
	send := func() string {
		t.Helper()
		caller.Post("/providers/acme/v1/chat/completions", map[string]any{"model": "glm-4.6", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).Expect(200)
		return up.Last().Model
	}

	if got := send(); got != "glm-4.6-fp8" {
		t.Fatalf("renamed model sent = %q", got)
	}
	srv.Admin.Patch("/api/providers/acme/endpoints/default", map[string]any{"renames": map[string]string{}}).Expect(200)
	if got := send(); got != "glm-4.6" {
		t.Fatalf("model sent after clearing renames = %q", got)
	}
}
