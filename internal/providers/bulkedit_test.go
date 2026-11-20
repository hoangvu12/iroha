package providers_test

import (
	"slices"
	"testing"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// UI ticket 30: one call edits many Upstream Keys; fields an item leaves out
// stay as each key has them, one Audit Entry reverts the lot, and a key that
// can't be changed fails alone and is named by its index.
func TestManyUpstreamKeysAreEditedInOneRevertibleCall(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	for _, n := range []string{"eu", "us", "asia"} {
		srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": n, "url": "https://" + n + ".example.com/v1", "shape": "openai-chat"}).Expect(201)
	}
	keys := "/api/providers/acme/keys"
	srv.Admin.Post(keys, map[string]any{"name": "a", "secret": "sk-test-a", "endpoints": []string{"eu"}}).Expect(201)
	srv.Admin.Post(keys, map[string]any{"name": "b", "secret": "sk-test-b"}).Expect(201)
	srv.Admin.Post(keys+"/b/disable", nil).Expect(200)
	srv.Admin.Post(keys, map[string]any{"name": "c", "secret": "sk-test-c", "endpoints": []string{"us"}}).Expect(201)

	read := func(name string) providers.UpstreamKey {
		var k providers.UpstreamKey
		srv.Admin.Get(keys + "/" + name).Expect(200).JSON(&k)
		return k
	}

	// Enable a and b; give a and c "asia" on top of what each has. c's
	// enabled is left out, so it stays as it is.
	var res audit.BulkResult[providers.UpstreamKey]
	srv.Admin.Post(keys+"/bulk/update", map[string]any{"items": []any{
		map[string]any{"key": "a", "enabled": true, "endpoints": []string{"eu", "asia"}},
		map[string]any{"key": "b", "enabled": true},
		map[string]any{"key": "c", "endpoints": []string{"us", "asia"}},
		map[string]any{"key": "gone", "enabled": true},
	}}).Expect(200).JSON(&res)
	if res.Succeeded != 3 || res.Failed != 1 || res.AuditEntry == "" {
		t.Fatalf("bulk update = %+v", res)
	}
	if it := res.Items[3]; it.OK || it.Error == nil || it.Error.Code != "not_found" || it.Index != 3 {
		t.Fatalf("missing key item = %+v", it)
	}
	if it := res.Items[0]; !it.OK || it.Outcome != "unchanged" && it.Outcome != "updated" {
		t.Fatalf("a item = %+v", it)
	}
	a, b, c := read("a"), read("b"), read("c")
	if !a.Enabled || !slices.Equal(a.Endpoints, []string{"asia", "eu"}) && !slices.Equal(a.Endpoints, []string{"eu", "asia"}) {
		t.Fatalf("a = %+v", a)
	}
	if !b.Enabled || len(b.Endpoints) != 0 {
		t.Fatalf("b = %+v", b)
	}
	if !c.Enabled || len(c.Endpoints) != 2 {
		t.Fatalf("c = %+v", c)
	}

	// One Audit Entry: its revert puts every key back as it was.
	srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(200)
	a, b, c = read("a"), read("b"), read("c")
	if !slices.Equal(a.Endpoints, []string{"eu"}) || b.Enabled || !slices.Equal(c.Endpoints, []string{"us"}) {
		t.Fatalf("after revert a=%v b.enabled=%v c=%v", a.Endpoints, b.Enabled, c.Endpoints)
	}

	// An item must address a key, and the dry run writes nothing.
	srv.Admin.Post(keys+"/bulk/update", map[string]any{"items": []any{map[string]any{"enabled": false}}}).Expect(200).JSON(&res)
	if res.Failed != 1 {
		t.Fatalf("no key = %+v", res)
	}
	srv.Admin.Post(keys+"/bulk/update?dry_run=true", map[string]any{"items": []any{map[string]any{"key": "a", "enabled": false}}}).Expect(200).JSON(&res)
	if !res.DryRun || res.Items[0].Outcome != "updated" || !read("a").Enabled {
		t.Fatalf("dry run = %+v", res)
	}
	// Names and secrets are not bulk-edited: unknown fields are refused.
	srv.Admin.Post(keys+"/bulk/update", map[string]any{"items": []any{map[string]any{"key": "a", "secret": "sk-x"}}}).Expect(400)
}
