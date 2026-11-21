package providers_test

import (
	"slices"
	"testing"

	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/testkit"
)

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

	srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(200)
	a, b, c = read("a"), read("b"), read("c")
	if !slices.Equal(a.Endpoints, []string{"eu"}) || b.Enabled || !slices.Equal(c.Endpoints, []string{"us"}) {
		t.Fatalf("after revert a=%v b.enabled=%v c=%v", a.Endpoints, b.Enabled, c.Endpoints)
	}

	srv.Admin.Post(keys+"/bulk/update", map[string]any{"items": []any{map[string]any{"enabled": false}}}).Expect(200).JSON(&res)
	if res.Failed != 1 {
		t.Fatalf("no key = %+v", res)
	}
	srv.Admin.Post(keys+"/bulk/update?dry_run=true", map[string]any{"items": []any{map[string]any{"key": "a", "enabled": false}}}).Expect(200).JSON(&res)
	if !res.DryRun || res.Items[0].Outcome != "updated" || !read("a").Enabled {
		t.Fatalf("dry run = %+v", res)
	}
	srv.Admin.Post(keys+"/bulk/update", map[string]any{"items": []any{map[string]any{"key": "a", "secret": "sk-x"}}}).Expect(400)
}

func TestBulkEndpointChangesApplyToEachKeysCurrentList(t *testing.T) {
	srv := testkit.Start(t)
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	for _, n := range []string{"eu", "us", "asia"} {
		srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": n, "url": "https://" + n + ".example.com/v1", "shape": "openai-chat"}).Expect(201)
	}
	keys := "/api/providers/acme/keys"
	srv.Admin.Post(keys, map[string]any{"name": "a", "secret": "sk-test-a", "endpoints": []string{"eu"}}).Expect(201)
	srv.Admin.Post(keys, map[string]any{"name": "b", "secret": "sk-test-b"}).Expect(201)
	srv.Admin.Post(keys, map[string]any{"name": "c", "secret": "sk-test-c", "endpoints": []string{"us", "asia"}}).Expect(201)
	read := func(name string) []string {
		var k providers.UpstreamKey
		srv.Admin.Get(keys + "/" + name).Expect(200).JSON(&k)
		out := slices.Clone(k.Endpoints)
		slices.Sort(out)
		return out
	}

	srv.Admin.Patch(keys+"/a", map[string]any{"endpoints": []string{"eu", "us"}}).Expect(200)

	var res audit.BulkResult[providers.UpstreamKey]
	srv.Admin.Post(keys+"/bulk/update", map[string]any{"items": []any{
		map[string]any{"key": "a", "endpoints_add": []string{"asia"}},
		map[string]any{"key": "b", "endpoints_remove": []string{"asia"}},
		map[string]any{"key": "c", "endpoints_add": []string{"eu"}, "endpoints_remove": []string{"asia"}},
	}}).Expect(200).JSON(&res)
	if res.Succeeded != 3 || res.AuditEntry == "" {
		t.Fatalf("bulk update = %+v", res)
	}
	if got := read("a"); len(got) != 0 {
		t.Fatalf("a = %v, want every Endpoint (no restriction)", got)
	}
	if got := read("b"); !slices.Equal(got, []string{"eu", "us"}) {
		t.Fatalf("b = %v", got)
	}
	if got := read("c"); !slices.Equal(got, []string{"eu", "us"}) {
		t.Fatalf("c = %v", got)
	}

	srv.Admin.Post(keys+"/bulk/update", map[string]any{"items": []any{map[string]any{"key": "c", "endpoints_remove": []string{"eu", "us"}}}}).Expect(200).JSON(&res)
	if res.Succeeded != 1 || len(read("c")) != 0 {
		t.Fatalf("c emptied = %+v, %v", res, read("c"))
	}

	srv.Admin.Post(keys+"/bulk/update", map[string]any{"items": []any{
		map[string]any{"key": "a", "endpoints": []string{"eu"}, "endpoints_add": []string{"us"}},
		map[string]any{"key": "a", "endpoints_add": []string{"us"}, "endpoints_remove": []string{"us"}},
		map[string]any{"key": "a", "endpoints_add": []string{"mars"}},
	}}).Expect(200).JSON(&res)
	if res.Failed != 3 {
		t.Fatalf("bad items = %+v", res)
	}
	for i, code := range []string{"invalid_request", "invalid_request", "not_found"} {
		if it := res.Items[i]; it.Error == nil || it.Error.Code != code {
			t.Fatalf("item %d = %+v, want %s", i, it, code)
		}
	}
}
