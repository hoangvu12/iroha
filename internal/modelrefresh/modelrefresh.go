// Package modelrefresh schedules the daily model refresh: every enabled
// Provider's model list is refreshed (models.Store.Refresh) once a day, each
// Provider at its own time of day so the refreshes are spread across the
// day. It only decides when; discovery itself belongs to internal/models.
//
// The schedule:
//
//   - Each Provider has a daily time (DailyAt), derived from its ID: stable
//     across restarts and renames, and spread across the day.
//   - A Provider is due at the first occurrence of its daily time at least
//     12 h after its last refresh (scheduled or by hand), so a scheduled
//     refresh recurs every 24 h and one made by hand counts as the day's.
//   - A Provider never refreshed is due soon: at its creation, or at this
//     start of Iroha if later, plus its daily time's minutes within an hour
//     (DailyAt mod 1 h). A refresh that fell due while Iroha was down is
//     due at that same point after the start. So the first hour after a start spreads the catch-up
//     across the hour instead of a burst, and a new Provider's models are
//     discovered within the hour.
//   - Disabled, archived and discovery none Providers are not scheduled.
//
// The job runs every Tick and refreshes the Providers that are due, one at
// a time. Nothing in it touches Upstream Keys or their Key States.
package modelrefresh

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/jobs"
	"github.com/hoangvu12/iroha/internal/models"
	"github.com/hoangvu12/iroha/internal/store"
)

// JobName is the name of the daily model refresh job.
const JobName = "model_refresh"

const (
	// Tick is how often the job looks for Providers that are due; a
	// Provider is refreshed at most this long after its time.
	Tick = 15 * time.Minute
	// minGap is the least time between a refresh and the next scheduled one.
	minGap = 12 * time.Hour
	// firstWithin is the window over which first refreshes (and refreshes
	// missed while Iroha was down) are spread after a start or a creation.
	firstWithin = time.Hour
	day         = 24 * time.Hour
)

// DailyAt is the time of day (UTC, whole minutes) at which the Provider
// with this ID refreshes: a hash of the ID, so it never changes and
// Providers spread evenly across the day.
func DailyAt(providerID string) time.Duration {
	sum := sha256.Sum256([]byte(providerID))
	minutes := binary.BigEndian.Uint64(sum[:8]) % uint64(day/time.Minute)
	return time.Duration(minutes) * time.Minute
}

// nextRefresh is when a Provider is next due. start is when this run of
// Iroha started, created when the Provider was created, last its latest
// refresh (nil: never).
func nextRefresh(providerID string, created time.Time, last *models.LastRefresh, start time.Time) time.Time {
	at := DailyAt(providerID)
	anchor := start
	if created.After(anchor) {
		anchor = created
	}
	soon := anchor.Add(at % firstWithin)
	if last == nil {
		return soon
	}
	from := last.At.Add(minGap)
	next := from.Truncate(day).Add(at) // Truncate works in UTC
	if next.Before(from) {
		next = next.Add(day)
	}
	if next.Before(start) {
		return soon // missed while Iroha was down: spread like a first refresh
	}
	return next
}

// Scheduler decides which Providers are due and refreshes them.
type Scheduler struct {
	db     *store.DB
	models *models.Store
	start  time.Time
}

// New returns the Scheduler of this run of Iroha; it takes the clock's now
// as the start that spreads first and missed refreshes.
func New(db *store.DB, m *models.Store) *Scheduler {
	return &Scheduler{db: db, models: m, start: db.Clock().Now()}
}

// Not-scheduled reasons.
const (
	ReasonDisabled    = "disabled"
	ReasonNoDiscovery = "discovery_none"
)

// Entry is one Provider's place in the daily schedule.
type Entry struct {
	Provider      string              `json:"provider"`
	DailyAt       string              `json:"daily_at" doc:"The Provider's time of day for its refresh, HH:MM UTC; fixed for the Provider."`
	Scheduled     bool                `json:"scheduled" doc:"false: the job does not refresh this Provider (see not_scheduled)."`
	NotScheduled  string              `json:"not_scheduled,omitempty" enum:"disabled,discovery_none" doc:"Why the Provider is not scheduled."`
	NextRefreshAt *time.Time          `json:"next_refresh_at,omitempty" doc:"When the job refreshes it next (within 15 minutes after). Past: due at the job's next run."`
	LastRefresh   *models.LastRefresh `json:"last_refresh,omitempty" doc:"The latest refresh, scheduled or by hand; absent when never refreshed."`

	id string
}

// Schedule is the response of GET /api/model-refreshes.
type Schedule struct {
	Providers []Entry `json:"providers" doc:"Every Provider that is not archived, by handle."`
}

func (s *Scheduler) schedule(ctx context.Context) ([]Entry, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, handle, enabled, discovery, created_at FROM providers WHERE archived = 0 ORDER BY handle`)
	if err != nil {
		return nil, err
	}
	type row struct {
		id, handle, discovery string
		enabled               bool
		created               int64
	}
	var list []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.handle, &r.enabled, &r.discovery, &r.created); err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []Entry{}
	for _, r := range list {
		at := DailyAt(r.id)
		e := Entry{Provider: r.handle, id: r.id, DailyAt: fmt.Sprintf("%02d:%02d", int(at.Hours()), int(at.Minutes())%60)}
		if e.LastRefresh, err = s.models.LastRefreshOf(ctx, r.id); err != nil {
			return nil, err
		}
		switch {
		case !r.enabled:
			e.NotScheduled = ReasonDisabled
		case r.discovery == "none":
			e.NotScheduled = ReasonNoDiscovery
		default:
			e.Scheduled = true
			next := nextRefresh(r.id, store.FromMillis(r.created), e.LastRefresh, s.start).UTC()
			e.NextRefreshAt = &next
		}
		out = append(out, e)
	}
	return out, nil
}

// Job is the daily model refresh job.
func (s *Scheduler) Job() jobs.Job {
	return jobs.Job{
		Name: JobName,
		Description: "Refreshes each enabled Provider's model list once a day, each Provider at its own time (GET /api/model-refreshes). " +
			"Runs every 15 minutes and refreshes the Providers that are due, one at a time.",
		Schedule: jobs.Every(Tick),
		Run:      s.run,
	}
}

func (s *Scheduler) run(ctx context.Context, dry bool) (jobs.Outcome, error) {
	now := s.db.Clock().Now()
	entries, err := s.schedule(ctx)
	if err != nil {
		return jobs.Outcome{}, err
	}
	var due []Entry
	var upcoming *Entry
	for i := range entries {
		e := &entries[i]
		if !e.Scheduled {
			continue
		}
		if !e.NextRefreshAt.After(now) {
			due = append(due, *e)
		} else if upcoming == nil || e.NextRefreshAt.Before(*upcoming.NextRefreshAt) {
			upcoming = e
		}
	}
	sort.SliceStable(due, func(i, j int) bool { return due[i].NextRefreshAt.Before(*due[j].NextRefreshAt) })

	out := jobs.Outcome{Details: map[string]any{"due": len(due)}}
	if upcoming != nil {
		out.Details["next_provider"] = upcoming.Provider
		out.Details["next_refresh_at"] = upcoming.NextRefreshAt.Format(time.RFC3339)
	}
	if len(due) == 0 {
		out.Summary = "No model list was due."
		if upcoming != nil {
			out.Summary = fmt.Sprintf("No model list was due; next: %s at %s.", upcoming.Provider, upcoming.NextRefreshAt.Format("2006-01-02 15:04 UTC"))
		}
		return out, nil
	}
	handles := make([]string, len(due))
	for i, e := range due {
		handles[i] = e.Provider
	}
	if len(due) == 1 {
		out.Provider = due[0].Provider
	}
	if dry {
		out.Details["providers"] = handles
		out.Summary = fmt.Sprintf("Would refresh %d model %s: %s.", len(due), plural(len(due), "list", "lists"), strings.Join(handles, ", "))
		return out, nil
	}

	counts := map[string]int{}
	var done, errs []string
	for _, e := range due {
		if err := ctx.Err(); err != nil {
			out.Summary = summary(done, len(due))
			return out, err
		}
		res, err := s.models.Refresh(ctx, e.id, false)
		var ae *api.Error
		if errors.As(err, &ae) && ae.Status == http.StatusNotFound {
			continue // deleted since the schedule was read
		}
		if err != nil {
			errs = append(errs, e.Provider+": "+err.Error())
			continue
		}
		counts[res.Outcome]++
		done = append(done, e.Provider+" "+res.Outcome)
	}
	out.Details["refreshed"] = len(done)
	out.Details["providers"] = handles
	for _, o := range []string{models.RefreshOK, models.RefreshPartial, models.RefreshFailed, models.RefreshSkipped} {
		out.Details[o] = counts[o]
	}
	out.Summary = summary(done, len(due))
	if len(errs) > 0 {
		return out, fmt.Errorf("refreshing %s", strings.Join(errs, "; "))
	}
	return out, nil
}

func summary(done []string, due int) string {
	s := fmt.Sprintf("Refreshed %d model %s", len(done), plural(len(done), "list", "lists"))
	if len(done) > 0 {
		s += ": " + strings.Join(done, ", ")
	}
	if len(done) < due {
		s += fmt.Sprintf(" (%d due)", due)
	}
	return s + "."
}

func plural(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// Routes returns GET /api/model-refreshes.
func Routes(s *Scheduler) []api.Route {
	return []api.Route{{
		Method: http.MethodGet, Path: "/api/model-refreshes", Tag: "Jobs",
		Summary: "List each Provider's daily model refresh: its time of day, next refresh and last result",
		Description: "The model_refresh job refreshes each enabled Provider's model list once a day at the Provider's daily_at, and a Provider never refreshed " +
			"within an hour of its creation (or of Iroha's start). A refresh by hand (POST /api/providers/{provider}/models/refresh) counts as the day's. " +
			"Each refresh is logged as discovery events (GET /api/logs?kind=discovery&provider=<handle>), each job run as a job.run event.",
		Response: Schedule{},
		Handle: func(c *api.Call) (any, error) {
			list, err := s.schedule(c.R.Context())
			if err != nil {
				return nil, err
			}
			return Schedule{Providers: list}, nil
		},
	}}
}
