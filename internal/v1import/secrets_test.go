package v1import_test

import (
	"fmt"
	"maps"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// v1Row is one v1 upstream_keys row of the Provider deepaiLike adds; base ""
// is the Provider's own base URL, secret "" an empty-secret (keyless) row.
type v1Row struct{ base, secret string }

// deepaiLike adds the v1 Provider "deepai-like" as production v1 held DeepAI,
// MiniMax and Z.ai after keyless relay Endpoints were added: requires_upstream_key
// = 0, auth header authorization with prefix "Bearer ", static headers set
// (encrypted), and key rows with real secrets.
func deepaiLike(f *fixture, base string, headers string, rows ...v1Row) {
	f.extraKeySQL = append(f.extraKeySQL, fmt.Sprintf(`INSERT INTO providers (id, handle, display_name, base_url, allow_insecure_http, enabled, template_id, capabilities,
		auth_header, auth_prefix, requires_upstream_key, static_headers_encrypted, created_at, updated_at)
		VALUES ('p9', 'deepai-like', 'DeepAI-like', '%s', 1, 1, 'deepai-code', '{}', 'authorization', 'Bearer ', 0, '%s', 9, 9)`, base, enc(headers)))
	for i, r := range rows {
		f.extraKeySQL = append(f.extraKeySQL, fmt.Sprintf(`INSERT INTO upstream_keys (id, provider_id, base_url, encrypted_key, health, created_at, updated_at)
			VALUES ('kd%d', 'p9', %s, '%s', 'active', %d, %d)`, i, nullable(r.base), enc(r.secret), 100+i, 100+i))
	}
}

func init() {
	fakeSecrets = append(fakeSecrets, "sk-test-deep-1", "sk-test-deep-2", "sk-test-deep-3", "sk-test-mix-1", "sk-test-mix-2",
		"sk-test-fix-1", "sk-test-fix-2", "hdr-test-transport", "hdr-test-auth")
}

const transportHeaders = `[{"name":"X-Transport","value":"hdr-test-transport"},{"name":"Authorization","value":"hdr-test-auth"}]`

// gated answers only requests carrying one of secrets as a Bearer token and
// the transport header, like DeepAI's proxy (401 without the key, 403 without
// the transport header); keyless requests pass when allowKeyless.
func gated(up *testkit.Upstream, allowKeyless bool, next testkit.Responder, secrets ...string) testkit.Responder {
	return func(r *testkit.Received) testkit.Reply {
		if r.Header.Get("X-Transport") != "hdr-test-transport" {
			return up.Error(http.StatusForbidden, "Model transport authentication required.")(r)
		}
		b := r.Bearer()
		if !slices.Contains(secrets, b) && !(allowKeyless && r.Header.Get("Authorization") == "") {
			return up.Error(http.StatusUnauthorized, "bad key")(r)
		}
		return next(r)
	}
}

func friendOne(t *testing.T, srv *testkit.Server) *testkit.Client {
	t.Helper()
	var gl gatewaykeys.GatewayKeyList
	srv.Admin.Get("/api/gateway-keys").OK().JSON(&gl)
	for _, k := range gl.GatewayKeys {
		if k.Name == "friend-one" {
			return srv.Client(k.Secret)
		}
	}
	t.Fatal("no Gateway Key friend-one")
	return nil
}

func chat(c *testkit.Client, handle string) *testkit.Response {
	return c.Post("/providers/"+handle+"/v1/chat/completions", map[string]any{"model": "deep-model", "messages": []any{map[string]any{"role": "user", "content": "hi"}}})
}

func keysOf(t *testing.T, srv *testkit.Server, handle string) map[string]providers.UpstreamKey {
	t.Helper()
	var kl providers.UpstreamKeyList
	srv.Admin.Get("/api/providers/" + handle + "/keys").OK().JSON(&kl)
	out := map[string]providers.UpstreamKey{}
	for _, k := range kl.UpstreamKeys {
		out[k.Name] = k
	}
	return out
}

// A v1 Provider with requires_upstream_key = 0 whose key rows hold real
// secrets imports them as secret keys (v1 sent a key whenever its row had
// one, whatever the flag), and Attempts and discovery send them with v1's
// auth header, prefix and static headers.
func TestKeysOfAProviderNeedingNoKeyKeepTheirSecrets(t *testing.T) {
	srv, f := start(t)
	up := testkit.NewOpenAIChat(t)
	secrets := []string{"sk-test-deep-1", "sk-test-deep-2", "sk-test-deep-3"}
	deepaiLike(f, up.URL(), transportHeaders, v1Row{"", secrets[0]}, v1Row{"", secrets[1]}, v1Row{"", secrets[2]})
	up.Default(gated(up, false, up.Text("hello"), secrets...))
	up.Handle(http.MethodGet, "/v1/models", gated(up, false, testkit.JSON(200, map[string]any{"object": "list", "data": []any{map[string]any{"id": "deep-model", "object": "model"}}}), secrets...))
	path := newV1(t, f)

	rep, out := importV1(t, srv, path, true)
	if rep.Failed() != 0 {
		t.Fatalf("report %+v\n%s", rep, out)
	}
	keys := keysOf(t, srv, "deepai-like")
	var got []string
	for _, k := range keys {
		got = append(got, k.Secret)
	}
	slices.Sort(got)
	if !slices.Equal(got, secrets) {
		t.Fatalf("deepai-like keys are not the 3 v1 secrets; names %v", slices.Sorted(maps.Keys(keys)))
	}

	// GET /api/providers/deepai-like shows the Endpoint with v1's auth style
	// and static headers; the one named like the auth header, which v1 never
	// sent, is left out and noted.
	var p providers.Provider
	srv.Admin.Get("/api/providers/deepai-like").OK().JSON(&p)
	if len(p.Endpoints) != 1 || p.Endpoints[0].AuthStyle != "bearer" || p.Endpoints[0].StaticHeaders["X-Transport"] != "hdr-test-transport" || len(p.Endpoints[0].StaticHeaders) != 1 {
		t.Fatalf("deepai-like Endpoints %+v", p.Endpoints)
	}
	if !strings.Contains(out, "static headers X-Transport (values redacted)") || !strings.Contains(out, "Static headers named like the Provider's auth header") {
		t.Errorf("output does not describe the static headers:\n%s", out)
	}

	caller := friendOne(t, srv)
	for i := 0; i < 3; i++ {
		chat(caller, "deepai-like").OK()
	}
	srv.Admin.Post("/api/providers/deepai-like/models/refresh", nil).OK()
	var sawList bool
	for _, r := range up.Requests() {
		if !slices.Contains(secrets, r.Bearer()) || r.Header.Get("X-Transport") != "hdr-test-transport" {
			t.Errorf("%s %s reached the upstream without the key or the static header", r.Method, r.Path)
		}
		sawList = sawList || r.Method == http.MethodGet
	}
	if !sawList {
		t.Error("discovery did not reach the upstream")
	}
	var models struct {
		Models []struct {
			Model string `json:"model"`
		} `json:"models"`
	}
	srv.Admin.Get("/api/providers/deepai-like/models").OK().JSON(&models)
	if len(models.Models) != 1 || models.Models[0].Model != "deep-model" {
		t.Errorf("discovered models %+v", models.Models)
	}
}

// Mixed rows: rows with a secret become secret keys, only empty rows become
// keyless slots. The production pattern: real keys on the Provider's base URL,
// empty-secret rows on a keyless relay URL. Both Endpoints carry v1's auth
// style; the relay gets no credential because its keys have none.
func TestMixedKeyRowsGiveKeylessSlotsOnlyForEmptySecrets(t *testing.T) {
	srv, f := start(t)
	keyed, relay := testkit.NewOpenAIChat(t), testkit.NewOpenAIChat(t)
	secrets := []string{"sk-test-mix-1", "sk-test-mix-2"}
	deepaiLike(f, keyed.URL(), transportHeaders,
		v1Row{"", secrets[0]}, v1Row{relay.URL(), ""}, v1Row{"", secrets[1]}, v1Row{relay.URL(), ""})
	keyed.Default(gated(keyed, false, keyed.Text("hello"), secrets...))
	relay.Default(gated(relay, true, relay.Text("hello")))
	path := newV1(t, f)

	rep, out := importV1(t, srv, path, true)
	if rep.Failed() != 0 {
		t.Fatalf("report %+v\n%s", rep, out)
	}
	keys := keysOf(t, srv, "deepai-like")
	if len(keys) != 4 || keys["keyless"].Secret != "" || keys["keyless-2"].Secret != "" ||
		!slices.Equal(keys["keyless"].Endpoints, []string{"127.0.0.1"}) || !slices.Equal(keys["keyless-2"].Endpoints, []string{"127.0.0.1"}) {
		var desc []string
		for n, k := range keys {
			desc = append(desc, fmt.Sprintf("%s(secret %t, %v)", n, k.Secret != "", k.Endpoints))
		}
		t.Fatalf("deepai-like has keys %v", desc)
	}
	n := 0
	for _, k := range keys {
		if slices.Contains(secrets, k.Secret) && slices.Equal(k.Endpoints, []string{"default"}) {
			n++
		}
	}
	if n != 2 {
		t.Errorf("%d of the secret keys are restricted to default", n)
	}
	var p providers.Provider
	srv.Admin.Get("/api/providers/deepai-like").OK().JSON(&p)
	for _, e := range p.Endpoints {
		if e.AuthStyle != "bearer" || e.StaticHeaders["X-Transport"] != "hdr-test-transport" {
			t.Errorf("Endpoint %s: auth %s, static headers %v", e.Name, e.AuthStyle, e.StaticHeaders)
		}
	}

	srv.Admin.Patch("/api/providers/deepai-like", map[string]any{"affinity": "off"}).OK() // keys in turn, so every key is reached
	caller := friendOne(t, srv)
	for i := 0; i < 8; i++ {
		chat(caller, "deepai-like").OK()
	}
	for _, r := range keyed.Requests() {
		if !slices.Contains(secrets, r.Bearer()) {
			t.Errorf("the keyed Endpoint got a request without a v1 secret")
		}
	}
	for _, r := range relay.Requests() {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("the keyless relay got a credential")
		}
	}
	if keyed.Count() == 0 || relay.Count() == 0 {
		t.Errorf("requests: keyed %d, relay %d", keyed.Count(), relay.Count())
	}
}

// The Owner re-runs the import against a v2 that got the earlier, buggy
// import: every row of deepai-like became a keyless slot keyless, keyless-2,
// ... The re-run adds the secret keys, keeps the slot an empty row still maps
// to, deletes the other slots in one revertible Audit Entry, and leaves keys
// it did not make alone. A third run changes nothing.
func TestReRunningRepairsKeylessSlotsOfAnEarlierImport(t *testing.T) {
	srv, f := start(t)
	up := testkit.NewOpenAIChat(t)
	secrets := []string{"sk-test-fix-1", "sk-test-fix-2"}
	deepaiLike(f, up.URL(), `[{"name":"X-Transport","value":"hdr-test-transport"}]`, v1Row{"", secrets[0]}, v1Row{"", ""}, v1Row{"", secrets[1]})
	up.Default(gated(up, true, up.Text("hello"), secrets...))
	path := newV1(t, f)

	// What the buggy import left: the Provider, its Endpoint, one empty slot
	// per v1 row; plus a keyless key and a keyed slot the Owner made by hand.
	srv.Admin.Post("/api/providers", map[string]any{"handle": "deepai-like", "name": "DeepAI-like", "discovery": "provider"}).Expect(201)
	srv.Admin.Post("/api/providers/deepai-like/endpoints", map[string]any{"name": "default", "url": up.URL(), "shape": "openai-chat", "auth_style": "bearer",
		"static_headers": map[string]string{"X-Transport": "hdr-test-transport"}}).Expect(201)
	srv.Admin.Post("/api/providers/deepai-like/keys/bulk", map[string]any{"items": []any{
		map[string]any{"name": "keyless"}, map[string]any{"name": "keyless-2"}, map[string]any{"name": "keyless-3"}, map[string]any{"name": "spare"},
	}}).OK()

	dry, out := importV1(t, srv, path, false)
	if dry.RemoveKeys != 2 || dry.Failed() != 0 || !strings.Contains(out, "Upstream Keys: 2 would create, 0 would update, 1 unchanged") ||
		!strings.Contains(out, "Keyless slots an earlier import made for rows that have a secret: 2 would be deleted (keyless-2, keyless-3)") ||
		!strings.Contains(out, "upstream_keys_remove=2") {
		t.Fatalf("dry run %+v\n%s", dry, out)
	}
	if len(keysOf(t, srv, "deepai-like")) != 4 {
		t.Fatal("the dry run changed keys")
	}

	rep, out := importV1(t, srv, path, true)
	if rep.Failed() != 0 || rep.RemoveKeys != 2 || !strings.Contains(out, "Upstream Keys: 2 created, 0 updated, 1 unchanged") ||
		!strings.Contains(out, "2 deleted (one Audit Entry; revert it to restore them) (keyless-2, keyless-3)") {
		t.Fatalf("report %+v\n%s", rep, out)
	}
	keys := keysOf(t, srv, "deepai-like")
	var names []string
	secretCount := 0
	for n, k := range keys {
		names = append(names, n)
		if slices.Contains(secrets, k.Secret) {
			secretCount++
		}
	}
	slices.Sort(names)
	if secretCount != 2 || keys["keyless"].Secret != "" || keys["spare"].Secret != "" || len(keys) != 4 {
		t.Fatalf("after the repair: keys %v, %d with a v1 secret", names, secretCount)
	}
	var entries audit.EntryPage
	srv.Admin.Get("/api/audit-entries?action=upstream_key.delete").OK().JSON(&entries)
	var del *audit.Entry
	for i, e := range entries.Entries {
		if e.Action == "upstream_key.delete" {
			del = &entries.Entries[i]
		}
	}
	if del == nil || len(del.Changes) != 2 || !del.Revertible {
		t.Fatalf("no revertible Audit Entry for the deleted slots: %+v", entries.Entries)
	}

	srv.Admin.Patch("/api/providers/deepai-like", map[string]any{"affinity": "off"}).OK() // keys in turn, so every key is reached
	caller := friendOne(t, srv)
	before := up.Count()
	for i := 0; i < 8; i++ {
		chat(caller, "deepai-like").OK()
	}
	keyedCalls := 0
	for _, r := range up.Requests()[before:] {
		if slices.Contains(secrets, r.Bearer()) {
			keyedCalls++
		}
	}
	if keyedCalls == 0 {
		t.Error("no Attempt carried a v1 secret after the repair")
	}

	srv.Admin.Get("/api/audit-entries").OK().JSON(&entries)
	audits := len(entries.Entries)
	again, out := importV1(t, srv, path, true)
	if again.RemoveKeys != 0 || again.UpstreamKeys.Create+again.UpstreamKeys.Update != 0 || again.Failed() != 0 {
		t.Fatalf("third run %+v\n%s", again, out)
	}
	srv.Admin.Get("/api/audit-entries").OK().JSON(&entries)
	if len(entries.Entries) != audits {
		t.Errorf("the third run wrote %d Audit Entries", len(entries.Entries)-audits)
	}
}
