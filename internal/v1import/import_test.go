package v1import_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
	"github.com/hoangvu12/iroha/internal/v1import"
)

// Fake secrets only: the fixture is a synthetic v1 database.
const masterKey = "test-master-key-0123456789abcdef0123456789"

var fakeSecrets = []string{"sk-test-acme-1", "sk-test-acme-2", "sk-test-acme-3", "sk-test-acme-4", "sk-test-acme-5", "sk-test-old-1", "sk-test-anth-1", "hdr-test-value"}

// TestDecryptReadsV1Ciphertext uses vectors made by v1's own
// src/crypto/secret-cipher.ts with a fake master key.
func TestDecryptReadsV1Ciphertext(t *testing.T) {
	for stored, want := range map[string]string{
		"v1.uZ9uSmM97yRh6Q3l.egzr813ngTxNcnwSmvxaiyEFbDX2REGW29fUDskTAe8":                                      "sk-test-vector-1",
		"v1.sCobpFpr5n9MA5_M.gy68rzR1QolZcfOtv_VDkA":                                                           "",
		"v1.ytNJImj1IPs6OWDU.cETft6IqpSUUdnS_YHSlYP4IL_OkSvgOzkHaoHExkTeHlpXWgrkY2unEiDzWcOXyEZvlw7BIWCr0prtr": `[{"name":"X-Test","value":"hdr-test-value"}]`,
	} {
		got, err := v1import.Decrypt(masterKey, stored)
		if err != nil || got != want {
			t.Errorf("Decrypt(%s) = %q, %v; want %q", stored, got, err, want)
		}
	}
	if _, err := v1import.Decrypt("another-master-key-0123456789abcdef0123", "v1.uZ9uSmM97yRh6Q3l.egzr813ngTxNcnwSmvxaiyEFbDX2REGW29fUDskTAe8"); err == nil {
		t.Error("a wrong master key decrypted a secret")
	}
}

type fixture struct {
	path        string
	upA, upB    *testkit.Upstream
	oldSchema   bool
	extraKeySQL []string
}

var ivN byte

func enc(s string) string {
	ivN++
	return v1import.Encrypt(masterKey, s, bytes.Repeat([]byte{ivN}, 12))
}

// newV1 writes a v1-shaped SQLite database: the tables and columns of v1's
// src/persistence/sqlite/schema.ts (migrations/sqlite up to 0025, or up to
// 0023 with oldSchema), with fake secrets encrypted as v1 did.
func newV1(t *testing.T, f *fixture) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "iroha.db")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	newProviderCols, newKeyCols := "requires_upstream_key integer DEFAULT 1 NOT NULL, model_discovery text,", "model_rewrites text,"
	if f.oldSchema {
		newProviderCols, newKeyCols = "", ""
	}
	schema := []string{
		`CREATE TABLE settings (key text PRIMARY KEY, value text NOT NULL, updated_at integer NOT NULL)`,
		`CREATE TABLE audit_events (id integer PRIMARY KEY AUTOINCREMENT, occurred_at integer NOT NULL, action text NOT NULL, outcome text NOT NULL, detail text)`,
		`CREATE TABLE providers (id text PRIMARY KEY, handle text NOT NULL UNIQUE, display_name text NOT NULL, base_url text NOT NULL, logo_domain text,
			allow_insecure_http integer NOT NULL, enabled integer NOT NULL, retry_max_attempts integer DEFAULT 3 NOT NULL, retry_ambiguous_network integer DEFAULT 0 NOT NULL,
			archived_at integer, template_id text, capabilities text NOT NULL, auth_header text DEFAULT 'authorization' NOT NULL, auth_prefix text DEFAULT 'Bearer ' NOT NULL,
			` + newProviderCols + ` static_headers_encrypted text DEFAULT '[]' NOT NULL, redirect_allow_same_origin integer DEFAULT 0 NOT NULL,
			connection_timeout_ms integer DEFAULT 10000 NOT NULL, first_byte_timeout_ms integer DEFAULT 20000 NOT NULL, non_streaming_total_timeout_ms integer DEFAULT 120000 NOT NULL,
			streaming_idle_timeout_ms integer DEFAULT 30000 NOT NULL, total_retry_timeout_ms integer DEFAULT 30000 NOT NULL, idempotency_header text DEFAULT 'Idempotency-Key' NOT NULL,
			created_at integer NOT NULL, updated_at integer NOT NULL)`,
		`CREATE TABLE upstream_accounts (id text PRIMARY KEY, provider_id text NOT NULL, display_name text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)`,
		`CREATE TABLE upstream_keys (id text PRIMARY KEY, provider_id text NOT NULL, base_url text, account_id text, encrypted_key text NOT NULL, health text NOT NULL,
			last_probe_at integer, last_probe_verdict text, last_probe_reason text, health_reason text, health_changed_at integer, retry_after_at integer,
			health_scope text DEFAULT 'key' NOT NULL, health_scope_id text, health_model text, allowed_models text, denied_models text, ` + newKeyCols + `
			created_at integer NOT NULL, updated_at integer NOT NULL)`,
		`CREATE TABLE gateway_keys (id text PRIMARY KEY, name text NOT NULL, secret_hash text NOT NULL, scope text NOT NULL, access_mode text DEFAULT 'selected' NOT NULL,
			revision integer DEFAULT 1 NOT NULL, cors_origins text DEFAULT '[]' NOT NULL, created_at integer NOT NULL, last_used_at integer, revoked_at integer)`,
		`CREATE TABLE model_catalog_entries (provider_id text NOT NULL, model_id text NOT NULL, source text NOT NULL, excluded integer NOT NULL, overrides text, metadata text,
			created_at integer NOT NULL, updated_at integer NOT NULL, PRIMARY KEY (provider_id, model_id))`,
		`CREATE TABLE request_events (id text PRIMARY KEY, gateway_key_id text, provider_id text, model text, status integer, created_at integer NOT NULL)`,
	}
	caps := `"{\"chat\":true,\"streaming\":true,\"tools\":true,\"structuredOutput\":false,\"responses\":false}"`
	provider := func(id, handle, name, base, logo, template string, archived bool, extra string) string {
		arch := "NULL"
		if archived {
			arch = "5"
		}
		cols, vals := "", ""
		if extra != "" {
			c, v, _ := strings.Cut(extra, "=")
			cols, vals = ", "+c, ", "+v
		}
		return fmt.Sprintf(`INSERT INTO providers (id, handle, display_name, base_url, logo_domain, allow_insecure_http, enabled, archived_at, template_id, capabilities, created_at, updated_at%s)
			VALUES ('%s', '%s', '%s', '%s', %s, 0, 1, %s, %s, '%s', 1, 1%s)`, cols, id, handle, name, base, nullable(logo), arch, nullable(template), caps, vals)
	}
	n := 0
	key := func(provider, base, secret, health, extra string) string {
		n++
		cols, vals := "", ""
		if extra != "" {
			c, v, _ := strings.Cut(extra, "=")
			cols, vals = ", "+c, ", "+v
		}
		return fmt.Sprintf(`INSERT INTO upstream_keys (id, provider_id, base_url, encrypted_key, health, created_at, updated_at%s) VALUES ('k%d', '%s', %s, '%s', '%s', %d, %d%s)`,
			cols, n, provider, nullable(base), enc(secret), health, n, n, vals)
	}
	rows := []string{
		provider("p1", "acme", "Acme Cloud", f.upA.URL()+"/", "acme.example", "MiniMax", false, ""),
		`UPDATE providers SET retry_max_attempts = 5, first_byte_timeout_ms = 45000, static_headers_encrypted = '` + enc(`[{"name":"X-Team","value":"hdr-test-value"}]`) + `' WHERE id = 'p1'`,
		key("p1", "", "sk-test-acme-1", "active", ""),
		key("p1", f.upB.URL(), "sk-test-acme-2", "cooling_down", ""),
		key("p1", f.upA.URL(), "sk-test-acme-3", "exhausted", ""),
		key("p1", "", "sk-test-acme-4", "disabled", ""),
		key("p1", "", "sk-test-acme-5", "active", `account_id, allowed_models='a1', '["m1"]'`),
		provider("p2", "old", "Old", "https://old.example/v1", "", "", true, ""),
		key("p2", "", "sk-test-old-1", "active", ""),
		provider("p3", "anth", "Anthropic", "https://api.anthropic.example/v1", "", "anthropic", false, "auth_header, auth_prefix='x-api-key', ''"),
		key("p3", "", "sk-test-anth-1", "invalid_authentication", ""),
		`INSERT INTO upstream_accounts VALUES ('a1', 'p1', 'Team account', 1, 1)`,
		`INSERT INTO gateway_keys (id, name, secret_hash, scope, access_mode, created_at) VALUES ('g1', 'friend one', 'hash', '[]', 'all', 1)`,
		`INSERT INTO gateway_keys (id, name, secret_hash, scope, access_mode, cors_origins, created_at) VALUES ('g2', 'bot', 'hash',
			'[{"providerId":"p1","models":null},{"providerId":"p3","models":["claude-x","claude-y"]},{"providerId":"p2","models":null}]', 'selected', '["https://app.example"]', 2)`,
		`INSERT INTO gateway_keys (id, name, secret_hash, scope, access_mode, created_at, revoked_at) VALUES ('g3', 'gone', 'hash', '[]', 'all', 3, 4)`,
		`INSERT INTO settings VALUES ('management.keys', '[{"name":"agent","hash":"x"}]', 1)`,
		`INSERT INTO audit_events (occurred_at, action, outcome) VALUES (1, 'provider.create', 'ok')`,
		`INSERT INTO request_events VALUES ('r1', 'g1', 'p1', 'm1', 200, 1)`,
		`INSERT INTO model_catalog_entries VALUES ('p1', 'm-hidden', 'excluded', 1, NULL, NULL, 1, 1)`,
	}
	if !f.oldSchema {
		rows = append(rows,
			provider("p4", "local", "Local", "http://127.0.0.1:9/v1", "", "", false, "requires_upstream_key=0"),
			key("p4", "", "", "active", ""),
		)
	}
	rows = append(rows, f.extraKeySQL...)
	for _, s := range append(schema, rows...) {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("%v\n%s", err, s)
		}
	}
	return path
}

func nullable(s string) string {
	if s == "" {
		return "NULL"
	}
	return "'" + s + "'"
}

func importV1(t *testing.T, srv *testkit.Server, path string, apply bool) (v1import.Report, string) {
	t.Helper()
	var out bytes.Buffer
	rep, err := v1import.Run(context.Background(), v1import.Options{V1DB: path, MasterKey: masterKey, URL: srv.URL, Token: srv.AdminToken, Apply: apply, Out: &out})
	if err != nil {
		t.Fatalf("import: %v\n%s", err, out.String())
	}
	text := out.String()
	for _, s := range append(fakeSecrets, masterKey, srv.AdminToken) {
		if strings.Contains(text, s) {
			t.Fatalf("the import printed a secret:\n%s", text)
		}
	}
	return rep, text
}

func fileHash(t *testing.T, path string) [32]byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return sha256.Sum256(b)
}

func start(t *testing.T) (*testkit.Server, *fixture) {
	f := &fixture{upA: testkit.NewOpenAIChat(t), upB: testkit.NewOpenAIChat(t)}
	return testkit.Start(t), f
}

func TestImportIsADryRunByDefault(t *testing.T) {
	srv, f := start(t)
	path := newV1(t, f)
	before := fileHash(t, path)

	rep, out := importV1(t, srv, path, false)

	if !rep.DryRun || rep.Providers.Create != 3 || rep.Endpoints.Create != 4 || rep.UpstreamKeys.Create != 7 || rep.GatewayKeys.Create != 2 || rep.DisableKeys != 1 || rep.Failed() != 0 {
		t.Fatalf("report %+v\n%s", rep, out)
	}
	for _, want := range []string{"Provider acme: would create", "Gateway Key friend-one: would create (scope: everything)", "IROHA_IMPORT dry_run providers_create=3"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}
	var pl providers.ProviderList
	srv.Admin.Get("/api/providers").OK().JSON(&pl)
	var gl gatewaykeys.GatewayKeyList
	srv.Admin.Get("/api/gateway-keys").OK().JSON(&gl)
	if len(pl.Providers) != 0 || len(gl.GatewayKeys) != 0 {
		t.Fatalf("a dry run changed v2: %d Providers, %d Gateway Keys", len(pl.Providers), len(gl.GatewayKeys))
	}
	if fileHash(t, path) != before {
		t.Fatal("the import changed the v1 database file")
	}
}

func TestImportRecreatesV1Configuration(t *testing.T) {
	srv, f := start(t)
	path := newV1(t, f)
	before := fileHash(t, path)

	rep, out := importV1(t, srv, path, true)
	if rep.DryRun || rep.Failed() != 0 || rep.Providers.Create != 3 || rep.UpstreamKeys.Create != 7 || rep.GatewayKeys.Create != 2 {
		t.Fatalf("report %+v\n%s", rep, out)
	}
	if fileHash(t, path) != before {
		t.Fatal("the import changed the v1 database file")
	}

	// Providers: archived ones are left out.
	var pl providers.ProviderList
	srv.Admin.Get("/api/providers").OK().JSON(&pl)
	var handles []string
	for _, p := range pl.Providers {
		handles = append(handles, p.Handle)
	}
	slices.Sort(handles)
	if !slices.Equal(handles, []string{"acme", "anth", "local"}) {
		t.Fatalf("Providers %v", handles)
	}

	var acme providers.Provider
	srv.Admin.Get("/api/providers/acme").OK().JSON(&acme)
	if acme.Name != "Acme Cloud" || !acme.Enabled || acme.Discovery != "key" || acme.ModelsDevBrand != "minimax" || acme.LogoDomain != "acme.example" || acme.LogoGuessed ||
		acme.Budget.MaxAttempts != 5 {
		t.Errorf("acme = %+v", acme)
	}
	// The Provider's base URL and the one per-key base URL that differs
	// from it become Endpoints; static headers apply to both.
	if len(acme.Endpoints) != 2 {
		t.Fatalf("acme Endpoints %+v", acme.Endpoints)
	}
	def, eu := acme.Endpoints[0], acme.Endpoints[1]
	if def.Name != "default" || def.URL != f.upA.URL() || def.Shape != "openai-chat" || def.AuthStyle != "bearer" || def.StaticHeaders["X-Team"] != "hdr-test-value" {
		t.Errorf("default Endpoint %+v", def)
	}
	if eu.Name != "127.0.0.1" || eu.URL != f.upB.URL() || eu.StaticHeaders["X-Team"] != "hdr-test-value" {
		t.Errorf("per-key Endpoint %+v", eu)
	}

	// Keys come in active (runtime health is not carried), restricted to
	// the Endpoint of their v1 base URL; a key v1 had disabled stays disabled.
	var kl providers.UpstreamKeyList
	srv.Admin.Get("/api/providers/acme/keys").OK().JSON(&kl)
	got := map[string]string{}
	for _, k := range kl.UpstreamKeys {
		state := k.State.State
		got[k.Secret] = state + " " + strings.Join(k.Endpoints, ",")
	}
	want := map[string]string{
		"sk-test-acme-1": "active default",
		"sk-test-acme-2": "active " + eu.Name,
		"sk-test-acme-3": "active default",
		"sk-test-acme-4": "disabled default",
		"sk-test-acme-5": "active default",
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("acme keys\n got %v\nwant %v", got, want)
	}

	var anth providers.Provider
	srv.Admin.Get("/api/providers/anth").OK().JSON(&anth)
	if len(anth.Endpoints) != 1 || anth.Endpoints[0].Shape != "anthropic-messages" || anth.Endpoints[0].AuthStyle != "x-api-key" || anth.ModelsDevBrand != "anthropic" {
		t.Errorf("anth = %+v", anth)
	}
	srv.Admin.Get("/api/providers/anth/keys").OK().JSON(&kl)
	if len(kl.UpstreamKeys) != 1 || kl.UpstreamKeys[0].Secret != "sk-test-anth-1" || len(kl.UpstreamKeys[0].Endpoints) != 0 {
		t.Errorf("anth keys %+v", kl.UpstreamKeys)
	}
	srv.Admin.Get("/api/providers/local/keys").OK().JSON(&kl)
	if len(kl.UpstreamKeys) != 1 || kl.UpstreamKeys[0].Secret != "" || kl.UpstreamKeys[0].Name != "keyless" {
		t.Errorf("local keys %+v", kl.UpstreamKeys)
	}

	// Gateway Keys: same names (fitted to v2's rules) and scopes, new
	// secrets; revoked ones and scope entries on archived Providers are left out.
	var gl gatewaykeys.GatewayKeyList
	srv.Admin.Get("/api/gateway-keys").OK().JSON(&gl)
	if len(gl.GatewayKeys) != 2 {
		t.Fatalf("Gateway Keys %+v", gl.GatewayKeys)
	}
	keys := map[string]gatewaykeys.GatewayKey{}
	for _, k := range gl.GatewayKeys {
		keys[k.Name] = k
		if k.Secret == "" || k.Revoked {
			t.Errorf("Gateway Key %s has no new secret or is revoked", k.Name)
		}
	}
	if !keys["friend-one"].Scope.All {
		t.Errorf("friend-one scope %+v", keys["friend-one"].Scope)
	}
	scope, _ := json.Marshal(keys["bot"].Scope)
	if string(scope) != `{"all":false,"providers":[{"provider":"acme"},{"provider":"anth","models":["claude-x","claude-y"]}]}` {
		t.Errorf("bot scope %s", scope)
	}

	// Not imported: Upstream Accounts (v2 has none), request history, audit
	// history, Management Keys.
	var tokens struct {
		AdminTokens []any `json:"admin_tokens"`
	}
	srv.Admin.Get("/api/admin-tokens").OK().JSON(&tokens)
	var reqs struct {
		Requests []any `json:"requests"`
	}
	srv.Admin.Get("/api/requests").OK().JSON(&reqs)
	if len(tokens.AdminTokens) != 1 || len(reqs.Requests) != 0 {
		t.Errorf("admin tokens %d, requests %d", len(tokens.AdminTokens), len(reqs.Requests))
	}
	for _, want := range []string{"1 archived v1 Providers and their 1 Upstream Keys", "1 revoked v1 Gateway Keys", "1 v1 Upstream Accounts",
		"Request history, audit history, Management Keys", "allow/deny lists", "acme: 2 keys", "CORS origins", "transport settings", "acme"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q:\n%s", want, out)
		}
	}

	// A Caller with the new secret reaches the imported keys, each only on
	// its own Endpoint.
	caller := srv.Client(keys["friend-one"].Secret)
	for i := 0; i < 6; i++ {
		caller.Post("/providers/acme/v1/chat/completions", map[string]any{"model": "m1", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).OK()
	}
	for _, r := range f.upA.Requests() {
		if b := r.Bearer(); b != "sk-test-acme-1" && b != "sk-test-acme-3" && b != "sk-test-acme-5" {
			t.Errorf("the default Endpoint got key %q", b)
		}
		if r.Header.Get("X-Team") != "hdr-test-value" {
			t.Error("static header missing")
		}
	}
	for _, r := range f.upB.Requests() {
		if b := r.Bearer(); b != "sk-test-acme-2" {
			t.Errorf("the per-key Endpoint got key %q", b)
		}
	}
	if len(f.upA.Requests()) == 0 || len(f.upB.Requests()) == 0 {
		t.Errorf("requests: default %d, per-key %d", len(f.upA.Requests()), len(f.upB.Requests()))
	}
}

func TestReRunningTheImportDuplicatesNothing(t *testing.T) {
	srv, f := start(t)
	path := newV1(t, f)
	importV1(t, srv, path, true)

	var gl1 gatewaykeys.GatewayKeyList
	srv.Admin.Get("/api/gateway-keys").OK().JSON(&gl1)
	var entries struct {
		Entries []any `json:"entries"`
	}
	srv.Admin.Get("/api/audit-entries").OK().JSON(&entries)
	audits := len(entries.Entries)

	dry, out := importV1(t, srv, path, false)
	if dry.Providers.Unchanged != 3 || dry.Endpoints.Unchanged != 4 || dry.UpstreamKeys.Unchanged != 7 || dry.GatewayKeys.Unchanged != 2 ||
		dry.Providers.Create+dry.Providers.Update+dry.Endpoints.Create+dry.Endpoints.Update+dry.UpstreamKeys.Create+dry.UpstreamKeys.Update+dry.GatewayKeys.Create+dry.GatewayKeys.Update+dry.DisableKeys != 0 {
		t.Fatalf("dry run after import %+v\n%s", dry, out)
	}
	again, out := importV1(t, srv, path, true)
	if again.Providers.Unchanged != 3 || again.UpstreamKeys.Unchanged != 7 || again.GatewayKeys.Unchanged != 2 || again.Failed() != 0 {
		t.Fatalf("second import %+v\n%s", again, out)
	}

	srv.Admin.Get("/api/audit-entries").OK().JSON(&entries)
	if len(entries.Entries) != audits {
		t.Errorf("the second import wrote %d Audit Entries", len(entries.Entries)-audits)
	}
	var gl2 gatewaykeys.GatewayKeyList
	srv.Admin.Get("/api/gateway-keys").OK().JSON(&gl2)
	if len(gl2.GatewayKeys) != 2 || gl1.GatewayKeys[0].Secret != gl2.GatewayKeys[0].Secret {
		t.Error("the second import re-issued or added Gateway Keys")
	}
	var kl providers.UpstreamKeyList
	srv.Admin.Get("/api/providers/acme/keys").OK().JSON(&kl)
	if len(kl.UpstreamKeys) != 5 {
		t.Errorf("acme has %d keys", len(kl.UpstreamKeys))
	}
}

// TestImportMatchesWhatTheOwnerAlreadyAdded: a key v1 knew that the Owner added
// by hand before the import is matched by its secret, and Endpoints are
// matched by URL and Shape whatever the Owner named them.
func TestImportMatchesWhatTheOwnerAlreadyAdded(t *testing.T) {
	srv, f := start(t)
	path := newV1(t, f)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme", "name": "Acme Cloud"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "main", "url": f.upA.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "mine", "secret": "sk-test-acme-1"}).Expect(201)

	rep, out := importV1(t, srv, path, true)
	if rep.Failed() != 0 || rep.Providers.Update != 1 || rep.Endpoints.Create != 3 || rep.UpstreamKeys.Create != 6 || rep.UpstreamKeys.Update != 1 {
		t.Fatalf("report %+v\n%s", rep, out)
	}
	var acme providers.Provider
	srv.Admin.Get("/api/providers/acme").OK().JSON(&acme)
	if len(acme.Endpoints) != 2 || acme.Endpoints[0].Name != "main" {
		t.Fatalf("acme Endpoints %+v", acme.Endpoints)
	}
	var k providers.UpstreamKey
	srv.Admin.Get("/api/providers/acme/keys/mine").OK().JSON(&k)
	if !slices.Equal(k.Endpoints, []string{"main"}) {
		t.Errorf("key mine restricted to %v", k.Endpoints)
	}
}

func TestImportRefusesAWrongMasterKey(t *testing.T) {
	srv, f := start(t)
	path := newV1(t, f)
	var out bytes.Buffer
	_, err := v1import.Run(context.Background(), v1import.Options{V1DB: path, MasterKey: "another-master-key-0123456789abcdef0123", URL: srv.URL, Token: srv.AdminToken, Apply: true, Out: &out})
	if err == nil || !strings.Contains(err.Error(), "cannot be read with this master key") {
		t.Fatalf("err = %v", err)
	}
	var pl providers.ProviderList
	srv.Admin.Get("/api/providers").OK().JSON(&pl)
	if len(pl.Providers) != 0 {
		t.Fatal("a failed import created Providers")
	}
}

// TestImportReadsAnOlderV1Schema: v1 databases from before migrations 0024
// and 0025 lack requires_upstream_key, model_discovery and model_rewrites.
func TestImportReadsAnOlderV1Schema(t *testing.T) {
	srv, f := start(t)
	f.oldSchema = true
	path := newV1(t, f)
	rep, out := importV1(t, srv, path, true)
	if rep.Failed() != 0 || rep.Providers.Create != 2 || rep.UpstreamKeys.Create != 6 {
		t.Fatalf("report %+v\n%s", rep, out)
	}
}

// TestImportMergesKeyRowsSharingASecret: v1 could hold one secret in two
// rows with different base URLs; v2 holds it once, on both Endpoints.
func TestImportMergesKeyRowsSharingASecret(t *testing.T) {
	srv, f := start(t)
	f.extraKeySQL = []string{`INSERT INTO upstream_keys (id, provider_id, base_url, encrypted_key, health, created_at, updated_at)
		VALUES ('kdup', 'p1', '` + f.upB.URL() + `', '` + enc("sk-test-acme-1") + `', 'active', 99, 99)`}
	path := newV1(t, f)
	rep, out := importV1(t, srv, path, true)
	if rep.Failed() != 0 || rep.UpstreamKeys.Create != 7 || !strings.Contains(out, "acme: 1 rows") {
		t.Fatalf("report %+v\n%s", rep, out)
	}
	var kl providers.UpstreamKeyList
	srv.Admin.Get("/api/providers/acme/keys").OK().JSON(&kl)
	for _, k := range kl.UpstreamKeys {
		if k.Secret == "sk-test-acme-1" && !slices.Equal(k.Endpoints, []string{"default", "127.0.0.1"}) {
			t.Errorf("merged key restricted to %v", k.Endpoints)
		}
	}
	if len(kl.UpstreamKeys) != 5 {
		t.Errorf("acme has %d keys", len(kl.UpstreamKeys))
	}
}

// TestImportMapsPerKeyModelRewrites: v1's per-key rewrites become the
// renames of the key's Endpoint when every key there has the same ones.
func TestImportMapsPerKeyModelRewrites(t *testing.T) {
	srv, f := start(t)
	f.extraKeySQL = []string{`UPDATE upstream_keys SET model_rewrites = '{"glm-4.6":"glm-4.6-fp8"}' WHERE id = 'k2'`}
	path := newV1(t, f)
	rep, out := importV1(t, srv, path, true)
	if rep.Failed() != 0 {
		t.Fatalf("report %+v\n%s", rep, out)
	}
	var acme providers.Provider
	srv.Admin.Get("/api/providers/acme").OK().JSON(&acme)
	if acme.Endpoints[1].Renames["glm-4.6"] != "glm-4.6-fp8" || len(acme.Endpoints[0].Renames) != 0 {
		t.Errorf("renames %v / %v", acme.Endpoints[0].Renames, acme.Endpoints[1].Renames)
	}
}
