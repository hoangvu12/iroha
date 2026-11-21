package modelrefresh_test

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/jobs"
	"github.com/hoangvu12/iroha/internal/modelrefresh"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestAHungModelListNeitherStallsOtherJobsNorOtherProviders(t *testing.T) {
	srv := testkit.Start(t)
	hung := addProvider(t, srv, "hung", nil)
	hung.Handle(http.MethodGet, "/v1/models", testkit.Hang())
	fine := addProvider(t, srv, "fine", nil)

	for _, h := range []string{"hung", "fine"} {
		srv.Admin.Patch("/api/providers/"+h, map[string]any{"enabled": false}).Expect(200)
	}
	for range 4 {
		srv.Clock.Advance(modelrefresh.Tick)
		srv.SettleJobs()
	}
	for _, h := range []string{"hung", "fine"} {
		srv.Admin.Patch("/api/providers/"+h, map[string]any{"enabled": true}).Expect(200)
		if e := schedule(t, srv)[h]; e.NextRefreshAt == nil || e.NextRefreshAt.After(srv.Clock.Now()) {
			t.Fatalf("%s not due = %+v", h, e)
		}
	}
	srv.Clock.Advance(modelrefresh.Tick)
	hung.Await(1)

	var view jobs.JobView
	srv.Admin.Get("/api/jobs/" + modelrefresh.JobName).Expect(200).JSON(&view)
	if !view.Running {
		t.Fatalf("model_refresh is not running: %+v", view)
	}
	if run := srv.RunJob("retention"); run.Outcome != "ok" || run.Trigger != "manual" || run.ID == 0 {
		t.Fatalf("retention during a hung refresh = %+v", run)
	}

	srv.Clock.Advance(30 * time.Second)
	srv.SettleJobs()
	if lists(fine) != 1 || lists(hung) != 1 {
		t.Fatalf("list reads: fine %d, hung %d", lists(fine), lists(hung))
	}
	sched := schedule(t, srv)
	if lr := sched["fine"].LastRefresh; lr == nil || lr.Outcome != "ok" {
		t.Fatalf("fine last refresh = %+v", lr)
	}
	if lr := sched["hung"].LastRefresh; lr == nil || lr.Outcome != "failed" || !strings.Contains(lr.Summary, "no answer within 30s") {
		t.Fatalf("hung last refresh = %+v", lr)
	}
	found := false
	for _, e := range srv.Logs("kind=discovery&provider=hung&level=warn") {
		if e.Attrs["outcome"] == "failed" && strings.Contains(fmt.Sprint(e.Attrs["error"]), "no answer within 30s") {
			found = true
		}
	}
	if !found {
		t.Fatal("no failed discovery event for the hung list")
	}
	srv.Admin.Get("/api/jobs/" + modelrefresh.JobName).Expect(200).JSON(&view)
	last := view.LastRun
	if last == nil || last.Outcome != "ok" || last.Details["failed"] != float64(1) || last.Details["ok"] != float64(1) ||
		!strings.Contains(last.Summary, "hung failed") || !strings.Contains(last.Summary, "fine ok") {
		t.Fatalf("model_refresh run = %+v", last)
	}
	if last.DurationMs != (30 * time.Second).Milliseconds() {
		t.Fatalf("run lasted %d ms, want the 30 s timeout", last.DurationMs)
	}
}
