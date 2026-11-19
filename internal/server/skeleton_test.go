package server_test

import (
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/admintokens"
	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/store"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestFirstStartPrintsBootstrapAdminTokenOnce(t *testing.T) {
	srv := testkit.Start(t)

	if !strings.HasPrefix(srv.AdminToken, admintokens.SecretPrefix+"_") {
		t.Fatalf("bootstrap token %q lacks prefix", srv.AdminToken)
	}
	if !strings.Contains(srv.Console(), srv.AdminToken) {
		t.Fatalf("first start did not print the token; console:\n%s", srv.Console())
	}
	var actor api.Actor
	srv.Admin.Get("/api/whoami").Expect(200).JSON(&actor)
	if actor.Name != "bootstrap" || actor.Kind != api.ActorAdminToken {
		t.Fatalf("whoami = %+v", actor)
	}

	srv.Restart()
	if strings.Contains(srv.Console(), srv.AdminToken) || srv.App.BootstrapToken().Secret != "" {
		t.Fatalf("second start printed or created a token again; console:\n%s", srv.Console())
	}
	srv.Admin.Get("/api/whoami").Expect(200) // the old token still works
	if n := len(srv.Logs("kind=admin_token.bootstrap")); n != 1 {
		t.Fatalf("bootstrap events = %d, want 1", n)
	}
	for _, line := range testkit.Lines(srv.Console()) {
		if strings.Contains(line, srv.AdminToken) {
			t.Fatalf("token leaked into a log line: %s", line)
		}
	}
}

func TestBootstrapTokenIsNotReissuedAfterRevocation(t *testing.T) {
	srv := testkit.Start(t)
	other := srv.NewAdminToken("other")
	other.Post("/api/admin-tokens/bootstrap/revoke", nil).Expect(200)
	srv.Restart()
	if srv.App.BootstrapToken().Secret != "" {
		t.Fatal("a revoked bootstrap token was replaced on restart")
	}
}

func TestMigrationsApplyOnStartAndOnlyOnce(t *testing.T) {
	srv := testkit.Start(t)
	all, err := store.Migrations()
	if err != nil {
		t.Fatal(err)
	}
	first := srv.Logs("kind=startup")[0]
	if got := first.Attrs["migrations_total"]; got != float64(len(all)) {
		t.Fatalf("migrations_total = %v, want %d", got, len(all))
	}
	applied, _ := first.Attrs["migrations_applied"].([]any)
	if len(applied) != len(all) || applied[0] != all[0].Name {
		t.Fatalf("first start applied %v, want all %d migrations", applied, len(all))
	}
	if n := len(srv.Logs("kind=migration")); n != len(all) {
		t.Fatalf("migration events = %d, want %d", n, len(all))
	}

	srv.Restart()
	second := srv.Logs("kind=startup")[0]
	if applied, _ := second.Attrs["migrations_applied"].([]any); len(applied) != 0 {
		t.Fatalf("restart re-applied %v", applied)
	}
}

func TestLivenessAndReadiness(t *testing.T) {
	srv := testkit.Start(t, testkit.Options{Version: "1.2.3"})
	var h struct{ Status, Version string }
	srv.Anon.Get("/healthz").Expect(200).JSON(&h)
	if h.Status != "ok" || h.Version != "1.2.3" {
		t.Fatalf("healthz = %+v", h)
	}
	srv.Anon.Get("/readyz").Expect(200).JSON(&h)
	if h.Status != "ready" || h.Version != "1.2.3" {
		t.Fatalf("readyz = %+v", h)
	}
}

func TestAdminRoutesRefuseMissingUnknownAndRevokedTokens(t *testing.T) {
	srv := testkit.Start(t)
	agent := srv.NewAdminToken("agent-1")
	agent.Get("/api/logs").Expect(200)
	srv.Admin.Post("/api/admin-tokens/agent-1/revoke", nil).Expect(200)

	cases := []struct {
		name   string
		client *testkit.Client
		code   string
	}{
		{"missing", srv.Anon, "admin_token_missing"},
		{"unknown", srv.Client("iroha_admin_not-a-real-token"), "admin_token_invalid"},
		{"revoked", agent, "admin_token_revoked"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			for _, path := range []string{"/api/logs", "/api/whoami"} {
				e := tc.client.Get(path).Expect(http.StatusUnauthorized).Err()
				if e.Code != tc.code || e.Hint == "" || e.Message == "" {
					t.Fatalf("%s: error = %+v, want code %s with message and hint", path, e, tc.code)
				}
			}
		})
	}
	// Public routes need no token.
	srv.Anon.Get("/skill.md").Expect(200)
	srv.Anon.Get("/api/openapi.json").Expect(200)
}

func TestUnknownRoutesAndWrongMethodsAnswerWithHints(t *testing.T) {
	srv := testkit.Start(t)
	e := srv.Admin.Get("/api/nope").Expect(404).Err()
	if e.Code != "not_found" || !strings.Contains(e.Hint, "/api/openapi.json") {
		t.Fatalf("404 error = %+v", e)
	}
	r := srv.Admin.Post("/api/logs", map[string]any{}).Expect(405)
	if r.Header.Get("Allow") != "GET" || r.Err().Hint == "" {
		t.Fatalf("405 Allow=%q body=%s", r.Header.Get("Allow"), r.Body)
	}
}

func TestDocumentsDescribeEveryRegisteredRoute(t *testing.T) {
	srv := testkit.Start(t)
	var doc struct {
		OpenAPI string                               `json:"openapi"`
		Info    struct{ Version string }             `json:"info"`
		Paths   map[string]map[string]map[string]any `json:"paths"`
	}
	srv.Anon.Get("/api/openapi.json").Expect(200).JSON(&doc)
	if !strings.HasPrefix(doc.OpenAPI, "3.1") || doc.Info.Version != "test" {
		t.Fatalf("openapi header = %q %q", doc.OpenAPI, doc.Info.Version)
	}
	skill := srv.Anon.Get("/skill.md").Expect(200).Text()
	if !strings.HasPrefix(skill, "---\nname: iroha\n") {
		t.Fatalf("skill lacks frontmatter:\n%.200s", skill)
	}
	if !strings.Contains(skill, "\n## Deploying Iroha\n") || !strings.Contains(skill, "deploy/deploy.sh --host") {
		t.Fatal("skill lacks the deploy runbook")
	}

	routes := srv.App.Routes()
	var admin int
	for _, r := range routes {
		if r.Hidden {
			continue
		}
		if strings.HasPrefix(r.Path, "/api/") {
			admin++
		}
		op, ok := doc.Paths[r.DocPath()][strings.ToLower(r.Method)]
		if !ok {
			t.Errorf("openapi lacks %s %s", r.Method, r.DocPath())
			continue
		}
		if op["summary"] != r.Summary || op["operationId"] != api.OperationID(r) {
			t.Errorf("openapi %s: summary/operationId drifted: %v", r.Pattern(), op)
		}
		if r.Auth == api.AuthAdmin && op["security"] == nil {
			t.Errorf("openapi %s: admin route without security", r.Pattern())
		}
		if !strings.Contains(skill, "`"+r.Method+" "+r.DocPath()+"`") {
			t.Errorf("skill lacks %s %s", r.Method, r.DocPath())
		}
	}
	if admin < 3 {
		t.Fatalf("only %d admin routes registered", admin)
	}
	// Nothing documented that is not served.
	var documented int
	for _, ops := range doc.Paths {
		documented += len(ops)
	}
	if visible := len(slices.DeleteFunc(slices.Clone(routes), func(r api.Route) bool { return r.Hidden })); documented != visible {
		t.Fatalf("openapi documents %d operations, router serves %d", documented, visible)
	}
	// The served schema of a response is reflected from the Go type.
	var full map[string]any
	srv.Anon.Get("/api/openapi.json").JSON(&full)
	schemas := full["components"].(map[string]any)["schemas"].(map[string]any)
	for _, name := range []string{"Page", "Event", "Error", "Actor"} {
		if _, ok := schemas[name]; !ok {
			t.Errorf("components lack schema %s; have %v", name, keys(schemas))
		}
	}
	// Every registered log kind is listed in the skill.
	for _, k := range logs.Kinds() {
		if !strings.Contains(skill, "`"+k.Name+"`") {
			t.Errorf("skill lacks log kind %s", k.Name)
		}
	}
}

func keys(m map[string]any) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func TestStartupAndShutdownAreLoggedAndFilterable(t *testing.T) {
	srv := testkit.Start(t)
	firstStart := srv.Clock.Now()
	srv.Clock.Advance(2 * time.Hour)
	srv.Restart() // logs shutdown at +2h, startup at +2h

	events := srv.Logs("kind=startup,shutdown")
	var kinds []string
	for _, e := range events {
		kinds = append(kinds, e.Kind)
	}
	if !slices.Equal(kinds, []string{"startup", "shutdown", "startup"}) {
		t.Fatalf("kinds newest first = %v", kinds)
	}
	sd := events[1]
	if sd.Level != "info" || sd.Attrs["reason"] != "test stop" || sd.Attrs["drained"] != true || !sd.Time.Equal(firstStart.Add(2*time.Hour)) {
		t.Fatalf("shutdown event = %+v", sd)
	}
	st := events[2]
	if st.Attrs["version"] != "test" || st.Attrs["addr"] == nil || !st.Time.Equal(firstStart) {
		t.Fatalf("startup event = %+v", st)
	}

	// Time filters: since/until as RFC 3339 or a duration back from now.
	if got := srv.Logs("kind=startup&since=1h"); len(got) != 1 {
		t.Fatalf("since=1h: %d startups, want 1", len(got))
	}
	until := firstStart.Add(time.Minute).Format(time.RFC3339)
	if got := srv.Logs("kind=startup&until=" + until); len(got) != 1 || !got[0].Time.Equal(firstStart) {
		t.Fatalf("until=%s: %+v", until, got)
	}
	// Level filter is a minimum.
	srv.App.Logger().Warn("disk nearly full", "kind", "log")
	srv.App.Logger().Error("something broke")
	warn := srv.Logs("level=warn")
	if len(warn) != 2 || warn[0].Level != "error" || warn[1].Level != "warn" {
		t.Fatalf("level=warn: %+v", warn)
	}
	if got := srv.Logs("level=error"); len(got) != 1 || got[0].Message != "something broke" || got[0].Kind != "log" {
		t.Fatalf("level=error: %+v", got)
	}
	// Prefix kinds, request and provider links, paging.
	srv.App.Logger().Info("attempt", logs.Request("req_1"), logs.Provider("acme"), "kind", "test.attempt", "status", 429)
	got := srv.Logs("kind=test.*&request_id=req_1&provider=acme")
	if len(got) != 1 || got[0].Attrs["status"] != float64(429) || got[0].RequestID != "req_1" || got[0].Provider != "acme" {
		t.Fatalf("linked event: %+v", got)
	}
	var page logs.Page
	srv.Admin.Get("/api/logs?limit=2").Expect(200).JSON(&page)
	if len(page.Events) != 2 || page.NextBefore == 0 {
		t.Fatalf("page 1: %+v", page)
	}
	var page2 logs.Page
	srv.Admin.Get("/api/logs?limit=2&before=" + itoa(page.NextBefore)).Expect(200).JSON(&page2)
	if len(page2.Events) == 0 || page2.Events[0].ID >= page.Events[1].ID {
		t.Fatalf("page 2 does not continue page 1: %+v", page2)
	}
}

func TestLogsRejectBadFiltersWithHints(t *testing.T) {
	srv := testkit.Start(t)
	for _, q := range []string{"since=yesterday", "level=loud", "limit=0", "limit=5000", "before=-1"} {
		e := srv.Admin.Get("/api/logs?" + q).Expect(400).Err()
		if e.Hint == "" {
			t.Errorf("%s: no hint", q)
		}
	}
}

func TestConsoleLogsAreJSONLines(t *testing.T) {
	srv := testkit.Start(t)
	var sawStartup bool
	for _, line := range testkit.Lines(srv.Console()) {
		if !strings.HasPrefix(line, "{") {
			continue // the bootstrap notice is plain text
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("console line is not JSON: %s", line)
		}
		if m["kind"] == "startup" {
			sawStartup = true
			if m["time"] != testkit.Epoch.Format(time.RFC3339) {
				t.Fatalf("console time %v does not come from the clock", m["time"])
			}
		}
	}
	if !sawStartup {
		t.Fatal("no startup line on the console")
	}
}

func itoa(n int64) string {
	b, _ := json.Marshal(n)
	return string(b)
}
