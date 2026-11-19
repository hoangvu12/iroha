package retention_test

import (
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/jobs"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/session"
	"github.com/hoangvu12/iroha/internal/settings"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func addProvider(t *testing.T, srv *testkit.Server, url string) {
	t.Helper()
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": url, "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": "sk-test-one"}).Expect(201)
}

func issue(t *testing.T, srv *testkit.Server, name string, capture bool) *testkit.Client {
	t.Helper()
	var out struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": name, "scope": map[string]any{"all": true}, "capture": capture}).Expect(201).JSON(&out)
	return srv.Client(out.GatewayKey.Secret)
}

func chat(t *testing.T, c *testkit.Client) string {
	t.Helper()
	return c.Post("/providers/acme/v1/chat/completions", `{"model":"gpt-x","messages":[{"role":"user","content":"hi"}]}`).Expect(200).Header.Get("X-Request-Id")
}

func job(t *testing.T, srv *testkit.Server) jobs.JobView {
	t.Helper()
	var v jobs.JobView
	srv.Admin.Get("/api/jobs/retention").Expect(200).JSON(&v)
	return v
}

func TestRetentionRunsEveryHourAndLogsEachRun(t *testing.T) {
	srv := testkit.Start(t)

	var list jobs.JobList
	srv.Admin.Get("/api/jobs").Expect(200).JSON(&list)
	if len(list.Jobs) != 2 || list.Jobs[1].Name != "model_refresh" {
		t.Fatalf("jobs = %+v", list.Jobs)
	}
	j := list.Jobs[0]
	if j.Name != "retention" || j.Schedule != "every 1h0m0s" || j.Running || j.LastRun != nil ||
		j.NextRunAt == nil || !j.NextRunAt.Equal(testkit.Epoch.Add(time.Hour)) {
		t.Fatalf("job before any run = %+v", j)
	}

	// Nothing runs at startup or before the hour.
	srv.Clock.Advance(59 * time.Minute)
	srv.SettleJobs()
	if ev := runs(srv, "kind=job.run"); len(ev) != 0 {
		t.Fatalf("job ran early: %+v", ev)
	}

	srv.Clock.Advance(time.Minute)
	srv.SettleJobs()
	j = job(t, srv)
	r := j.LastRun
	if r == nil || r.Trigger != jobs.TriggerSchedule || r.Outcome != "ok" || r.DryRun || !r.StartedAt.Equal(testkit.Epoch.Add(time.Hour)) ||
		r.Summary != "Deleted 0 captures, 0 Requests, 0 log events and 0 Owner sessions." || r.Details["requests_days"] != float64(30) {
		t.Fatalf("last run = %+v", r)
	}
	if !j.NextRunAt.Equal(testkit.Epoch.Add(2 * time.Hour)) {
		t.Fatalf("next run = %v", j.NextRunAt)
	}
	ev := runs(srv, "kind=job.run")
	if len(ev) != 1 || ev[0].Level != "info" || ev[0].Attrs["job"] != "retention" || ev[0].Attrs["trigger"] != "schedule" ||
		ev[0].Attrs["outcome"] != "ok" || ev[0].Attrs["log_events"] != float64(0) || !ev[0].Time.Equal(testkit.Epoch.Add(time.Hour)) {
		t.Fatalf("job.run events = %+v", ev)
	}

	// A restart keeps the hourly rhythm instead of starting over.
	srv.Clock.Advance(30 * time.Minute)
	srv.Restart()
	if j := job(t, srv); !j.NextRunAt.Equal(testkit.Epoch.Add(2*time.Hour)) || j.LastRun == nil {
		t.Fatalf("after restart = %+v", j)
	}
	srv.Clock.Advance(30 * time.Minute)
	srv.SettleJobs()
	if j := job(t, srv); len(j.Runs) != 2 || !j.Runs[0].StartedAt.Equal(testkit.Epoch.Add(2*time.Hour)) {
		t.Fatalf("runs = %+v", j.Runs)
	}

	// A run overdue at startup (Iroha was down) happens at once.
	srv.Stop()
	srv.Clock.Advance(3 * time.Hour)
	srv.Restart()
	srv.SettleJobs()
	if j := job(t, srv); !j.LastRun.StartedAt.Equal(testkit.Epoch.Add(5 * time.Hour)) {
		t.Fatalf("overdue run = %+v", j.LastRun)
	}

	srv.Admin.Get("/api/jobs/nope").Expect(404)
	if e := srv.Admin.Post("/api/jobs/nope/run", nil).Expect(404).Err(); !strings.Contains(e.Hint, "GET /api/jobs") {
		t.Fatalf("hint = %q", e.Hint)
	}
}

func TestRetentionDeletesWhatIsOlderThanEachSetting(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	addProvider(t, srv, up.URL())
	debug := issue(t, srv, "debug", true)
	old := chat(t, debug)

	var r requests.Request
	srv.Admin.Get("/api/requests/" + old).Expect(200).JSON(&r)
	if !r.Captured {
		t.Fatal("the Request was not captured")
	}

	// Captures go after 3 days; the Request stays.
	srv.Clock.Advance(3*24*time.Hour + time.Hour)
	srv.SettleJobs()
	if e := srv.Admin.Get("/api/requests/" + old + "/capture").Expect(404).Err(); e.Code != "capture_not_found" {
		t.Fatalf("capture after 3 days: %+v", e)
	}
	srv.Admin.Get("/api/requests/" + old).Expect(200).JSON(&r)
	if r.Captured {
		t.Fatal("the Request still says captured")
	}
	fresh := chat(t, debug)

	// History kept for 1 day: a dry run says what would go and keeps it.
	srv.Admin.Put("/api/settings/retention.history_days", map[string]any{"value": 1}).Expect(200)
	dry := srv.RunJob("retention", "dry_run=true")
	if !dry.DryRun || dry.ID != 0 || dry.Details["requests"] != float64(1) || !strings.HasPrefix(dry.Summary, "Would delete") {
		t.Fatalf("dry run = %+v", dry)
	}
	srv.Admin.Get("/api/requests/" + old).Expect(200)
	run := srv.RunJob("retention")
	if run.DryRun || run.ID == 0 || run.Trigger != "manual" || run.Outcome != "ok" || run.Details["requests"] != float64(1) || run.Details["captures"] != float64(0) {
		t.Fatalf("run = %+v", run)
	}
	srv.Admin.Get("/api/requests/" + old).Expect(404)
	srv.Admin.Get("/api/requests/" + fresh + "/capture").Expect(200)
	if j := job(t, srv); j.LastRun == nil || j.LastRun.ID != run.ID {
		t.Fatalf("last run = %+v, want %d", j.LastRun, run.ID)
	}

	// Logs kept for 30 days by default, then 1 day.
	if ev := srv.Logs("kind=startup"); len(ev) != 1 {
		t.Fatalf("startup events = %d", len(ev))
	}
	srv.Admin.Put("/api/settings/retention.logs_days", map[string]any{"value": 1}).Expect(200)
	run = srv.RunJob("retention")
	if n, _ := run.Details["log_events"].(float64); n == 0 {
		t.Fatalf("run = %+v", run)
	}
	if ev := srv.Logs("kind=startup"); len(ev) != 0 {
		t.Fatalf("the startup event outlived its retention: %+v", ev)
	}
	// Each run is logged, dry runs included.
	ev := runs(srv, "kind=job.run&since=1m")
	if len(ev) == 0 || ev[0].Attrs["trigger"] != "manual" || ev[0].Attrs["dry_run"] != false {
		t.Fatalf("job.run events = %+v", ev)
	}
	if dryEv := runs(srv, "kind=job.run&since=1m&limit=50"); !hasDry(dryEv) {
		t.Fatalf("the dry run was not logged: %+v", dryEv)
	}
}

// AUTH-11, USE-67: Owner sessions that were revoked or expired stay listed
// for retention.logs_days after they stopped working, then the hourly job
// deletes them; sessions still in use are never touched.
func TestEndedOwnerSessionsAreDeletedAfterTheLogsRetention(t *testing.T) {
	srv := testkit.Start(t)
	ids := func(active string) []string {
		var list session.OwnerSessionList
		srv.Admin.Get("/api/owner-sessions?active=" + active).Expect(200).JSON(&list)
		var out []string
		for _, s := range list.OwnerSessions {
			out = append(out, s.ID)
		}
		return out
	}
	whoami := func(c *testkit.Client) string {
		var a api.Actor
		c.Get("/api/whoami").Expect(200).JSON(&a)
		return a.ID
	}
	signedOut := srv.OwnerSession() // revoked at once
	revokedID := whoami(signedOut)
	signedOut.Delete("/api/session").Expect(204)
	expiring := srv.OwnerSession() // expires after 30 days
	expiringID := whoami(expiring)
	srv.Clock.Advance(20 * 24 * time.Hour)
	later := srv.OwnerSession() // expires on day 50
	laterID := whoami(later)

	// Day 30 + 1 h: the signed-out session ended 30 days and 1 h ago and goes;
	// the one that expired an hour ago stays listed as inactive.
	srv.Clock.Advance(10*24*time.Hour + time.Hour)
	srv.SettleJobs()
	if got := ids("false"); len(got) != 1 || got[0] != expiringID {
		t.Fatalf("inactive sessions on day 30 = %v, want only %s (signed out %s)", got, expiringID, revokedID)
	}
	if got := ids("true"); len(got) != 1 || got[0] != laterID {
		t.Fatalf("active sessions = %v", got)
	}
	later.Get("/api/whoami").Expect(200)
	if dry := srv.RunJob("retention", "dry_run=true"); dry.Details["owner_sessions"] != float64(0) || !strings.Contains(dry.Summary, "0 Owner sessions") {
		t.Fatalf("dry run = %+v", dry)
	}

	// Day 60 + 1 h: the session that expired on day 30 goes; the one that
	// expired on day 50 is still within the 30 days.
	srv.Clock.Advance(30 * 24 * time.Hour)
	srv.SettleJobs()
	if got := ids(""); len(got) != 1 || got[0] != laterID {
		t.Fatalf("sessions on day 60 = %v, want only %s", got, laterID)
	}
	if r := job(t, srv).LastRun; r == nil || r.Details["owner_sessions"] != float64(1) || r.Details["owner_sessions_days"] != float64(30) {
		t.Fatalf("last run = %+v", r)
	}
}

// runs reads job.run events of the retention job only (the daily model
// refresh runs beside it).
func runs(srv *testkit.Server, query string) []logs.Event {
	var out []logs.Event
	for _, e := range srv.Logs(query) {
		if e.Attrs["job"] == "retention" {
			out = append(out, e)
		}
	}
	return out
}

func hasDry(ev []logs.Event) bool {
	for _, e := range ev {
		if e.Attrs["dry_run"] == true {
			return true
		}
	}
	return false
}

func TestRetentionSettingsAreAuditedAndRevertible(t *testing.T) {
	srv := testkit.Start(t)

	var list settings.SettingList
	srv.Admin.Get("/api/settings").Expect(200).JSON(&list)
	want := map[string]string{"retention.captures_days": "3", "retention.history_days": "30", "retention.logs_days": "30"}
	if len(list.Settings) != len(want) {
		t.Fatalf("settings = %+v", list.Settings)
	}
	for _, s := range list.Settings {
		if want[s.Name] != string(s.Value) || !s.IsDefault || string(s.Default) != string(s.Value) || s.Unit != "days" || s.Min != 1 || s.Description == "" {
			t.Fatalf("setting = %+v", s)
		}
	}

	path := "/api/settings/retention.captures_days"
	var res settings.SettingResult
	srv.Admin.Put(path+"?dry_run=true", map[string]any{"value": 7}).Expect(200).JSON(&res)
	if !res.DryRun || res.Outcome != audit.OutcomeUpdated || string(res.Setting.Value) != "7" || len(res.Changes) != 1 || res.AuditEntry != "" {
		t.Fatalf("dry run = %+v", res)
	}
	if got := get(t, srv, "retention.captures_days"); string(got.Value) != "3" {
		t.Fatalf("a dry run changed the setting: %+v", got)
	}

	agent := srv.NewAdminToken("agent-1")
	agent.Put(path, map[string]any{"value": 7}).Expect(200).JSON(&res)
	if res.Outcome != audit.OutcomeUpdated || res.AuditEntry == "" || string(res.Changes[0].Before) != `{"name":"retention.captures_days","value":3}` {
		t.Fatalf("change = %+v (before %s)", res, res.Changes[0].Before)
	}
	if got := get(t, srv, "retention.captures_days"); string(got.Value) != "7" || got.IsDefault {
		t.Fatalf("after change = %+v", got)
	}
	var again settings.SettingResult
	agent.Put(path, map[string]any{"value": 7}).Expect(200).JSON(&again)
	if again.Outcome != audit.OutcomeUnchanged || again.AuditEntry != "" {
		t.Fatalf("repeat = %+v", again)
	}

	var entries struct{ Entries []audit.Entry }
	srv.Admin.Get("/api/audit-entries?record=retention.captures_days").Expect(200).JSON(&entries)
	if len(entries.Entries) != 1 || entries.Entries[0].Actor.Name != "agent-1" || entries.Entries[0].Summary != "Changed setting retention.captures_days" {
		t.Fatalf("entries = %+v", entries.Entries)
	}
	srv.Admin.Post("/api/audit-entries/"+res.AuditEntry+"/revert", nil).Expect(200)
	if got := get(t, srv, "retention.captures_days"); string(got.Value) != "3" || !got.IsDefault {
		t.Fatalf("after revert = %+v", got)
	}

	// Bad values and names are refused with hints.
	for _, body := range []any{map[string]any{"value": 0}, map[string]any{"value": "x"}, map[string]any{"value": 1.5}, map[string]any{}} {
		if e := srv.Admin.Put(path, body).Expect(400).Err(); e.Hint == "" {
			t.Errorf("%v: no hint", body)
		}
	}
	if e := srv.Admin.Put("/api/settings/retention.nope", map[string]any{"value": 1}).Expect(404).Err(); !strings.Contains(e.Hint, "GET /api/settings") {
		t.Fatalf("unknown setting hint = %q", e.Hint)
	}

	// Bulk applies items on their own; DELETE restores the default.
	var bulk audit.BulkResult[settings.Setting]
	srv.Admin.Post("/api/settings/bulk", map[string]any{"items": []any{
		map[string]any{"name": "retention.history_days", "value": 14},
		map[string]any{"name": "retention.nope", "value": 1},
		map[string]any{"name": "retention.logs_days", "value": 7},
	}}).Expect(200).JSON(&bulk)
	if bulk.Succeeded != 2 || bulk.Failed != 1 || bulk.Items[1].Error.Code != "not_found" || bulk.AuditEntry == "" {
		t.Fatalf("bulk = %+v", bulk)
	}
	if got := get(t, srv, "retention.history_days"); string(got.Value) != "14" {
		t.Fatalf("history = %+v", got)
	}
	srv.Admin.Delete("/api/settings/retention.history_days").Expect(200).JSON(&res)
	if res.Outcome != audit.OutcomeUpdated || string(res.Setting.Value) != "30" || !res.Setting.IsDefault {
		t.Fatalf("reset = %+v", res)
	}
	if got := get(t, srv, "retention.logs_days"); string(got.Value) != "7" {
		t.Fatalf("logs = %+v", got)
	}
}

func get(t *testing.T, srv *testkit.Server, name string) settings.Setting {
	t.Helper()
	var s settings.Setting
	srv.Admin.Get("/api/settings/" + name).Expect(200).JSON(&s)
	return s
}
