package providers_test

import (
	"slices"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestProviderHandlesAreValidatedUniqueAndImmutable(t *testing.T) {
	srv := testkit.Start(t)
	for _, bad := range []string{"", "Acme", "my_provider", "-acme", "acme-", "ac--me", "a.b", strings.Repeat("a", 64), "bulk"} {
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
