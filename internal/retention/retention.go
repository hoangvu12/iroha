// Package retention keeps history from growing without bound: its settings
// say how long each kind of data is kept, and its hourly job deletes what
// is older.
package retention

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/jobs"
	"github.com/hoangvu12/iroha/internal/settings"
	"github.com/hoangvu12/iroha/internal/store"
)

// Retention settings, one per kind of data.
var (
	HistoryDays = settings.NewInt(settings.Int{
		Name: "retention.history_days", Unit: "days", Default: 30, Min: 1, Max: 3650,
		Description: "How long Requests and their Attempts are kept, counted from when the Request started. Deleting a Request deletes its capture too.",
	})
	LogsDays = settings.NewInt(settings.Int{
		Name: "retention.logs_days", Unit: "days", Default: 30, Min: 1, Max: 3650,
		Description: "How long log events (GET /api/logs) are kept; also how long Owner sessions stay listed after they were revoked or expired.",
	})
	CapturesDays = settings.NewInt(settings.Int{
		Name: "retention.captures_days", Unit: "days", Default: 3, Min: 1, Max: 3650,
		Description: "How long captured prompts and responses (Gateway Keys with capture on) are kept. The Request itself stays for retention.history_days.",
	})
)

// JobName is the name of the retention job.
const JobName = "retention"

// batch is how many rows one delete removes, so a large cleanup never holds
// the write lock for long.
const batch = 2000

// kind is one kind of data the job deletes.
type kind struct {
	detail  string // figure name in the run's details
	label   string // plural for the summary
	setting *settings.Int
	count   string // SQL counting rows older than ?
	delete  string // SQL deleting at most ? rows older than ?
}

var kinds = []kind{
	{
		detail: "captures", label: "captures", setting: CapturesDays,
		count:  `SELECT count(*) FROM captures WHERE created_at < ?`,
		delete: `DELETE FROM captures WHERE request_id IN (SELECT request_id FROM captures WHERE created_at < ? LIMIT ?)`,
	},
	{
		detail: "requests", label: "Requests", setting: HistoryDays,
		count:  `SELECT count(*) FROM requests WHERE started_at < ?`,
		delete: `DELETE FROM requests WHERE rowid IN (SELECT rowid FROM requests WHERE started_at < ? LIMIT ?)`,
	},
	{
		detail: "log_events", label: "log events", setting: LogsDays,
		count:  `SELECT count(*) FROM log_events WHERE logged_at < ?`,
		delete: `DELETE FROM log_events WHERE id IN (SELECT id FROM log_events WHERE logged_at < ? LIMIT ?)`,
	},
	{
		// An Owner session stops working when revoked or expired; it stays
		// listed (GET /api/owner-sessions?active=false) as long as log events.
		detail: "owner_sessions", label: "Owner sessions", setting: LogsDays,
		count:  `SELECT count(*) FROM owner_sessions WHERE ` + sessionEnded + ` < ?`,
		delete: `DELETE FROM owner_sessions WHERE rowid IN (SELECT rowid FROM owner_sessions WHERE ` + sessionEnded + ` < ? LIMIT ?)`,
	},
}

// sessionEnded is when an Owner session stopped working: revoked or expired,
// whichever came first.
const sessionEnded = `min(coalesce(revoked_at, expires_at), expires_at)`

// Job is the hourly retention job.
func Job(db *store.DB) jobs.Job {
	return jobs.Job{
		Name:        JobName,
		Description: "Deletes Requests (with their Attempts), captures, log events and ended Owner sessions older than their retention settings (GET /api/settings).",
		Schedule:    jobs.Every(time.Hour),
		Run: func(ctx context.Context, dry bool) (jobs.Outcome, error) {
			return run(ctx, db, dry)
		},
	}
}

func run(ctx context.Context, db *store.DB, dry bool) (jobs.Outcome, error) {
	now := db.Clock().Now()
	out := jobs.Outcome{Details: map[string]any{}}
	var parts []string
	for _, k := range kinds {
		days, err := k.setting.Get(ctx, db)
		if err != nil {
			return out, err
		}
		cutoff := store.Millis(now.Add(-time.Duration(days) * 24 * time.Hour))
		var n int64
		if dry {
			err = db.QueryRowContext(ctx, k.count, cutoff).Scan(&n)
		} else {
			n, err = deleteOlder(ctx, db, k.delete, cutoff)
		}
		out.Details[k.detail] = n
		out.Details[k.detail+"_days"] = days
		if err != nil {
			return out, fmt.Errorf("deleting %s: %w", k.label, err)
		}
		parts = append(parts, fmt.Sprintf("%d %s", n, k.label))
	}
	verb := "Deleted"
	if dry {
		verb = "Would delete"
	}
	last := len(parts) - 1
	out.Summary = fmt.Sprintf("%s %s and %s.", verb, strings.Join(parts[:last], ", "), parts[last])
	return out, nil
}

// deleteOlder deletes in batches until nothing older than cutoff is left.
func deleteOlder(ctx context.Context, db *store.DB, query string, cutoff int64) (int64, error) {
	var total int64
	for {
		if err := ctx.Err(); err != nil {
			return total, err
		}
		var n int64
		err := db.Tx(ctx, func(tx *sql.Tx) error {
			res, err := tx.ExecContext(ctx, query, cutoff, batch)
			if err != nil {
				return err
			}
			n, err = res.RowsAffected()
			return err
		})
		total += n
		if err != nil || n < batch {
			return total, err
		}
	}
}
