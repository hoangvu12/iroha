package audit_test

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"

	"github.com/hoangvu12/iroha/internal/admintokens"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/testkit"
)

type restCase struct {
	resource string
	label    string
	setup    func(srv *testkit.Server)
	path     string
	nameKey  string
	existing map[string]any
	partial  map[string]any
	field    string
	fresh    map[string]any
}

func (rc restCase) item(name string) string { return rc.path + "/" + name }

func (rc restCase) name(body map[string]any) string { return body[rc.nameKey].(string) }

func (rc restCase) without(body map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range body {
		if k != rc.nameKey {
			out[k] = v
		}
	}
	return out
}

func (rc restCase) named(body map[string]any, name string) map[string]any {
	out := rc.without(body)
	out[rc.nameKey] = name
	return out
}

const heldSecret = "sk-held-0123456789abcdef"

var restCases = []restCase{
	{
		resource: "provider", label: "Provider", path: "/api/providers", nameKey: "handle",
		existing: map[string]any{"handle": "acme"},
		partial:  map[string]any{"name": "Renamed"}, field: "name",
		fresh: map[string]any{"handle": "beta", "name": "Beta"},
	},
	{
		resource: "endpoint", label: "Endpoint", setup: withProvider, path: "/api/providers/acme/endpoints", nameKey: "name",
		existing: map[string]any{"name": "main", "url": "https://a.example.com/v1", "shape": "openai-chat"},
		partial:  map[string]any{"renames": map[string]string{"x": "y"}}, field: "renames",
		fresh: map[string]any{"name": "second", "url": "https://b.example.com/v1", "shape": "anthropic-messages"},
	},
	{
		resource: "upstream_key", label: "Upstream Key", setup: withProvider, path: "/api/providers/acme/keys", nameKey: "name",
		existing: map[string]any{"name": "main", "secret": heldSecret},
		partial:  map[string]any{"secret": "sk-other-0123456789abcdef"}, field: "secret",
		fresh: map[string]any{"name": "second"},
	},
	{
		resource: "gateway_key", label: "Gateway Key", path: "/api/gateway-keys", nameKey: "name",
		existing: map[string]any{"name": "pi", "scope": map[string]any{"all": true}},
		partial:  map[string]any{"capture": true}, field: "capture",
		fresh: map[string]any{"name": "pi-2", "scope": map[string]any{"all": true}},
	},
	{
		resource: "admin_token", label: "Admin Token", path: "/api/admin-tokens", nameKey: "name",
		existing: map[string]any{"name": "worker", "note": "first"},
		partial:  map[string]any{"note": "second"}, field: "note",
		fresh: map[string]any{"name": "worker-2", "note": "fresh"},
	},
	{
		resource: "pool", label: "Model Pool", path: "/api/pools", nameKey: "name",
		existing: map[string]any{"name": "fast"},
		partial:  map[string]any{"maker": "openai"}, field: "maker",
		fresh: map[string]any{"name": "slow"},
	},
	{
		resource: "failure_rule", label: "Failure Rule", path: "/api/rules", nameKey: "name",
		existing: map[string]any{"name": "arrears", "code": []string{"Arrearage"}, "outcome": "invalid"},
		partial:  map[string]any{"description": "Account in arrears."}, field: "description",
		fresh: map[string]any{"name": "quota", "code": []string{"Quota"}, "outcome": "invalid"},
	},
}

func withProvider(srv *testkit.Server) {
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
}

func newestEntry(t *testing.T, srv *testkit.Server) string {
	t.Helper()
	es := entries(t, srv.Admin, "limit=1")
	if len(es) == 0 {
		return ""
	}
	return es[0].ID
}

func entry(t *testing.T, srv *testkit.Server, id string) audit.Entry {
	t.Helper()
	var e audit.Entry
	srv.Admin.Get("/api/audit-entries/" + id).Expect(200).JSON(&e)
	return e
}

func startCase(t *testing.T, rc restCase) *testkit.Server {
	t.Helper()
	srv := testkit.Start(t)
	if rc.setup != nil {
		rc.setup(srv)
	}
	return srv
}

func config(t *testing.T, srv *testkit.Server, path string) string {
	t.Helper()
	m := srv.Admin.Get(path).Expect(200).Map()
	for _, k := range []string{"state", "last_used_at", "hits", "last_hit_at", "worked_on", "model_gaps", "endpoint_gaps", "recent_requests", "order"} {
		delete(m, k)
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func TestPostRefusesATakenNameAndWritesNothing(t *testing.T) {
	for _, rc := range restCases {
		t.Run(rc.resource, func(t *testing.T) {
			srv := startCase(t, rc)
			srv.Admin.Post(rc.path, rc.existing).Expect(201)
			read := rc.item(rc.name(rc.existing))
			before := config(t, srv, read)
			last := newestEntry(t, srv)

			for _, body := range []map[string]any{rc.existing, rc.named(rc.partial, rc.name(rc.existing))} {
				for _, q := range []string{"", "?dry_run=true"} {
					r := srv.Admin.Post(rc.path+q, body).Expect(http.StatusConflict)
					e := r.Err()
					if e.Code != "name_taken" || !strings.Contains(e.Message, rc.label) || !strings.Contains(e.Hint, "PUT "+read) {
						t.Errorf("POST%s: error = %+v", q, e)
					}
					if d, _ := e.Details.(map[string]any); d["resource"] != rc.resource || d["id"] == "" {
						t.Errorf("POST%s: details = %+v", q, e.Details)
					}
					if strings.Contains(r.Text(), heldSecret[len(heldSecret)-6:]) {
						t.Errorf("POST%s: the refusal shows the secret: %s", q, r.Text())
					}
				}
			}
			if got := config(t, srv, read); got != before {
				t.Errorf("record changed:\nbefore %s\nafter  %s", before, got)
			}
			if got := newestEntry(t, srv); got != last {
				t.Errorf("an Audit Entry was written: %s", got)
			}

			var res audit.Result
			srv.Admin.Post(rc.path, rc.fresh).Expect(201).JSON(&res)
			if res.Outcome != audit.OutcomeCreated || entry(t, srv, res.AuditEntry).Action != rc.resource+".create" {
				t.Errorf("POST of a new name = %+v", res)
			}
		})
	}
}

func TestPutCreatesWhenAbsentAndAppliesOnlyTheFieldsSent(t *testing.T) {
	for _, rc := range restCases {
		t.Run(rc.resource, func(t *testing.T) {
			srv := startCase(t, rc)
			path := rc.item(rc.name(rc.existing))

			var dry audit.Result
			srv.Admin.Put(path+"?dry_run=true", rc.without(rc.existing)).Expect(200).JSON(&dry)
			if !dry.DryRun || dry.Outcome != audit.OutcomeCreated || dry.AuditEntry != "" {
				t.Fatalf("dry PUT of an absent record = %+v", dry)
			}
			srv.Admin.Get(path).Expect(404)

			var created audit.Result
			srv.Admin.Put(path, rc.without(rc.existing)).Expect(201).JSON(&created)
			if created.Outcome != audit.OutcomeCreated {
				t.Fatalf("PUT of an absent record = %+v", created)
			}
			if e := entry(t, srv, created.AuditEntry); e.Action != rc.resource+".create" {
				t.Fatalf("PUT create entry action = %q", e.Action)
			}
			before := config(t, srv, path)

			var same audit.Result
			srv.Admin.Put(path, rc.existing).Expect(200).JSON(&same)
			if same.Outcome != audit.OutcomeUnchanged || same.AuditEntry != "" {
				t.Fatalf("PUT of the same fields = %+v", same)
			}

			srv.Admin.Put(path+"?dry_run=true", rc.partial).Expect(200).JSON(&dry)
			if !dry.DryRun || dry.Outcome != audit.OutcomeUpdated || dry.AuditEntry != "" {
				t.Fatalf("dry PUT of a change = %+v", dry)
			}
			if got := config(t, srv, path); got != before {
				t.Fatalf("a dry run changed the record: %s", got)
			}

			var updated audit.Result
			srv.Admin.Put(path, rc.partial).Expect(200).JSON(&updated)
			if updated.Outcome != audit.OutcomeUpdated || len(updated.Changes) == 0 || !slices.Equal(updated.Changes[0].Fields, []string{rc.field}) {
				t.Fatalf("PUT of a change = %+v", updated)
			}
			if e := entry(t, srv, updated.AuditEntry); e.Action != rc.resource+".update" {
				t.Fatalf("PUT update entry action = %q", e.Action)
			}

			revert(t, srv.Admin, updated.AuditEntry, 200)
			if got := config(t, srv, path); got != before {
				t.Fatalf("revert of the PUT update:\nwant %s\ngot  %s", before, got)
			}
			revert(t, srv.Admin, created.AuditEntry, 200)
			srv.Admin.Get(path).Expect(404)
		})
	}
}

func TestPutRefusesABodyNameOtherThanThePath(t *testing.T) {
	for _, rc := range restCases {
		t.Run(rc.resource, func(t *testing.T) {
			srv := startCase(t, rc)
			path := rc.item(rc.name(rc.existing))
			last := newestEntry(t, srv)
			e := srv.Admin.Put(path, rc.named(rc.existing, "other")).Expect(400).Err()
			if !strings.Contains(e.Message, `"other"`) || !strings.Contains(e.Hint, "PATCH") {
				t.Fatalf("error = %+v", e)
			}
			if newestEntry(t, srv) != last {
				t.Fatal("a refused PUT wrote an Audit Entry")
			}
			srv.Admin.Post(rc.path, rc.existing).Expect(201)
			srv.Admin.Put(path, rc.named(rc.existing, "other")).Expect(400)
			srv.Admin.Put(path, rc.existing).Expect(200)
		})
	}
}

func TestBulkPostCreatesAndBulkPutCreatesOrUpdates(t *testing.T) {
	for _, rc := range restCases {
		t.Run(rc.resource, func(t *testing.T) {
			srv := startCase(t, rc)
			srv.Admin.Post(rc.path, rc.existing).Expect(201)
			path := rc.item(rc.name(rc.existing))
			before := config(t, srv, path)

			post := map[string]any{"items": []any{rc.existing, rc.fresh}}
			var dry audit.BulkResult[json.RawMessage]
			srv.Admin.Post(rc.path+"/bulk?dry_run=true", post).Expect(200).JSON(&dry)
			if !dry.DryRun || dry.Failed != 1 || dry.Succeeded != 1 || dry.Items[0].Error.Code != "name_taken" || dry.Items[1].Outcome != audit.OutcomeCreated {
				t.Fatalf("dry bulk POST = %+v", dry)
			}
			var res audit.BulkResult[json.RawMessage]
			srv.Admin.Post(rc.path+"/bulk", post).Expect(200).JSON(&res)
			if res.Failed != 1 || res.Succeeded != 1 || res.AuditEntry == "" || len(res.Items[0].Changes) != 0 {
				t.Fatalf("bulk POST = %+v", res)
			}
			if e := entry(t, srv, res.AuditEntry); e.Action != rc.resource+".create" || len(e.Changes) != 1 {
				t.Fatalf("bulk POST entry = %+v", e)
			}
			if got := config(t, srv, path); got != before {
				t.Fatalf("bulk POST changed the existing record: %s", got)
			}

			third := rc.named(rc.fresh, "third")
			if rc.resource == "endpoint" {
				third["url"] = "https://c.example.com/v1"
			}
			put := map[string]any{"items": []any{rc.named(rc.partial, rc.name(rc.existing)), third}}
			dry = audit.BulkResult[json.RawMessage]{}
			srv.Admin.Put(rc.path+"/bulk?dry_run=true", put).Expect(200).JSON(&dry)
			if !dry.DryRun || dry.Succeeded != 2 || dry.Items[0].Outcome != audit.OutcomeUpdated || dry.Items[1].Outcome != audit.OutcomeCreated {
				t.Fatalf("dry bulk PUT = %+v", dry)
			}
			res = audit.BulkResult[json.RawMessage]{}
			srv.Admin.Put(rc.path+"/bulk", put).Expect(200).JSON(&res)
			if res.Succeeded != 2 || res.Items[0].Outcome != audit.OutcomeUpdated || res.Items[1].Outcome != audit.OutcomeCreated {
				t.Fatalf("bulk PUT = %+v", res)
			}
			mixed := res.AuditEntry
			if e := entry(t, srv, mixed); e.Action != rc.resource+".update" || len(e.Changes) != 2 {
				t.Fatalf("mixed bulk PUT entry = %+v", e)
			}
			res = audit.BulkResult[json.RawMessage]{}
			srv.Admin.Put(rc.path+"/bulk", put).Expect(200).JSON(&res)
			if res.AuditEntry != "" || res.Items[0].Outcome != audit.OutcomeUnchanged || res.Items[1].Outcome != audit.OutcomeUnchanged {
				t.Fatalf("repeated bulk PUT = %+v", res)
			}
			revert(t, srv.Admin, mixed, 200)
			srv.Admin.Get(rc.item("third")).Expect(404)
			if got := config(t, srv, path); got != before {
				t.Fatalf("revert of the bulk PUT left %s", got)
			}
		})
	}
}

func TestAPutBulkThatOnlyCreatesIsACreate(t *testing.T) {
	srv := testkit.Start(t)
	var res audit.BulkResult[admintokens.Token]
	srv.Admin.Put("/api/admin-tokens/bulk", map[string]any{"items": []any{map[string]any{"name": "a"}, map[string]any{"name": "b"}}}).Expect(200).JSON(&res)
	if e := entry(t, srv, res.AuditEntry); e.Action != "admin_token.create" || e.Summary != "Created 2 Admin Tokens" {
		t.Fatalf("entry = %+v", e)
	}
	res = audit.BulkResult[admintokens.Token]{}
	srv.Admin.Put("/api/admin-tokens/bulk", map[string]any{"items": []any{map[string]any{"name": "a", "note": "x"}, map[string]any{"name": "b", "note": "y"}}}).Expect(200).JSON(&res)
	if e := entry(t, srv, res.AuditEntry); e.Action != "admin_token.update" || e.Summary != "Edited 2 Admin Tokens" {
		t.Fatalf("entry = %+v", e)
	}
}

func TestPostRefusesAnEndpointOfTheSameURLAndShape(t *testing.T) {
	srv := testkit.Start(t)
	withProvider(srv)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": "https://a.example.com/v1", "shape": "openai-chat"}).Expect(201)
	last := newestEntry(t, srv)
	before := srv.Admin.Get("/api/providers/acme/endpoints").Expect(200).Text()

	for _, body := range []map[string]any{
		{"url": "https://a.example.com/v1", "shape": "openai-chat", "renames": map[string]string{"x": "y"}},
		{"name": "other", "url": "https://A.example.com/v1/", "shape": "openai-chat"},
	} {
		for _, q := range []string{"", "?dry_run=true"} {
			e := srv.Admin.Post("/api/providers/acme/endpoints"+q, body).Expect(409).Err()
			if e.Code != "endpoint_duplicate" || !strings.Contains(e.Message, "default") || !strings.Contains(e.Hint, "default") {
				t.Fatalf("error = %+v", e)
			}
		}
	}
	if newestEntry(t, srv) != last || srv.Admin.Get("/api/providers/acme/endpoints").Expect(200).Text() != before {
		t.Fatal("a refused create wrote something")
	}
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"name": "messages", "url": "https://a.example.com/v1", "shape": "anthropic-messages"}).Expect(201)
	if e := srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": "https://c.example.com/v1", "shape": "openai-chat"}).Expect(409).Err(); e.Code != "name_taken" {
		t.Fatalf("a nameless create when default is taken = %+v", e)
	}
}

func TestPostRefusesAHeldSecretWithoutShowingIt(t *testing.T) {
	srv := testkit.Start(t)
	withProvider(srv)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": heldSecret}).Expect(201)
	last := newestEntry(t, srv)

	for _, body := range []map[string]any{{"secret": heldSecret}, {"name": "copy", "secret": heldSecret}} {
		for _, q := range []string{"", "?dry_run=true"} {
			r := srv.Admin.Post("/api/providers/acme/keys"+q, body).Expect(409)
			if e := r.Err(); e.Code != "upstream_key_duplicate" || !strings.Contains(e.Message, "key-1") {
				t.Fatalf("error = %+v", e)
			}
			if strings.Contains(r.Text(), heldSecret) || strings.Contains(r.Text(), heldSecret[len(heldSecret)-4:]) {
				t.Fatalf("the error shows the secret: %s", r.Text())
			}
		}
	}
	var bulk audit.BulkResult[map[string]any]
	srv.Admin.Post("/api/providers/acme/keys/bulk", map[string]any{"items": []any{map[string]any{"secret": heldSecret}}}).Expect(200).JSON(&bulk)
	if bulk.Failed != 1 || bulk.Items[0].Error.Code != "upstream_key_duplicate" {
		t.Fatalf("bulk = %+v", bulk)
	}
	if strings.Contains(srv.Console(), heldSecret) {
		t.Fatal("the secret reached the console")
	}
	if newestEntry(t, srv) != last {
		t.Fatal("an Audit Entry was written")
	}
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "slot"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"name": "slot"}).Expect(409)
}

func TestAPostOfABuiltinRuleNameIsTakenAndPutOverridesIt(t *testing.T) {
	srv := testkit.Start(t)
	var list struct {
		Rules []struct {
			Name   string `json:"name"`
			Source string `json:"source"`
		} `json:"rules"`
	}
	srv.Admin.Get("/api/rules").Expect(200).JSON(&list)
	name := list.Rules[len(list.Rules)-1].Name
	if e := srv.Admin.Post("/api/rules", map[string]any{"name": name, "description": "mine"}).Expect(409).Err(); e.Code != "name_taken" || !strings.Contains(e.Hint, "PUT /api/rules/"+name) {
		t.Fatalf("error = %+v", e)
	}
	var res audit.Result
	srv.Admin.Put("/api/rules/"+name, map[string]any{"description": "mine"}).Expect(200).JSON(&res)
	if res.Outcome != audit.OutcomeUpdated || entry(t, srv, res.AuditEntry).Action != "failure_rule.update" {
		t.Fatalf("override = %+v", res)
	}
	revert(t, srv.Admin, res.AuditEntry, 200)
	if src := srv.Admin.Get("/api/rules/" + name).Expect(200).Map()["source"]; src != "builtin" {
		t.Fatalf("after revert the rule is %v", src)
	}
}

func TestPutAddressesARecordByIDAndAnOldCreateEntryStillReverts(t *testing.T) {
	srv := testkit.Start(t)
	created := create(t, srv.Admin, map[string]any{"name": "worker", "note": "first"})
	var res admintokens.TokenResult
	srv.Admin.Put("/api/admin-tokens/"+created.AdminToken.ID, map[string]any{"name": "worker", "note": "second"}).Expect(200).JSON(&res)
	if res.Outcome != audit.OutcomeUpdated || res.AdminToken.ID != created.AdminToken.ID {
		t.Fatalf("PUT by ID = %+v", res)
	}
	if _, err := srv.App.DB().ExecContext(t.Context(), `UPDATE audit_entries SET action = 'admin_token.create' WHERE id = ?`, res.AuditEntry); err != nil {
		t.Fatal(err)
	}
	if e := entry(t, srv, res.AuditEntry); e.Action != "admin_token.create" || !e.Revertible {
		t.Fatalf("old-style entry = %+v", e)
	}
	revert(t, srv.Admin, res.AuditEntry, 200)
	if tok := token(t, srv, "worker"); tok.Note != "first" {
		t.Fatalf("after revert: %+v", tok)
	}
}

func TestPostAndPutKeepRevokedNamesRetired(t *testing.T) {
	srv := testkit.Start(t)
	create(t, srv.Admin, map[string]any{"name": "gone"})
	srv.Admin.Post("/api/admin-tokens/gone/revoke", nil).Expect(200)
	for _, r := range []*testkit.Response{
		srv.Admin.Post("/api/admin-tokens", map[string]any{"name": "gone"}),
		srv.Admin.Put("/api/admin-tokens/gone", map[string]any{"note": "x"}),
	} {
		if e := r.Expect(409).Err(); e.Code != "admin_token_revoked" {
			t.Fatalf("error = %+v", e)
		}
	}
}

func TestEveryResourceHasPostCreatesAndPutCreateOrUpdate(t *testing.T) {
	srv := testkit.Start(t)
	var want []string
	for _, p := range []struct{ list, item string }{
		{"/api/providers", "{provider}"}, {"/api/providers/{provider}/endpoints", "{endpoint}"}, {"/api/providers/{provider}/keys", "{key}"},
		{"/api/gateway-keys", "{key}"}, {"/api/admin-tokens", "{token}"}, {"/api/pools", "{pool}"}, {"/api/rules", "{rule}"},
	} {
		want = append(want, "POST "+p.list, "POST "+p.list+"/bulk", "PUT "+p.list+"/"+p.item, "PUT "+p.list+"/bulk")
	}
	var got []string
	for _, r := range srv.App.Routes() {
		if !slices.Contains(want, r.Pattern()) {
			continue
		}
		got = append(got, r.Pattern())
		if len(r.Query) != 1 || r.Query[0].Name != "dry_run" {
			t.Errorf("%s takes %v; dry_run is its only parameter", r.Pattern(), r.Query)
		}
	}
	slices.Sort(want)
	slices.Sort(got)
	if !slices.Equal(got, want) {
		t.Fatalf("routes:\n got %v\nwant %v", got, want)
	}
}
