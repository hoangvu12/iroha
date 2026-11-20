package modelrefresh_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/modelrefresh"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// addProvider creates a Provider with one OpenAI Chat Endpoint on a new
// fake upstream (whose model list names "<handle>-model") and one key.
func addProvider(t *testing.T, srv *testkit.Server, handle string, extra map[string]any) *testkit.Upstream {
	t.Helper()
	up := testkit.NewOpenAIChat(t)
	up.SetModels(handle + "-model")
	body := map[string]any{"handle": handle}
	for k, v := range extra {
		body[k] = v
	}
	srv.Admin.Post("/api/providers", body).Expect(201)
	srv.Admin.Post("/api/providers/"+handle+"/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat"}).Expect(201)
	srv.Admin.Post("/api/providers/"+handle+"/keys", map[string]any{"secret": "sk-test-" + handle}).Expect(201)
	return up
}

// lists counts the model list reads a fake received.
func lists(up *testkit.Upstream) int {
	n := 0
	for _, r := range up.Requests() {
		if r.Method == http.MethodGet && r.Path == "/v1/models" {
			n++
		}
	}
	return n
}

func schedule(t *testing.T, srv *testkit.Server) map[string]modelrefresh.Entry {
	t.Helper()
	var s modelrefresh.Schedule
	srv.Admin.Get("/api/model-refreshes").Expect(200).JSON(&s)
	out := map[string]modelrefresh.Entry{}
	for _, e := range s.Providers {
		out[e.Provider] = e
	}
	return out
}

// dailyAt parses an Entry's daily_at.
func dailyAt(t *testing.T, e modelrefresh.Entry) time.Duration {
	t.Helper()
	var h, m int
	if _, err := fmt.Sscanf(e.DailyAt, "%02d:%02d", &h, &m); err != nil || h > 23 || m > 59 {
		t.Fatalf("daily_at = %q", e.DailyAt)
	}
	return time.Duration(h)*time.Hour + time.Duration(m)*time.Minute
}

func timeOfDay(at time.Time) time.Duration { return at.Sub(at.Truncate(24 * time.Hour)) }

func TestFirstRefreshesAreSpreadOverTheFirstHourThenEachProviderRefreshesDailyAtItsTime(t *testing.T) {
	srv := testkit.Start(t)
	handles := []string{"alpha", "bravo", "charlie", "delta", "echo"}
	ups := map[string]*testkit.Upstream{}
	for _, h := range handles {
		ups[h] = addProvider(t, srv, h, nil)
	}

	// Each Provider has its own time of day; never refreshed, it is due
	// at that time's minutes within the first hour, not at startup.
	sched := schedule(t, srv)
	for _, h := range handles {
		e := sched[h]
		if !e.Scheduled || e.NotScheduled != "" || e.LastRefresh != nil || e.NextRefreshAt == nil {
			t.Fatalf("%s before any refresh = %+v", h, e)
		}
		want := testkit.Epoch.Add(dailyAt(t, e) % time.Hour)
		if !e.NextRefreshAt.Equal(want) {
			t.Fatalf("%s next = %v, want %v (daily_at %s)", h, e.NextRefreshAt, want, e.DailyAt)
		}
	}

	// Walk two and a half days, one job run (15 min) at a time: exactly the
	// Providers due are refreshed, each once.
	refreshed := map[string][]time.Time{}
	srv.SettleJobs()
	for _, h := range handles {
		if lists(ups[h]) != 0 {
			t.Fatalf("%s was refreshed at startup", h)
		}
	}
	for step := 0; step < 4*60; step++ {
		srv.Clock.Advance(modelrefresh.Tick)
		srv.SettleJobs()
		now := srv.Clock.Now()
		after := schedule(t, srv)
		for _, h := range handles {
			due := !sched[h].NextRefreshAt.After(now)
			n := lists(ups[h])
			if due != (n == len(refreshed[h])+1) || (!due && n != len(refreshed[h])) {
				t.Fatalf("at %v %s: due %v (next %v) but %d list reads after %d refreshes", now, h, due, sched[h].NextRefreshAt, n, len(refreshed[h]))
			}
			if due {
				if lr := after[h].LastRefresh; lr == nil || !lr.At.Equal(now) || lr.Outcome != "ok" {
					t.Fatalf("%s last refresh = %+v", h, lr)
				}
				refreshed[h] = append(refreshed[h], now)
			}
		}
		sched = after
	}
	for _, h := range handles {
		got := refreshed[h]
		at := dailyAt(t, sched[h])
		if len(got) < 2 || got[0].After(testkit.Epoch.Add(time.Hour)) {
			t.Fatalf("%s refreshed at %v", h, got)
		}
		for i, r := range got[1:] {
			// The refresh runs at the first tick at or after daily_at, which
			// may fall after midnight (daily_at 23:53 runs at 00:00).
			if d := (timeOfDay(r) - at + 24*time.Hour) % (24 * time.Hour); d >= modelrefresh.Tick {
				t.Fatalf("%s refresh %d at %v, daily_at %s", h, i+1, r, sched[h].DailyAt)
			}
			if i > 0 && r.Sub(got[i]) != 24*time.Hour {
				t.Fatalf("%s refreshes %v and %v are not a day apart", h, got[i], r)
			}
		}
	}

	// Each refresh is logged, each job run too, linked to the Provider
	// when the run refreshed one.
	if ev := srv.Logs("kind=discovery&provider=alpha&limit=100"); len(ev) < 2*len(refreshed["alpha"]) {
		t.Fatalf("discovery events of alpha = %d for %d refreshes", len(ev), len(refreshed["alpha"]))
	}
	found := false
	for _, e := range srv.Logs("kind=job.run&limit=500") {
		if e.Attrs["job"] == modelrefresh.JobName && e.Attrs["refreshed"] == float64(1) && e.Provider != "" &&
			strings.Contains(e.Attrs["summary"].(string), "Refreshed 1 model list: "+e.Provider+" ok.") {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("no job.run event of a model refresh names the Provider it refreshed")
	}
	var view struct {
		Schedule string `json:"schedule"`
		LastRun  *struct {
			Outcome string `json:"outcome"`
		} `json:"last_run"`
	}
	srv.Admin.Get("/api/jobs/model_refresh").Expect(200).JSON(&view)
	if view.Schedule != "every 15m0s" || view.LastRun == nil || view.LastRun.Outcome != "ok" {
		t.Fatalf("job = %+v", view)
	}
}

func TestARefreshByHandCountsAsTheDaysAndOnlyEnabledProvidersAreScheduled(t *testing.T) {
	srv := testkit.Start(t)
	acme := addProvider(t, srv, "acme", nil)
	off := addProvider(t, srv, "off", nil)
	manual := addProvider(t, srv, "manual", map[string]any{"discovery": "none"})
	srv.Admin.Patch("/api/providers/off", map[string]any{"enabled": false}).Expect(200)

	sched := schedule(t, srv)
	if e := sched["off"]; e.Scheduled || e.NotScheduled != modelrefresh.ReasonDisabled || e.NextRefreshAt != nil || e.DailyAt == "" {
		t.Fatalf("off = %+v", e)
	}
	if e := sched["manual"]; e.Scheduled || e.NotScheduled != modelrefresh.ReasonNoDiscovery || e.NextRefreshAt != nil {
		t.Fatalf("manual = %+v", e)
	}

	// Refreshed by hand at 00:00, acme is next due at its time at least 12 h later.
	srv.Admin.Post("/api/providers/acme/models/refresh", nil).Expect(200)
	e := schedule(t, srv)["acme"]
	at := dailyAt(t, e)
	want := testkit.Epoch.Add(at)
	if at < 12*time.Hour {
		want = want.Add(24 * time.Hour)
	}
	if e.LastRefresh == nil || !e.LastRefresh.At.Equal(testkit.Epoch) || !e.NextRefreshAt.Equal(want) {
		t.Fatalf("acme after a refresh by hand = %+v, want next %v", e, want)
	}

	// Nothing is due: a dry run says so and names the next one.
	run := srv.RunJob(modelrefresh.JobName, "dry_run=true")
	if run.Outcome != "ok" || run.Details["due"] != float64(0) || run.Details["next_provider"] != "acme" ||
		run.Summary != "No model list was due; next: acme at "+want.Format("2006-01-02 15:04 UTC")+"." {
		t.Fatalf("dry run = %+v", run)
	}

	for srv.Clock.Now().Before(want.Add(time.Hour)) {
		srv.Clock.Advance(time.Hour)
		srv.SettleJobs()
		if srv.Clock.Now().Before(want) && lists(acme) != 1 {
			t.Fatalf("acme refreshed early, at %v", srv.Clock.Now())
		}
	}
	if lists(acme) != 2 || lists(off) != 0 || lists(manual) != 0 {
		t.Fatalf("list reads: acme %d, off %d, manual %d", lists(acme), lists(off), lists(manual))
	}

	// A dry run when one is due names it and reads nothing.
	srv.Admin.Patch("/api/providers/off", map[string]any{"enabled": true}).Expect(200)
	if e := schedule(t, srv)["off"]; !e.Scheduled || e.NextRefreshAt == nil {
		t.Fatalf("off once enabled = %+v", e)
	}
	srv.Clock.Advance(time.Hour) // past off's first hour
	run = srv.RunJob(modelrefresh.JobName, "dry_run=true")
	if lists(off) == 0 {
		if !run.DryRun || run.Summary != "Would refresh 1 model list: off." {
			t.Fatalf("dry run = %+v", run)
		}
		srv.RunJob(modelrefresh.JobName)
	}
	if lists(off) != 1 {
		t.Fatalf("off list reads = %d", lists(off))
	}
}

func TestARestartKeepsTheTimesAndSpreadsWhatFellDueWhileDown(t *testing.T) {
	srv := testkit.Start(t)
	up := addProvider(t, srv, "acme", nil)
	srv.Admin.Post("/api/providers/acme/models/refresh", nil).Expect(200)
	next := *schedule(t, srv)["acme"].NextRefreshAt

	// A restart changes nothing.
	srv.Clock.Advance(time.Hour)
	srv.Restart()
	if e := schedule(t, srv)["acme"]; !e.NextRefreshAt.Equal(next) {
		t.Fatalf("after a restart next = %v, want %v", e.NextRefreshAt, next)
	}

	// Down for three days: the missed refresh is due within the hour after
	// the start, at the Provider's minutes, not at the start itself.
	srv.Stop()
	srv.Clock.Advance(72 * time.Hour)
	srv.Restart()
	start := srv.Clock.Now()
	e := schedule(t, srv)["acme"]
	if want := start.Add(dailyAt(t, e) % time.Hour); !e.NextRefreshAt.Equal(want) {
		t.Fatalf("after downtime next = %v, want %v", e.NextRefreshAt, want)
	}
	srv.SettleJobs()
	if e.NextRefreshAt.After(start) && lists(up) != 1 {
		t.Fatalf("refreshed at startup: %d list reads", lists(up))
	}
	for range 4 {
		srv.Clock.Advance(modelrefresh.Tick)
		srv.SettleJobs()
	}
	if lists(up) != 2 {
		t.Fatalf("list reads after the first hour = %d", lists(up))
	}
}

// The spec: background work never changes or deletes Upstream Keys. Keys
// in every state, a model list answering 401, and days of both jobs: the
// keys read exactly as before, and no job wrote a Key State or an Audit Entry.
func TestNoJobChangesOrDeletesUpstreamKeys(t *testing.T) {
	srv := testkit.Start(t)
	up := testkit.NewOpenAIChat(t)
	// Affinity off: keys in turn, so the 401 below lands on key-1.
	srv.Admin.Post("/api/providers", map[string]any{"handle": "acme", "discovery": "key", "affinity": "off"}).Expect(201)
	srv.Admin.Post("/api/providers/acme/endpoints", map[string]any{"url": up.URL(), "shape": "openai-chat"}).Expect(201)
	for _, s := range []string{"sk-test-a", "sk-test-b", "sk-test-c", "sk-test-d"} {
		srv.Admin.Post("/api/providers/acme/keys", map[string]any{"secret": s}).Expect(201)
	}
	srv.Admin.Post("/api/providers/acme/keys/key-3/disable", nil).Expect(200)
	var gk struct {
		GatewayKey struct{ Secret string } `json:"gateway_key"`
	}
	srv.Admin.Post("/api/gateway-keys", map[string]any{"name": "pi", "scope": map[string]any{"all": true}}).Expect(201).JSON(&gk)
	caller := srv.Client(gk.GatewayKey.Secret)
	up.Enqueue(up.ErrorCode(401, "invalid_api_key", "Incorrect API key provided"))
	caller.Post("/providers/acme/v1/chat/completions", map[string]any{"model": "gpt-x", "messages": []any{map[string]any{"role": "user", "content": "hi"}}}).Expect(200)
	// key-1 is now invalid, key-3 disabled; key-2's model list is refused
	// as unauthorized, key-4's lists models.
	up.Handle(http.MethodGet, "/v1/models", func(r *testkit.Received) testkit.Reply {
		if r.Bearer() == "sk-test-d" {
			return testkit.JSON(200, map[string]any{"data": []any{map[string]any{"id": "gpt-x"}}})(r)
		}
		return up.ErrorCode(401, "invalid_api_key", "Incorrect API key provided")(r)
	})
	srv.Admin.Put("/api/settings/retention.history_days", map[string]any{"value": 1}).Expect(200)

	keys := func() string {
		resp := srv.Admin.Get("/api/providers/acme/keys").Expect(200)
		var v any
		if err := json.Unmarshal(resp.Body, &v); err != nil {
			t.Fatal(err)
		}
		b, _ := json.Marshal(v)
		return string(b)
	}
	var audits struct {
		Entries []any `json:"entries"`
	}
	srv.Admin.Get("/api/audit-entries?limit=200").Expect(200).JSON(&audits)
	before, beforeAudits := keys(), len(audits.Entries)
	if !strings.Contains(before, `"state":"invalid"`) || !strings.Contains(before, `"state":"disabled"`) {
		t.Fatalf("keys before = %s", before)
	}
	keyEvents := len(srv.Logs("kind=key.state&limit=100"))
	// USE-65: no job sends anything but a GET upstream (no inference, no key probe).
	writes := func() int {
		n := 0
		for _, r := range up.Requests() {
			if r.Method != http.MethodGet {
				n++
			}
		}
		return n
	}
	writesBefore := writes()

	for range 3 * 24 {
		srv.Clock.Advance(time.Hour)
		srv.SettleJobs()
	}
	srv.RunJob(modelrefresh.JobName)
	srv.RunJob("retention")

	if got := keys(); got != before {
		t.Fatalf("a job changed Upstream Keys:\nbefore %s\nafter  %s", before, got)
	}
	if n := writes(); n != writesBefore {
		t.Fatalf("jobs sent %d requests other than GET upstream", n-writesBefore)
	}
	if n := len(srv.Logs("kind=key.state&limit=100")); n != keyEvents {
		t.Fatalf("key.state events went from %d to %d", keyEvents, n)
	}
	srv.Admin.Get("/api/audit-entries?limit=200").Expect(200).JSON(&audits)
	if len(audits.Entries) != beforeAudits {
		t.Fatalf("Audit Entries went from %d to %d", beforeAudits, len(audits.Entries))
	}
	// The jobs did run: lists were read (and refused), history was deleted.
	if lists(up) < 3 {
		t.Fatalf("model list reads = %d", lists(up))
	}
	var failed int
	for _, e := range srv.Logs("kind=discovery&provider=acme&level=warn&limit=100") {
		if e.Attrs["upstream_key"] == "key-2" && e.Attrs["outcome"] == "failed" {
			failed++
		}
	}
	if failed < 3 {
		t.Fatalf("failed list reads of key-2 logged = %d", failed)
	}
	var reqs struct {
		Requests []any `json:"requests"`
	}
	srv.Admin.Get("/api/requests").Expect(200).JSON(&reqs)
	if len(reqs.Requests) != 0 {
		t.Fatalf("retention left %d Requests", len(reqs.Requests))
	}
}
