package keystate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/store"
)

// Model Gaps (ADR-0003): a key refused one model keeps its Key State and
// serves its other models; the refused model is not sent to it until the
// gap expires (GapLifetime after it was recorded) or is cleared by a passing
// key test, an edit of the key, the Owner (by hand, audited and revertible),
// or the key's discovered model list naming the model (ticket 10). Expired
// gaps stop counting at once; their rows are deleted, and logged as expired,
// the next time a Request plans over the Provider (ExpireGaps).

// GapLifetime is how long a Model Gap lasts.
const GapLifetime = 24 * time.Hour

// Model Gap log operations (attribute op of logs.KindModelGap).
const (
	GapCreated = "created"
	GapCleared = "cleared"
	GapExpired = "expired"
)

// ModelGap is one Model Gap of an Upstream Key.
type ModelGap struct {
	ID        string    `json:"-"`
	Model     string    `json:"model" doc:"The model as sent upstream."`
	Reason    string    `json:"reason" doc:"What the Provider answered, e.g. \"404 model_not_found: The model does not exist (rule model-not-found)\"."`
	Rule      string    `json:"rule,omitempty" doc:"The Failure Rule that recorded the gap."`
	RequestID string    `json:"request_id,omitempty" doc:"The Request whose Attempt was refused; absent when a key test found the gap."`
	CreatedAt time.Time `json:"created_at"`
	ExpiresAt time.Time `json:"expires_at" doc:"When the model is sent to this key again by itself (created_at + 24 h)."`
}

// LiveGaps lists the key's Model Gaps that have not expired at now.
func (r Record) LiveGaps(now time.Time) []ModelGap {
	out := []ModelGap{}
	for _, g := range r.Gaps {
		if g.ExpiresAt.After(now) {
			out = append(out, g)
		}
	}
	return out
}

// GapsByModel maps each model of the key's stored Model Gaps to its expiry,
// which may be past; nil when there are none.
func (r Record) GapsByModel() map[string]time.Time {
	var out map[string]time.Time
	for _, g := range r.Gaps {
		if out == nil {
			out = map[string]time.Time{}
		}
		out[g.Model] = g.ExpiresAt
	}
	return out
}

func readGaps(ctx context.Context, q Querier, keysQuery, arg string, out map[string]Record) error {
	rows, err := q.QueryContext(ctx, `SELECT id, key_id, model, reason, rule, request_id, created_at, expires_at FROM model_gaps
		WHERE key_id IN (`+keysQuery+`) ORDER BY expires_at, model`, arg)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var keyID string
		var g ModelGap
		var created, expires int64
		if err := rows.Scan(&g.ID, &keyID, &g.Model, &g.Reason, &g.Rule, &g.RequestID, &created, &expires); err != nil {
			return err
		}
		g.CreatedAt, g.ExpiresAt = store.FromMillis(created), store.FromMillis(expires)
		rec := out[keyID]
		rec.Gaps = append(rec.Gaps, g)
		out[keyID] = rec
	}
	return rows.Err()
}

// putGap records (or renews) the Model Gap of key for model.
func putGap(ctx context.Context, tx *sql.Tx, keyID, model, reason, rule, requestID string, now time.Time) (time.Time, error) {
	expires := now.Add(GapLifetime).UTC()
	_, err := tx.ExecContext(ctx, `INSERT INTO model_gaps (id, key_id, model, reason, rule, request_id, created_at, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key_id, model) DO UPDATE SET reason = excluded.reason, rule = excluded.rule,
		request_id = excluded.request_id, created_at = excluded.created_at, expires_at = excluded.expires_at`,
		ids.New("mg"), keyID, model, reason, rule, requestID, store.Millis(now), store.Millis(expires))
	return expires, err
}

// GapEvent is one Model Gap change, logged as model_gap once it committed.
type GapEvent struct {
	Op        string // GapCreated, GapCleared or GapExpired
	Key       Key
	Model     string
	Reason    string    // why it was created or cleared
	Until     time.Time // when the gap expires (or expired)
	RequestID string
}

// LogGaps logs Model Gap changes after they committed.
func LogGaps(log *slog.Logger, events []GapEvent) {
	for _, e := range events {
		attrs := []any{logs.Kind(logs.KindModelGap), logs.Provider(e.Key.Provider), "op", e.Op,
			"upstream_key", e.Key.Name, "upstream_key_id", e.Key.ID, "model", e.Model, "reason", e.Reason}
		if !e.Until.IsZero() {
			attrs = append(attrs, "until", e.Until.UTC().Format(time.RFC3339))
		}
		if e.RequestID != "" {
			attrs = append(attrs, logs.Request(e.RequestID))
		}
		msg := "Model Gap " + e.Op
		log.Info(msg, attrs...)
	}
}

// ClearGaps deletes the Model Gaps of key k inside tx: every gap, or only
// model's when model is not empty. Gaps still live at now are passed to
// track before they are deleted (nil: not tracked) and come back as cleared
// events with reason why; gaps already expired are deleted as expired. The
// caller logs the events after commit (LogGaps).
func ClearGaps(ctx context.Context, tx *sql.Tx, k Key, model, why string, now time.Time, track func(id string) error) ([]GapEvent, error) {
	recs := map[string]Record{}
	if err := readGaps(ctx, tx, `SELECT ?`, k.ID, recs); err != nil {
		return nil, err
	}
	var events []GapEvent
	for _, g := range recs[k.ID].Gaps {
		if model != "" && g.Model != model {
			continue
		}
		e := GapEvent{Op: GapCleared, Key: k, Model: g.Model, Reason: why, Until: g.ExpiresAt}
		if !g.ExpiresAt.After(now) {
			e.Op, e.Reason = GapExpired, "The Model Gap expired."
		} else if track != nil {
			if err := track(g.ID); err != nil {
				return nil, err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM model_gaps WHERE id = ?`, g.ID); err != nil {
			return nil, err
		}
		events = append(events, e)
	}
	return events, nil
}

// ExpireGaps deletes the expired Model Gaps of every key of a Provider and
// logs each as expired. The Gateway calls it when the routing view it
// planned over held an expired gap.
func (s *Store) ExpireGaps(ctx context.Context, providerID, handle string) error {
	ctx = context.WithoutCancel(ctx)
	now := s.db.Clock().Now().UTC()
	var events []GapEvent
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		events = nil
		rows, err := tx.QueryContext(ctx, `SELECT g.id, g.key_id, k.name, g.model, g.expires_at FROM model_gaps g JOIN upstream_keys k ON k.id = g.key_id
			WHERE k.provider_id = ? AND g.expires_at <= ? ORDER BY g.expires_at, g.model`, providerID, store.Millis(now))
		if err != nil {
			return err
		}
		var idsToDelete []string
		for rows.Next() {
			var id string
			var e GapEvent
			var expires int64
			if err := rows.Scan(&id, &e.Key.ID, &e.Key.Name, &e.Model, &expires); err != nil {
				rows.Close()
				return err
			}
			e.Op, e.Key.Provider, e.Until, e.Reason = GapExpired, handle, store.FromMillis(expires), "The Model Gap expired."
			events = append(events, e)
			idsToDelete = append(idsToDelete, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		for _, id := range idsToDelete {
			if _, err := tx.ExecContext(ctx, `DELETE FROM model_gaps WHERE id = ?`, id); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	LogGaps(s.log, events)
	return nil
}

// gapSnapshot is what an Audit Entry records of a Model Gap the Owner
// cleared, so a revert can put it back.
type gapSnapshot struct {
	ID          string    `json:"id"`
	KeyID       string    `json:"key_id"`
	Provider    string    `json:"provider"`
	UpstreamKey string    `json:"upstream_key"`
	Model       string    `json:"model"`
	Reason      string    `json:"reason"`
	Rule        string    `json:"rule,omitempty"`
	RequestID   string    `json:"request_id,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
	ExpiresAt   time.Time `json:"expires_at"`
}

// GapResource is the Model Gap resource of the audit machinery. Gaps are
// learned at runtime without Audit Entries; only clearing them through the
// admin API is audited, so the Owner can undo it.
var GapResource = audit.Register(&audit.Resource[gapSnapshot]{
	Name: "model_gap", Label: "Model Gap", Plural: "Model Gaps", Path: "/api/providers/{provider}/model-gaps",
	Table: "model_gaps", NameColumn: "model",
	NameOf: func(s gapSnapshot) string { return s.Provider + "/" + s.UpstreamKey + "/" + s.Model },
	Load: func(ctx context.Context, q audit.Querier, id string) (*gapSnapshot, error) {
		var s gapSnapshot
		var created, expires int64
		err := q.QueryRowContext(ctx, `SELECT g.id, g.key_id, p.handle, k.name, g.model, g.reason, g.rule, g.request_id, g.created_at, g.expires_at
			FROM model_gaps g JOIN upstream_keys k ON k.id = g.key_id JOIN providers p ON p.id = k.provider_id WHERE g.id = ?`, id).
			Scan(&s.ID, &s.KeyID, &s.Provider, &s.UpstreamKey, &s.Model, &s.Reason, &s.Rule, &s.RequestID, &created, &expires)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		s.CreatedAt, s.ExpiresAt = store.FromMillis(created), store.FromMillis(expires)
		return &s, err
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *gapSnapshot) error {
		if s == nil {
			_, err := tx.ExecContext(ctx, `DELETE FROM model_gaps WHERE id = ?`, id)
			return err
		}
		var x int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM upstream_keys WHERE id = ?`, s.KeyID).Scan(&x)
		if errors.Is(err, sql.ErrNoRows) {
			return api.Conflict("upstream_key_gone", "Restore the Upstream Key first (revert the entry that deleted it), then retry.",
				"Upstream Key %s/%s no longer exists, so its Model Gap for %s cannot come back.", s.Provider, s.UpstreamKey, s.Model)
		}
		if err != nil {
			return err
		}
		// A gap learned since for the same model gives way to the restored one.
		if _, err := tx.ExecContext(ctx, `DELETE FROM model_gaps WHERE key_id = ? AND model = ? AND id != ?`, s.KeyID, s.Model, id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO model_gaps (id, key_id, model, reason, rule, request_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET reason = excluded.reason, rule = excluded.rule, request_id = excluded.request_id,
			created_at = excluded.created_at, expires_at = excluded.expires_at`,
			id, s.KeyID, s.Model, s.Reason, s.Rule, s.RequestID, store.Millis(s.CreatedAt), store.Millis(s.ExpiresAt))
		if err != nil {
			return fmt.Errorf("restore model gap %s: %w", id, err)
		}
		return nil
	},
})
