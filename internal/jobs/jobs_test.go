package jobs_test

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/jobs"
	"github.com/hoangvu12/iroha/internal/testkit"
)

func TestJobRunsAreStoredLoggedAndReportFailures(t *testing.T) {
	var mode atomic.Value
	mode.Store("ok")
	started := make(chan struct{}, 10)
	probe := jobs.Job{
		Name: "probe", Description: "A test job.", Schedule: jobs.Every(10 * time.Minute),
		Run: func(ctx context.Context, dry bool) (jobs.Outcome, error) {
			started <- struct{}{}
			switch mode.Load() {
			case "fail":
				return jobs.Outcome{}, errors.New("the upstream is down")
			case "panic":
				panic("boom")
			case "block":
				<-ctx.Done()
				return jobs.Outcome{}, ctx.Err()
			}
			return jobs.Outcome{Summary: "Probed acme.", Provider: "acme", Details: map[string]any{"found": 2, "job": "spoofed"}}, nil
		},
	}
	srv := testkit.Start(t, testkit.Options{Jobs: []jobs.Job{probe}})
	view := func() jobs.JobView {
		var v jobs.JobView
		srv.Admin.Get("/api/jobs/probe").Expect(200).JSON(&v)
		return v
	}

	srv.Clock.Advance(10 * time.Minute)
	srv.SettleJobs()
	v := view()
	if v.LastRun == nil || v.LastRun.Outcome != "ok" || v.LastRun.Summary != "Probed acme." || v.LastRun.Details["found"] != float64(2) {
		t.Fatalf("job = %+v", v)
	}
	ev := srv.Logs("kind=job.run&provider=acme")
	if len(ev) != 1 || ev[0].Attrs["job"] != "probe" || ev[0].Attrs["found"] != float64(2) || ev[0].Attrs["summary"] != "Probed acme." {
		t.Fatalf("events = %+v", ev)
	}

	mode.Store("fail")
	if run := srv.RunJob("probe"); run.Outcome != "failed" || run.Error != "the upstream is down" || run.Trigger != "manual" {
		t.Fatalf("failed run = %+v", run)
	}
	mode.Store("panic")
	if run := srv.RunJob("probe"); run.Outcome != "failed" || !strings.Contains(run.Error, "panicked: boom") {
		t.Fatalf("panicked run = %+v", run)
	}
	if ev := srv.Logs("kind=job.run&level=error"); len(ev) != 2 || ev[0].Attrs["error"] == nil {
		t.Fatalf("error events = %+v", ev)
	}

	mode.Store("ok")
	if run := srv.RunJob("probe", "dry_run=true"); !run.DryRun || run.ID != 0 || run.Outcome != "ok" {
		t.Fatalf("dry run = %+v", run)
	}
	if v := view(); len(v.Runs) != 3 {
		t.Fatalf("stored runs = %+v", v.Runs)
	}
	srv.Admin.Post("/api/jobs/probe/run?dry_run=maybe", nil).Expect(400)

	mode.Store("block")
	for len(started) > 0 {
		<-started
	}
	srv.Clock.Advance(10 * time.Minute)
	<-started
	srv.Restart()
	if v := view(); v.Runs[0].Outcome != "canceled" || v.Runs[0].Trigger != "schedule" {
		t.Fatalf("runs = %+v", v.Runs)
	}
	if ev := srv.Logs("kind=job.run&level=error"); len(ev) != 2 {
		t.Fatalf("a canceled run was logged as an error: %+v", ev)
	}
}
