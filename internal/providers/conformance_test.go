package providers_test

import (
	"strings"
	"testing"

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
