package providers_test

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestProviderHandlesAreValidatedUniqueAndImmutable(t *testing.T) {
	srv := testkit.Start(t)
	for _, bad := range []string{"", "Acme", "my_provider", "-acme", "acme-", "ac--me", "a.b", strings.Repeat("a", 64), "bulk", "pools"} {
		e := srv.Admin.Post("/api/providers", map[string]any{"handle": bad}).Expect(400).Err()
		if e.Hint == "" {
			t.Errorf("%q: no hint", bad)
		}
	}

	var created, again, renamed providers.ProviderResult
	srv.Admin.Post("/api/providers", map[string]any{"handle": "zai-coding"}).Expect(201).JSON(&created)
	p := created.Provider
	if p.Handle != "zai-coding" || p.Name != "zai-coding" || !p.Enabled || p.Archived || p.CallerPath != "/providers/zai-coding/v1" ||
		len(p.Endpoints) != 0 || created.AuditEntry == "" {
		t.Fatalf("created = %+v", created)
	}
	srv.Admin.Post("/api/providers", map[string]any{"handle": "zai-coding"}).Expect(200).JSON(&again)
	if again.Outcome != "unchanged" || again.Provider.ID != p.ID || again.AuditEntry != "" {
		t.Fatalf("repeat = %+v", again)
	}
	srv.Admin.Post("/api/providers", map[string]any{"handle": "zai-coding", "name": "Z.ai coding plan"}).Expect(200).JSON(&renamed)
	if renamed.Outcome != "updated" || renamed.Provider.Name != "Z.ai coding plan" || !slices.Equal(renamed.Changes[0].Fields, []string{"name"}) {
		t.Fatalf("rename = %+v", renamed)
	}

	// Handles never change.
	if e := srv.Admin.Patch("/api/providers/zai-coding", map[string]any{"handle": "zai"}).Expect(400).Err(); e.Code != "handle_immutable" || e.Hint == "" {
		t.Fatalf("handle change: %+v", e)
	}
	srv.Admin.Patch("/api/providers/zai-coding", map[string]any{"handle": "zai-coding", "enabled": false}).Expect(200)

	// Read by handle or ID; archive and filter.
	for _, ref := range []string{"zai-coding", p.ID} {
		var got providers.Provider
		srv.Admin.Get("/api/providers/" + ref).Expect(200).JSON(&got)
		if got.ID != p.ID || got.Enabled {
			t.Fatalf("read %s = %+v", ref, got)
		}
	}
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Patch("/api/providers/zai-coding", map[string]any{"archived": true}).Expect(200)
	var list providers.ProviderList
	srv.Admin.Get("/api/providers?archived=true").Expect(200).JSON(&list)
	if len(list.Providers) != 1 || list.Providers[0].Handle != "zai-coding" {
		t.Fatalf("archived=true: %+v", list)
	}
	srv.Admin.Get("/api/providers").Expect(200).JSON(&list)
	if len(list.Providers) != 2 {
		t.Fatalf("all: %+v", list)
	}
	// An archived handle stays reserved: creating it again updates the archived Provider.
	srv.Admin.Post("/api/providers", map[string]any{"handle": "zai-coding"}).Expect(200)
	if e := srv.Admin.Get("/api/providers/nope").Expect(404).Err(); !strings.Contains(e.Hint, "GET /api/providers") {
		t.Fatalf("unknown: %+v", e)
	}
}

func TestEndpointsAreCreatedByNameValidatedAndRevertible(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	base := "/api/providers/acme/endpoints"

	for _, body := range []map[string]any{
		{"shape": "openai-chat"},
		{"url": "https://api.example.com/v1"},
		{"url": "ftp://api.example.com/v1", "shape": "openai-chat"},
		{"url": "https://user:pw@api.example.com/v1", "shape": "openai-chat"},
		{"url": "https://api.example.com/v1?key=1", "shape": "openai-chat"},
		{"url": "https://api.example.com/v1", "shape": "openai"},
	} {
		if e := srv.Admin.Post(base, body).Expect(400).Err(); e.Hint == "" {
			t.Errorf("%v: no hint", body)
		}
	}

	var created providers.EndpointResult
	srv.Admin.Post(base, map[string]any{"url": "https://api.example.com/v1/", "shape": "openai-chat"}).Expect(201).JSON(&created)
	ep := created.Endpoint
	if ep.Name != "default" || ep.URL != "https://api.example.com/v1" || ep.Shape != "openai-chat" || ep.Provider != "acme" {
		t.Fatalf("endpoint = %+v", ep)
	}
	if created.Changes[0].Name != "acme/default" {
		t.Fatalf("audit name = %q", created.Changes[0].Name)
	}
	var same providers.EndpointResult
	srv.Admin.Post(base, map[string]any{"name": "default", "url": "https://api.example.com/v1"}).Expect(200).JSON(&same)
	if same.Outcome != "unchanged" {
		t.Fatalf("repeat = %+v", same)
	}
	var moved providers.EndpointResult
	srv.Admin.Patch(base+"/default", map[string]any{"url": "https://eu.example.com/v1"}).Expect(200).JSON(&moved)
	if moved.Endpoint.URL != "https://eu.example.com/v1" {
		t.Fatalf("patch = %+v", moved)
	}
	var p providers.Provider
	srv.Admin.Get("/api/providers/acme").Expect(200).JSON(&p)
	if len(p.Endpoints) != 1 || p.Endpoints[0].URL != "https://eu.example.com/v1" {
		t.Fatalf("provider endpoints = %+v", p.Endpoints)
	}

	var deleted providers.EndpointResult
	srv.Admin.Delete(base + "/" + ep.ID).Expect(200).JSON(&deleted)
	if deleted.Outcome != "deleted" {
		t.Fatalf("delete = %+v", deleted)
	}
	srv.Admin.Get(base + "/default").Expect(404)
	srv.Admin.Post("/api/audit-entries/"+deleted.AuditEntry+"/revert", nil).Expect(200)
	var back providers.Endpoint
	srv.Admin.Get(base + "/default").Expect(200).JSON(&back)
	if back.ID != ep.ID || back.URL != "https://eu.example.com/v1" {
		t.Fatalf("after revert = %+v", back)
	}
	// Endpoint names are per Provider.
	srv.Admin.Post("/api/providers", map[string]any{"handle": "other"}).Expect(201)
	srv.Admin.Post("/api/providers/other/endpoints", map[string]any{"url": "https://o.example.com/v1", "shape": "anthropic-messages"}).Expect(201)
	if e := srv.Admin.Get("/api/providers/other/endpoints/" + ep.ID).Expect(404).Err(); !strings.Contains(e.Hint, "/api/providers/other/endpoints") {
		t.Fatalf("another Provider's Endpoint: %+v", e)
	}
}

func TestEndpointAuthHeadersAndRenamesAreValidatedAndAudited(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	base := "/api/providers/acme/endpoints"
	ep := func(extra map[string]any) map[string]any {
		m := map[string]any{"name": "eu", "url": "https://eu.example.com/v1", "shape": "openai-chat"}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	for _, bad := range []map[string]any{
		{"auth_style": "basic"},
		{"auth_style": "header"},
		{"auth_style": "query", "auth_param": "a key"},
		{"auth_style": "bearer", "auth_param": "x"},
		{"auth_style": "header", "auth_param": "Content-Length"},
		{"static_headers": map[string]string{"Authorization": "Bearer fixed"}},
		{"static_headers": map[string]string{"Host": "evil.example"}},
		{"static_headers": map[string]string{"X-A": "line\r\nbreak"}},
		{"renames": map[string]string{"glm": ""}},
		{"renames": map[string]string{" glm": "x"}},
		{"renames": map[string]string{strings.Repeat("m", 257): "x"}}, // MOD-13: names are at most 256 characters
		{"renames": manyRenames(1001)},                                // MOD-13: at most 1000 renames
	} {
		if e := srv.Admin.Post(base, ep(bad)).Expect(400).Err(); e.Hint == "" {
			t.Errorf("%v: no hint", bad)
		}
	}

	var created providers.EndpointResult
	srv.Admin.Post(base, ep(map[string]any{"auth_style": "header", "auth_param": "api-key",
		"static_headers": map[string]string{"HTTP-Referer": "https://example.com"}, "renames": map[string]string{"glm-4.6": "glm-4.6-fp8"}})).Expect(201).JSON(&created)
	e := created.Endpoint
	if e.AuthStyle != "header" || e.AuthParam != "api-key" || e.StaticHeaders["HTTP-Referer"] != "https://example.com" || e.Renames["glm-4.6"] != "glm-4.6-fp8" {
		t.Fatalf("created = %+v", e)
	}
	// A static Authorization header is fine when the key is not sent there.
	var edited providers.EndpointResult
	srv.Admin.Patch(base+"/eu", map[string]any{"auth_style": "none", "static_headers": map[string]string{"Authorization": "Bearer relay-fixed"}}).Expect(200).JSON(&edited)
	if edited.Endpoint.AuthStyle != "none" || edited.Endpoint.AuthParam != "" || !slices.Equal(edited.Changes[0].Fields, []string{"auth_param", "auth_style", "static_headers"}) {
		t.Fatalf("edit = %+v", edited)
	}
	var unchanged providers.EndpointResult
	srv.Admin.Post(base, map[string]any{"name": "eu", "auth_style": "none"}).Expect(200).JSON(&unchanged)
	if unchanged.Outcome != "unchanged" {
		t.Fatalf("repeat = %+v", unchanged)
	}
	srv.Admin.Post("/api/audit-entries/"+edited.AuditEntry+"/revert", nil).Expect(200)
	var back providers.Endpoint
	srv.Admin.Get(base + "/eu").Expect(200).JSON(&back)
	if back.AuthStyle != "header" || back.AuthParam != "api-key" || back.StaticHeaders["Authorization"] != "" || back.Renames["glm-4.6"] != "glm-4.6-fp8" {
		t.Fatalf("after revert = %+v", back)
	}
	var entries audit.EntryPage
	srv.Admin.Get("/api/audit-entries?record=acme/eu").Expect(200).JSON(&entries)
	if len(entries.Entries) != 3 { // created, edited, revert
		t.Fatalf("entries for acme/eu = %d", len(entries.Entries))
	}

	// MOD-13: the caps themselves are accepted; {} clears the renames.
	srv.Admin.Patch(base+"/eu", map[string]any{"renames": manyRenames(1000)}).Expect(200)
	srv.Admin.Patch(base+"/eu", map[string]any{"renames": map[string]string{strings.Repeat("m", 256): "x"}}).Expect(200)
	var cleared providers.EndpointResult
	srv.Admin.Patch(base+"/eu", map[string]any{"renames": map[string]string{}}).Expect(200).JSON(&cleared)
	if len(cleared.Endpoint.Renames) != 0 || !slices.Equal(cleared.Changes[0].Fields, []string{"renames"}) {
		t.Fatalf("cleared = %+v", cleared)
	}
}

// manyRenames is n distinct renames.
func manyRenames(n int) map[string]string {
	m := map[string]string{}
	for i := range n {
		m[fmt.Sprintf("m-%d", i)] = fmt.Sprintf("wire-%d", i)
	}
	return m
}

func TestKeysAreRestrictedToEndpointsAndEndpointDeletesKeepThemConsistent(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	for _, n := range []string{"eu", "us"} {
		srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": n, "url": "https://" + n + ".example.com/v1", "shape": "openai-chat"}).Expect(201)
		srv.Clock.Advance(time.Second) // Endpoints keep their creation order, also across a revert
	}
	keys := "/api/providers/acme/keys"
	var k providers.UpstreamKeyResult
	srv.Admin.Post(keys, map[string]any{"name": "plan", "secret": "sk-test-plan", "endpoints": []string{"eu"}}).Expect(201).JSON(&k)
	if !slices.Equal(k.UpstreamKey.Endpoints, []string{"eu"}) {
		t.Fatalf("created = %+v", k.UpstreamKey)
	}
	if e := srv.Admin.Post(keys, map[string]any{"name": "x", "secret": "sk-test-x", "endpoints": []string{"mars"}}).Expect(404).Err(); !strings.Contains(e.Hint, "/api/providers/acme/endpoints") {
		t.Fatalf("unknown endpoint: %+v", e)
	}
	// Pasting the same secret with a restriction restricts the existing key.
	srv.Admin.Post(keys, map[string]any{"secret": "sk-test-plan", "endpoints": []string{"eu", "us", "eu"}}).Expect(200).JSON(&k)
	if k.Outcome != "updated" || !slices.Equal(k.UpstreamKey.Endpoints, []string{"eu", "us"}) {
		t.Fatalf("restricted by secret = %+v", k)
	}
	srv.Admin.Patch(keys+"/plan", map[string]any{"endpoints": []string{"eu"}}).Expect(200)

	// An Endpoint a key may use alone cannot go.
	e := srv.Admin.Delete("/api/providers/acme/endpoints/eu").Expect(409).Err()
	if e.Code != "endpoint_in_use" || !strings.Contains(e.Message, "plan") || e.Hint == "" {
		t.Fatalf("delete in use: %+v", e)
	}
	// With another Endpoint left, the delete takes eu out of the key's
	// restriction in the same Audit Entry, and its revert puts both back.
	srv.Admin.Patch(keys+"/plan", map[string]any{"endpoints": []string{"eu", "us"}}).Expect(200)
	var del providers.EndpointResult
	srv.Admin.Delete("/api/providers/acme/endpoints/eu").Expect(200).JSON(&del)
	if len(del.Changes) != 2 || del.Changes[1].Name != "acme/plan" {
		t.Fatalf("delete = %+v", del)
	}
	var got providers.UpstreamKey
	srv.Admin.Get(keys + "/plan").Expect(200).JSON(&got)
	if !slices.Equal(got.Endpoints, []string{"us"}) {
		t.Fatalf("after delete = %+v", got.Endpoints)
	}
	srv.Admin.Post("/api/audit-entries/"+del.AuditEntry+"/revert", nil).Expect(200)
	srv.Admin.Get(keys + "/plan").Expect(200).JSON(&got)
	if !slices.Equal(got.Endpoints, []string{"eu", "us"}) {
		t.Fatalf("after revert = %+v", got.Endpoints)
	}

	// [] lifts the restriction; the key list shows it.
	srv.Admin.Patch(keys+"/plan", map[string]any{"endpoints": []string{}}).Expect(200)
	var list providers.UpstreamKeyList
	srv.Admin.Get(keys).Expect(200).JSON(&list)
	if len(list.UpstreamKeys) != 1 || list.UpstreamKeys[0].Endpoints == nil || len(list.UpstreamKeys[0].Endpoints) != 0 {
		t.Fatalf("list = %+v", list)
	}
}

type keyBulk = audit.BulkResult[providers.UpstreamKey]

func TestUpstreamKeysArePastedWithoutDuplicatesAndReadable(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	base := "/api/providers/acme/keys"

	var first providers.UpstreamKeyResult
	srv.Admin.Post(base, map[string]any{"secret": "  sk-test-aaaa1111  "}).Expect(201).JSON(&first)
	k1 := first.UpstreamKey
	if k1.Name != "key-1" || k1.Secret != "sk-test-aaaa1111" || k1.Provider != "acme" {
		t.Fatalf("first = %+v", k1)
	}
	if ch := first.Changes[0]; ch.Name != "acme/key-1" || strings.Contains(string(ch.After), "sk-test-aaaa1111") {
		t.Fatalf("change shows %s %s", ch.Name, ch.After)
	}
	// Pasting the same secret again answers that key unchanged.
	var again providers.UpstreamKeyResult
	srv.Admin.Post(base, map[string]any{"secret": "sk-test-aaaa1111"}).Expect(200).JSON(&again)
	if again.Outcome != "unchanged" || again.UpstreamKey.ID != k1.ID {
		t.Fatalf("repeat = %+v", again)
	}
	// Bulk paste: new keys get the next names, known ones are unchanged.
	var bulk keyBulk
	srv.Admin.Post(base+"/bulk", map[string]any{"items": []any{
		map[string]any{"secret": "sk-test-bbbb2222"}, map[string]any{"secret": "sk-test-aaaa1111"},
		map[string]any{"secret": "sk-test-cccc3333"}, map[string]any{"secret": "two words"},
	}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 3 || bulk.Failed != 1 || bulk.Items[0].Result.Name != "key-2" || bulk.Items[1].Outcome != "unchanged" ||
		bulk.Items[2].Result.Name != "key-3" || bulk.Items[3].Error == nil || bulk.AuditEntry == "" {
		t.Fatalf("bulk = %+v", bulk)
	}
	// A named keyless slot; a secret already held under another name is refused.
	var keyless providers.UpstreamKeyResult
	srv.Admin.Post(base, map[string]any{"name": "free-relay"}).Expect(201).JSON(&keyless)
	if keyless.UpstreamKey.Secret != "" {
		t.Fatalf("keyless = %+v", keyless)
	}
	if e := srv.Admin.Post(base, map[string]any{"name": "team-9", "secret": "sk-test-bbbb2222"}).Expect(409).Err(); e.Code != "upstream_key_duplicate" || !strings.Contains(e.Hint, "key-2") {
		t.Fatalf("duplicate: %+v", e)
	}
	if e := srv.Admin.Post(base, map[string]any{}).Expect(400).Err(); e.Hint == "" {
		t.Fatalf("empty: %+v", e)
	}

	// Secrets are readable by name or ID, singly and in the list.
	for _, ref := range []string{"key-1", k1.ID} {
		var got providers.UpstreamKey
		srv.Admin.Get(base + "/" + ref).Expect(200).JSON(&got)
		if got.Secret != "sk-test-aaaa1111" {
			t.Fatalf("read %s = %+v", ref, got)
		}
	}
	var list providers.UpstreamKeyList
	srv.Admin.Get(base).Expect(200).JSON(&list)
	var names []string
	for _, k := range list.UpstreamKeys {
		names = append(names, k.Name)
	}
	if !slices.Equal(names, []string{"key-1", "key-2", "key-3", "free-relay"}) || list.UpstreamKeys[2].Secret != "sk-test-cccc3333" {
		t.Fatalf("list = %+v", list)
	}
	var p providers.Provider
	srv.Admin.Get("/api/providers/acme").Expect(200).JSON(&p)
	if p.UpstreamKeyCount != 4 {
		t.Fatalf("count = %d", p.UpstreamKeyCount)
	}

	// Rename and replace the secret; delete in bulk and revert it all.
	var edited providers.UpstreamKeyResult
	srv.Admin.Patch(base+"/key-3", map[string]any{"name": "team-3", "secret": "sk-test-dddd4444"}).Expect(200).JSON(&edited)
	if edited.UpstreamKey.Name != "team-3" || edited.UpstreamKey.Secret != "sk-test-dddd4444" || !slices.Equal(edited.Changes[0].Fields, []string{"name", "secret"}) {
		t.Fatalf("edit = %+v", edited)
	}
	var del keyBulk
	srv.Admin.Post(base+"/bulk/delete", map[string]any{"items": []string{"key-1", "team-3", "nope"}}).Expect(200).JSON(&del)
	if del.Succeeded != 2 || del.Failed != 1 || del.Items[2].Error.Code != "not_found" {
		t.Fatalf("bulk delete = %+v", del)
	}
	srv.Admin.Get(base + "/key-1").Expect(404)
	srv.Admin.Post("/api/audit-entries/"+del.AuditEntry+"/revert", nil).Expect(200)
	var back providers.UpstreamKey
	srv.Admin.Get(base + "/team-3").Expect(200).JSON(&back)
	if back.Secret != "sk-test-dddd4444" {
		t.Fatalf("after revert = %+v", back)
	}
	var entries audit.EntryPage
	srv.Admin.Get("/api/audit-entries?record=acme/key-1").Expect(200).JSON(&entries)
	if len(entries.Entries) != 3 { // added, deleted, revert
		t.Fatalf("entries for acme/key-1 = %d", len(entries.Entries))
	}

	// Dry runs write nothing.
	var dry providers.UpstreamKeyResult
	srv.Admin.Post(base+"?dry_run=true", map[string]any{"secret": "sk-test-eeee5555"}).Expect(200).JSON(&dry)
	if !dry.DryRun || dry.Outcome != "created" {
		t.Fatalf("dry run = %+v", dry)
	}
	srv.Admin.Get(base).Expect(200).JSON(&list)
	if len(list.UpstreamKeys) != 4 {
		t.Fatalf("a dry run wrote a key: %d", len(list.UpstreamKeys))
	}
}
