// Package jobs runs Iroha's background work: a few named jobs, each on a
// schedule measured on the injected clock, each run logged (kind job.run)
// and stored, and each runnable by hand through /api/jobs (with a dry run).
//
// A job is a function and a schedule:
//
//	runner.Add(jobs.Job{
//		Name: "retention", Description: "...", Schedule: jobs.Every(time.Hour),
//		Run: func(ctx context.Context, dryRun bool) (jobs.Outcome, error) { ... },
//	})
//
// Runs of one job never overlap. A job that must act per Provider at
// different times (the daily model refresh) runs often and does what is due.
package jobs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/store"
)

// Schedule says when a job runs next.
type Schedule interface {
	// Next is when the job should next start, given when it last started
	// (the zero time when it never ran, or not since its runs were stored)
	// and now. A time not after now means at once.
	Next(last, now time.Time) time.Time
	// String describes the schedule for people ("every 1h0m0s").
	String() string
}

// Every runs a job every d. A job that never ran first runs d after
// startup (so a start never causes a burst of work); one whose last run is
// overdue runs at startup.
func Every(d time.Duration) Schedule { return every(d) }

type every time.Duration

func (e every) Next(last, now time.Time) time.Time {
	if last.IsZero() {
		return now.Add(time.Duration(e))
	}
	next := last.Add(time.Duration(e))
	if next.Before(now) {
		return now
	}
	return next
}

func (e every) String() string { return "every " + time.Duration(e).String() }

// Outcome is what a successful run reports.
type Outcome struct {
	// Summary is one line for people: "Deleted 120 Requests and 3,400 log events".
	Summary string
	// Details are the run's figures; each becomes an attribute of the job.run
	// event and is returned by the API.
	Details map[string]any
	// Provider links the job.run event to a Provider (handle), when the run
	// concerned one.
	Provider string
}

// Job is one kind of background work.
type Job struct {
	Name        string // short, e.g. retention
	Description string
	Schedule    Schedule
	// Run does the work. With dryRun it reports what it would do and
	// changes nothing. ctx ends when Iroha stops.
	Run func(ctx context.Context, dryRun bool) (Outcome, error)
}

// Triggers of a run.
const (
	TriggerSchedule = "schedule"
	TriggerManual   = "manual"
)

// Run is one run of a job as stored and returned by the API.
type Run struct {
	ID         int64          `json:"id,omitempty" doc:"Absent on a dry run, which is not stored."`
	Job        string         `json:"job"`
	Trigger    string         `json:"trigger" enum:"schedule,manual"`
	DryRun     bool           `json:"dry_run"`
	StartedAt  time.Time      `json:"started_at"`
	FinishedAt time.Time      `json:"finished_at"`
	DurationMs int64          `json:"duration_ms"`
	Outcome    string         `json:"outcome" enum:"ok,failed,canceled" doc:"canceled: Iroha stopped during the run."`
	Summary    string         `json:"summary,omitempty"`
	Details    map[string]any `json:"details" doc:"The job's own figures, such as how many records it deleted."`
	Error      string         `json:"error,omitempty" doc:"Why the run failed."`
}

// keepRuns is how many stored runs each job keeps.
const keepRuns = 100

// Runner runs jobs on their schedules.
type Runner struct {
	db    *store.DB
	log   *slog.Logger
	clock clock.Clock

	order   []*entry
	byName  map[string]*entry
	ctx     context.Context
	cancel  context.CancelFunc
	wg      sync.WaitGroup
	started bool
}

type entry struct {
	job Job
	run sync.Mutex // held while the job runs; runs never overlap

	mu      sync.Mutex
	pending int // runs started or waiting for the one in progress
	next    time.Time
}

// NewRunner returns a Runner with no jobs.
func NewRunner(db *store.DB, log *slog.Logger) *Runner {
	ctx, cancel := context.WithCancel(context.Background())
	return &Runner{db: db, log: log, clock: db.Clock(), byName: map[string]*entry{}, ctx: ctx, cancel: cancel}
}

// Add registers a job. Call it before Start; it panics on a duplicate name.
func (r *Runner) Add(j Job) {
	if j.Name == "" || j.Schedule == nil || j.Run == nil {
		panic("jobs: a job needs a name, a schedule and a Run function")
	}
	if r.started {
		panic("jobs: Add after Start")
	}
	if _, ok := r.byName[j.Name]; ok {
		panic(fmt.Sprintf("jobs: job %q added twice", j.Name))
	}
	e := &entry{job: j}
	r.order = append(r.order, e)
	r.byName[j.Name] = e
}

// Start schedules every job. Each job's first timer exists when Start
// returns, so a test can advance a fake clock right after.
func (r *Runner) Start(ctx context.Context) error {
	if r.started {
		return nil
	}
	r.started = true
	now := r.clock.Now()
	for _, e := range r.order {
		var last sql.NullInt64
		if err := r.db.QueryRowContext(ctx, `SELECT max(started_at) FROM job_runs WHERE job = ?`, e.job.Name).Scan(&last); err != nil {
			return fmt.Errorf("jobs: reading the last run of %s: %w", e.job.Name, err)
		}
		next := e.job.Schedule.Next(store.NullMillis(last), now)
		e.setNext(next)
		t := r.clock.NewTimer(next.Sub(now))
		r.wg.Add(1)
		go r.loop(e, t)
	}
	return nil
}

// Stop cancels running jobs and waits for every job goroutine to end.
func (r *Runner) Stop() {
	r.cancel()
	r.wg.Wait()
}

func (r *Runner) loop(e *entry, t clock.Timer) {
	defer r.wg.Done()
	for {
		select {
		case <-r.ctx.Done():
			t.Stop()
			return
		case <-t.C():
		}
		// The job counts as running from the timer firing until the loop
		// waits again with nothing due, so readers of the API (and tests
		// after advancing a fake clock) never see it idle with a run owed.
		e.mu.Lock()
		e.pending++
		e.mu.Unlock()
		for due := true; due; {
			now := r.clock.Now()
			d := e.job.Schedule.Next(now, now).Sub(now)
			// The next timer exists before the run starts, so time
			// advanced during a run is not lost.
			t = r.clock.NewTimer(d)
			e.mu.Lock()
			e.next = r.clock.Now().Add(d)
			e.pending++
			e.mu.Unlock()
			r.run(r.ctx, e, TriggerSchedule, false)
			select {
			case <-t.C():
				due = r.ctx.Err() == nil
			default:
				due = false
			}
		}
		e.done()
	}
}

func (e *entry) setNext(t time.Time) {
	e.mu.Lock()
	e.next = t
	e.mu.Unlock()
}

func (e *entry) done() {
	e.mu.Lock()
	e.pending--
	e.mu.Unlock()
}

// RunNow runs the named job at once, waiting for a run in progress to end
// first, and returns the run.
func (r *Runner) RunNow(name string, dryRun bool) (Run, error) {
	e, ok := r.byName[name]
	if !ok {
		return Run{}, notFound(name)
	}
	e.mu.Lock()
	e.pending++
	e.mu.Unlock()
	return r.run(r.ctx, e, TriggerManual, dryRun), nil
}

// run runs e once; the caller has counted it in e.pending.
func (r *Runner) run(ctx context.Context, e *entry, trigger string, dry bool) Run {
	defer e.done()
	e.run.Lock()
	defer e.run.Unlock()

	start := r.clock.Now()
	out, err := call(ctx, e.job, dry)
	end := r.clock.Now()
	run := Run{Job: e.job.Name, Trigger: trigger, DryRun: dry, StartedAt: start.UTC(), FinishedAt: end.UTC(),
		DurationMs: end.Sub(start).Milliseconds(), Outcome: "ok", Summary: out.Summary, Details: out.Details}
	if run.Details == nil {
		run.Details = map[string]any{}
	}
	canceled := err != nil && ctx.Err() != nil
	switch {
	case canceled:
		run.Outcome, run.Error = "canceled", "Iroha stopped during the run: "+err.Error()
	case err != nil:
		run.Outcome, run.Error = "failed", err.Error()
	}
	if !dry {
		if id, err := r.store(run); err != nil {
			r.log.Error("storing a job run failed", logs.Kind(logs.KindGeneric), "job", run.Job, "err", err.Error())
		} else {
			run.ID = id
		}
	}

	attrs := []any{logs.Kind(logs.KindJobRun), "job", run.Job, "trigger", trigger, "dry_run", dry,
		"outcome", run.Outcome, "duration_ms", run.DurationMs, "summary", run.Summary}
	if out.Provider != "" {
		attrs = append(attrs, logs.Provider(out.Provider))
	}
	for k, v := range out.Details {
		switch k {
		case logs.KindKey, logs.RequestKey, logs.ProviderKey, "job", "trigger", "dry_run", "outcome", "duration_ms", "summary", "error":
			continue // a job's figures never override the event's own fields
		}
		attrs = append(attrs, k, v)
	}
	switch {
	case canceled:
		r.log.Info("job canceled by shutdown", append(attrs, "error", run.Error)...)
	case err != nil:
		r.log.Error("job failed", append(attrs, "error", run.Error)...)
	default:
		r.log.Info("job finished", attrs...)
	}
	return run
}

// call runs the job, turning a panic into a failure.
func call(ctx context.Context, j Job, dry bool) (out Outcome, err error) {
	defer func() {
		if p := recover(); p != nil {
			err = fmt.Errorf("the job panicked: %v", p)
		}
	}()
	return j.Run(ctx, dry)
}

func (r *Runner) store(run Run) (int64, error) {
	details, err := json.Marshal(run.Details)
	if err != nil {
		details = []byte("{}")
	}
	var id int64
	err = r.db.Tx(context.Background(), func(tx *sql.Tx) error {
		res, err := tx.Exec(`INSERT INTO job_runs (job, trigger, started_at, finished_at, outcome, summary, details, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			run.Job, run.Trigger, store.Millis(run.StartedAt), store.Millis(run.FinishedAt), run.Outcome, run.Summary, string(details), run.Error)
		if err != nil {
			return err
		}
		if id, err = res.LastInsertId(); err != nil {
			return err
		}
		_, err = tx.Exec(`DELETE FROM job_runs WHERE job = ? AND id <= coalesce((SELECT id FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT 1 OFFSET ?), 0)`,
			run.Job, run.Job, keepRuns)
		return err
	})
	return id, err
}

func (r *Runner) runs(ctx context.Context, name string, limit int) ([]Run, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT id, job, trigger, started_at, finished_at, outcome, summary, details, error
		FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT ?`, name, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Run{}
	for rows.Next() {
		var run Run
		var started, finished int64
		var details string
		if err := rows.Scan(&run.ID, &run.Job, &run.Trigger, &started, &finished, &run.Outcome, &run.Summary, &details, &run.Error); err != nil {
			return nil, err
		}
		run.StartedAt, run.FinishedAt = store.FromMillis(started), store.FromMillis(finished)
		run.DurationMs = run.FinishedAt.Sub(run.StartedAt).Milliseconds()
		if json.Unmarshal([]byte(details), &run.Details) != nil || run.Details == nil {
			run.Details = map[string]any{}
		}
		out = append(out, run)
	}
	return out, rows.Err()
}

// JobView is a job as the API returns it.
type JobView struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Schedule    string     `json:"schedule" doc:"When it runs, e.g. every 1h0m0s."`
	NextRunAt   *time.Time `json:"next_run_at,omitempty" doc:"When the schedule runs it next."`
	Running     bool       `json:"running" doc:"true while a run is in progress or waiting for one to end."`
	LastRun     *Run       `json:"last_run,omitempty" doc:"The latest stored run, scheduled or manual."`
	Runs        []Run      `json:"runs,omitempty" doc:"The latest runs, newest first (on GET /api/jobs/{job} only)."`
}

// JobList is the response of GET /api/jobs.
type JobList struct {
	Jobs []JobView `json:"jobs"`
}

func (r *Runner) view(ctx context.Context, e *entry, runs int) (JobView, error) {
	e.mu.Lock()
	v := JobView{Name: e.job.Name, Description: e.job.Description, Schedule: e.job.Schedule.String(), Running: e.pending > 0}
	if !e.next.IsZero() {
		next := e.next.UTC()
		v.NextRunAt = &next
	}
	e.mu.Unlock()
	n := runs
	if n < 1 {
		n = 1
	}
	list, err := r.runs(ctx, e.job.Name, n)
	if err != nil {
		return v, err
	}
	if len(list) > 0 {
		v.LastRun = &list[0]
	}
	if runs > 0 {
		v.Runs = list
	}
	return v, nil
}

func notFound(name string) *api.Error {
	return api.NotFound("List the jobs with GET /api/jobs.", "There is no job named %q.", name).
		WithDetails(map[string]string{"resource": "job", "ref": name})
}

// Routes returns the jobs routes.
func Routes(r *Runner) []api.Route {
	const tag = "Jobs"
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/jobs", Tag: tag,
			Summary:     "List background jobs with their schedule, next run and last run",
			Description: "Iroha runs only these jobs; none of them ever changes or deletes Upstream Keys. Every run is also a job.run log event.",
			Response:    JobList{},
			Handle: func(c *api.Call) (any, error) {
				out := JobList{Jobs: []JobView{}}
				for _, e := range r.order {
					v, err := r.view(c.R.Context(), e, 0)
					if err != nil {
						return nil, err
					}
					out.Jobs = append(out.Jobs, v)
				}
				return out, nil
			},
		},
		{
			Method: http.MethodGet, Path: "/api/jobs/{job}", Tag: tag,
			Summary:  "Read one job with its latest runs",
			Response: JobView{},
			Handle: func(c *api.Call) (any, error) {
				e, ok := r.byName[c.Path("job")]
				if !ok {
					return nil, notFound(c.Path("job"))
				}
				return r.view(c.R.Context(), e, 20)
			},
		},
		{
			Method: http.MethodPost, Path: "/api/jobs/{job}/run", Tag: tag,
			Summary:     "Run a job now and wait for its result",
			Description: "Waits for a run already in progress to end first. With dry_run=true the job reports what it would do and changes nothing; dry runs are logged but not stored. The answer is 200 even when the run failed: read outcome and error.",
			Query:       []api.Param{audit.DryRun},
			Response:    Run{},
			Handle: func(c *api.Call) (any, error) {
				dry, err := audit.IsDryRun(c)
				if err != nil {
					return nil, err
				}
				return r.RunNow(c.Path("job"), dry)
			},
		},
	}
}
