package jobs_test

import (
	"context"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/jobs"
	"github.com/hoangvu12/iroha/internal/testkit"
)

// USE-56: runs of one job never overlap: a scheduled run that falls due
// while a manual one is running starts only once it ended, and a manual run
// asked for during a scheduled one waits for it. Every run is stored.
func TestRunsOfOneJobNeverOverlapAndAManualRunWaits(t *testing.T) {
	var active, most atomic.Int32
	started := make(chan string, 4)
	gate := make(chan struct{})
	probe := jobs.Job{
		Name: "probe", Description: "A test job.", Schedule: jobs.Every(10 * time.Minute),
		Run: func(ctx context.Context, dry bool) (jobs.Outcome, error) {
			n := active.Add(1)
			defer active.Add(-1)
			for m := most.Load(); n > m && !most.CompareAndSwap(m, n); m = most.Load() {
			}
			started <- "run"
			select {
			case <-gate:
			case <-ctx.Done():
				return jobs.Outcome{}, ctx.Err()
			}
			return jobs.Outcome{Summary: "Probed."}, nil
		},
	}
	srv := testkit.Start(t, testkit.Options{Jobs: []jobs.Job{probe}})
	manual := func() <-chan int {
		done := make(chan int, 1)
		go func() {
			resp := srv.Admin.Open(http.MethodPost, "/api/jobs/probe/run", nil)
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			done <- resp.StatusCode
		}()
		return done
	}

	// A manual run holds the job; the scheduled run falls due meanwhile.
	first := manual()
	<-started
	waiters := srv.Clock.Waiters()
	srv.Clock.Advance(10 * time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Clock.BlockUntil(ctx, waiters); err != nil { // the schedule set its next timer: its run is on the way
		t.Fatal(err)
	}
	select {
	case <-started:
		t.Fatal("the scheduled run started while the manual run was running")
	default:
	}
	srv.Clock.Advance(time.Minute)
	gate <- struct{}{} // the manual run ends
	if status := <-first; status != http.StatusOK {
		t.Fatalf("manual run = %d", status)
	}
	<-started // then the scheduled one starts

	// A manual run asked for now waits for the scheduled one.
	second := manual()
	gate <- struct{}{}
	<-started
	gate <- struct{}{}
	if status := <-second; status != http.StatusOK {
		t.Fatalf("second manual run = %d", status)
	}
	srv.SettleJobs()

	if most.Load() != 1 {
		t.Fatalf("%d runs of one job ran at once", most.Load())
	}
	var v jobs.JobView
	srv.Admin.Get("/api/jobs/probe").Expect(200).JSON(&v)
	if len(v.Runs) != 3 || v.Runs[2].Trigger != "manual" || v.Runs[1].Trigger != "schedule" || v.Runs[0].Trigger != "manual" {
		t.Fatalf("runs = %+v", v.Runs)
	}
	for i := 0; i+1 < len(v.Runs); i++ {
		if newer, older := v.Runs[i], v.Runs[i+1]; newer.StartedAt.Before(older.FinishedAt) {
			t.Fatalf("run %d started at %v before run %d finished at %v", newer.ID, newer.StartedAt, older.ID, older.FinishedAt)
		}
	}
	if !v.Runs[1].StartedAt.Equal(v.Runs[2].FinishedAt) || !v.Runs[1].StartedAt.Equal(testkit.Epoch.Add(11*time.Minute)) {
		t.Fatalf("the scheduled run started at %v, want when the manual run ended (%v)", v.Runs[1].StartedAt, v.Runs[2].FinishedAt)
	}
}
