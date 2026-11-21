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

const JobName = "model_refresh"

const (
	Tick        = 15 * time.Minute
	minGap      = 12 * time.Hour
	firstWithin = time.Hour
	day         = 24 * time.Hour
)

func DailyAt(providerID string) time.Duration {
	sum := sha256.Sum256([]byte(providerID))
	minutes := binary.BigEndian.Uint64(sum[:8]) % uint64(day/time.Minute)
	return time.Duration(minutes) * time.Minute
}

func nextRefresh(providerID string, created time.Time, last *models.LastRefresh, start time.Time) time.Time {
	at := DailyAt(providerID)
	if last == nil {
		return spreadAfterStart(at, created, start)
	}
	scheduled := dailyAfterGap(at, last.At)
	if missedWhileDown := scheduled.Before(start); missedWhileDown {
		return spreadAfterStart(at, created, start)
	}
	return scheduled
}

func spreadAfterStart(dailyAt time.Duration, created, start time.Time) time.Time {
	anchor := start
	if created.After(anchor) {
		anchor = created
	}
	return anchor.Add(dailyAt % firstWithin)
}

func dailyAfterGap(dailyAt time.Duration, last time.Time) time.Time {
	from := last.Add(minGap)
	next := from.Truncate(day).Add(dailyAt) // Truncate works in UTC
	if next.Before(from) {
		next = next.Add(day)
	}
	return next
}

type Scheduler struct {
	db     *store.DB
	models *models.Store
	start  time.Time
}

func New(db *store.DB, m *models.Store) *Scheduler {
	return &Scheduler{db: db, models: m, start: db.Clock().Now()}
}

const (
	ReasonDisabled    = "disabled"
	ReasonNoDiscovery = "discovery_none"
)

type Entry struct {
	Provider      string              `json:"provider"`
	DailyAt       string              `json:"daily_at" doc:"The Provider's time of day for its refresh, HH:MM UTC; fixed for the Provider."`
	Scheduled     bool                `json:"scheduled" doc:"false: the job does not refresh this Provider (see not_scheduled)."`
	NotScheduled  string              `json:"not_scheduled,omitempty" enum:"disabled,discovery_none" doc:"Why the Provider is not scheduled."`
	NextRefreshAt *time.Time          `json:"next_refresh_at,omitempty" doc:"When the job refreshes it next (within 15 minutes after). Past: due at the job's next run."`
	LastRefresh   *models.LastRefresh `json:"last_refresh,omitempty" doc:"The latest refresh, scheduled or by hand; absent when never refreshed."`

	id string
}

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
			continue
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
