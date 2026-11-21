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

type Schedule interface {
	Next(last, now time.Time) time.Time
	String() string
}

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

type Outcome struct {
	Summary  string
	Details  map[string]any
	Provider string
}

type Job struct {
	Name        string
	Description string
	Schedule    Schedule
	Run         func(ctx context.Context, dryRun bool) (Outcome, error)
}

const (
	TriggerSchedule = "schedule"
	TriggerManual   = "manual"
)

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

const keepRuns = 100

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
	job   Job
	run   sync.Mutex
	fired chan struct{}

	mu      sync.Mutex
	pending int
	next    time.Time
}

func NewRunner(db *store.DB, log *slog.Logger) *Runner {
	ctx, cancel := context.WithCancel(context.Background())
	return &Runner{db: db, log: log, clock: db.Clock(), byName: map[string]*entry{}, ctx: ctx, cancel: cancel}
}

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
	e := &entry{job: j, fired: make(chan struct{}, 1)}
	r.order = append(r.order, e)
	r.byName[j.Name] = e
}

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
		t := r.arm(e, e.job.Schedule.Next(store.NullMillis(last), now).Sub(now))
		r.wg.Add(1)
		go r.loop(e, t)
	}
	return nil
}

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
		case <-e.fired:
		}
		if r.ctx.Err() != nil {
			return
		}
		t = r.startNextPeriod(e)
		r.run(r.ctx, e, TriggerSchedule, false)
		e.markSettled()
	}
}

func (r *Runner) startNextPeriod(e *entry) clock.Timer {
	now := r.clock.Now()
	return r.arm(e, e.job.Schedule.Next(now, now).Sub(now))
}

func (r *Runner) arm(e *entry, d time.Duration) clock.Timer {
	e.mu.Lock()
	e.next = r.clock.Now().Add(d)
	e.mu.Unlock()
	return r.clock.AfterFunc(d, func() {
		e.markOwed()
		e.fired <- struct{}{}
	})
}

func (e *entry) markOwed() {
	e.mu.Lock()
	e.pending++
	e.mu.Unlock()
}

func (e *entry) markSettled() {
	e.mu.Lock()
	e.pending--
	e.mu.Unlock()
}

func (r *Runner) RunNow(name string, dryRun bool) (Run, error) {
	e, ok := r.byName[name]
	if !ok {
		return Run{}, notFound(name)
	}
	e.markOwed()
	defer e.markSettled()
	return r.run(r.ctx, e, TriggerManual, dryRun), nil
}

func (r *Runner) run(ctx context.Context, e *entry, trigger string, dry bool) Run {
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
			continue
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

type JobView struct {
	Name        string     `json:"name"`
	Description string     `json:"description"`
	Schedule    string     `json:"schedule" doc:"When it runs, e.g. every 1h0m0s."`
	NextRunAt   *time.Time `json:"next_run_at,omitempty" doc:"When the schedule runs it next."`
	Running     bool       `json:"running" doc:"true while a run is in progress or waiting for one to end."`
	LastRun     *Run       `json:"last_run,omitempty" doc:"The latest stored run, scheduled or manual."`
	Runs        []Run      `json:"runs,omitempty" doc:"The latest runs, newest first (on GET /api/jobs/{job} only)."`
}

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
