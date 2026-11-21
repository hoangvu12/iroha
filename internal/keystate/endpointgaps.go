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

var KindEndpointGap = logs.NewKind("endpoint_gap",
	"An Endpoint Gap was created or cleared: op (created, cleared), upstream_key, endpoint, reason. Linked to the Provider, and to the Request that caused it.")

type Endpoint struct {
	ID   string
	Name string
}

type EndpointGap struct {
	ID         string    `json:"-"`
	EndpointID string    `json:"endpoint_id"`
	Endpoint   string    `json:"endpoint" doc:"Name of the Endpoint this key is not sent to."`
	Reason     string    `json:"reason" doc:"What the Provider answered there and where the key works, e.g. \"401 invalid_api_key: Incorrect API key (rule auth-invalid); it works on eu\"."`
	Rule       string    `json:"rule,omitempty" doc:"The Failure Rule that matched the refusal."`
	RequestID  string    `json:"request_id,omitempty" doc:"The Request whose Attempt was refused; absent when a key test found the gap."`
	CreatedAt  time.Time `json:"created_at"`
}

type EndpointSuccess struct {
	EndpointID  string    `json:"endpoint_id"`
	Endpoint    string    `json:"endpoint" doc:"Name of the Endpoint."`
	SucceededAt time.Time `json:"succeeded_at" doc:"The latest 2xx Attempt or passing key test there, to the minute."`
}

func (r Record) EndpointGapSet() map[string]bool {
	var out map[string]bool
	for _, g := range r.EndpointGaps {
		if out == nil {
			out = map[string]bool{}
		}
		out[g.EndpointID] = true
	}
	return out
}

func (r Record) WorkedOn() map[string]time.Time {
	var out map[string]time.Time
	for _, s := range r.Worked {
		if out == nil {
			out = map[string]time.Time{}
		}
		out[s.EndpointID] = s.SucceededAt
	}
	return out
}

func readEndpointGaps(ctx context.Context, q Querier, keysQuery, arg string, out map[string]Record) error {
	rows, err := q.QueryContext(ctx, `SELECT g.id, g.key_id, g.endpoint_id, e.name, g.reason, g.rule, g.request_id, g.created_at
		FROM endpoint_gaps g JOIN endpoints e ON e.id = g.endpoint_id
		WHERE g.key_id IN (`+keysQuery+`) ORDER BY e.created_at, e.rowid`, arg)
	if err != nil {
		return err
	}
	for rows.Next() {
		var keyID string
		var g EndpointGap
		var created int64
		if err := rows.Scan(&g.ID, &keyID, &g.EndpointID, &g.Endpoint, &g.Reason, &g.Rule, &g.RequestID, &created); err != nil {
			rows.Close()
			return err
		}
		g.CreatedAt = store.FromMillis(created)
		rec := out[keyID]
		rec.EndpointGaps = append(rec.EndpointGaps, g)
		out[keyID] = rec
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	rows, err = q.QueryContext(ctx, `SELECT s.key_id, s.endpoint_id, e.name, s.succeeded_at
		FROM key_endpoint_successes s JOIN endpoints e ON e.id = s.endpoint_id
		WHERE s.key_id IN (`+keysQuery+`) ORDER BY e.created_at, e.rowid`, arg)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var keyID string
		var s EndpointSuccess
		var at int64
		if err := rows.Scan(&keyID, &s.EndpointID, &s.Endpoint, &at); err != nil {
			return err
		}
		s.SucceededAt = store.FromMillis(at)
		rec := out[keyID]
		rec.Worked = append(rec.Worked, s)
		out[keyID] = rec
	}
	return rows.Err()
}

func workedElsewhere(ctx context.Context, tx *sql.Tx, keyID, endpointID string) (string, error) {
	var name string
	err := tx.QueryRowContext(ctx, `SELECT e.name FROM key_endpoint_successes s JOIN endpoints e ON e.id = s.endpoint_id
		WHERE s.key_id = ? AND s.endpoint_id != ?
		AND NOT EXISTS (SELECT 1 FROM endpoint_gaps g WHERE g.key_id = s.key_id AND g.endpoint_id = s.endpoint_id)
		AND (NOT EXISTS (SELECT 1 FROM upstream_key_endpoints r WHERE r.key_id = s.key_id)
			OR EXISTS (SELECT 1 FROM upstream_key_endpoints r WHERE r.key_id = s.key_id AND r.endpoint_id = s.endpoint_id))
		ORDER BY s.succeeded_at DESC, e.name LIMIT 1`, keyID, endpointID).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return name, err
}

func putEndpointGap(ctx context.Context, tx *sql.Tx, keyID, endpointID, reason, rule, requestID string, now time.Time) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO endpoint_gaps (id, key_id, endpoint_id, reason, rule, request_id, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key_id, endpoint_id) DO UPDATE SET reason = excluded.reason, rule = excluded.rule,
		request_id = excluded.request_id, created_at = excluded.created_at`,
		ids.New("eg"), keyID, endpointID, reason, rule, requestID, store.Millis(now))
	return err
}

func recordSuccessThrottled(ctx context.Context, tx *sql.Tx, keyID, endpointID string, now time.Time) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO key_endpoint_successes (key_id, endpoint_id, succeeded_at) VALUES (?, ?, ?)
		ON CONFLICT (key_id, endpoint_id) DO UPDATE SET succeeded_at = excluded.succeeded_at WHERE succeeded_at <= ?`,
		keyID, endpointID, store.Millis(now), store.Millis(now.Add(-store.TouchEvery)))
	return err
}

type EndpointGapEvent struct {
	Op        string // GapCreated or GapCleared
	Key       Key
	Endpoint  string // name
	Reason    string
	RequestID string
}

// Call LogEndpointGaps only after the changes committed.
func LogEndpointGaps(log *slog.Logger, events []EndpointGapEvent) {
	for _, e := range events {
		attrs := []any{logs.Kind(KindEndpointGap), logs.Provider(e.Key.Provider), "op", e.Op,
			"upstream_key", e.Key.Name, "upstream_key_id", e.Key.ID, "endpoint", e.Endpoint, "reason", e.Reason}
		if e.RequestID != "" {
			attrs = append(attrs, logs.Request(e.RequestID))
		}
		if e.Op == GapCreated {
			log.Warn("Endpoint Gap created", attrs...)
			continue
		}
		log.Info("Endpoint Gap "+e.Op, attrs...)
	}
}

// ClearEndpointGaps deletes every gap of k, or only the one on endpointID
// when it is not empty. Each gap is passed to track (nil: not tracked)
// before it is deleted. Log the events after commit (LogEndpointGaps).
func ClearEndpointGaps(ctx context.Context, tx *sql.Tx, k Key, endpointID, why string, track func(id string) error) ([]EndpointGapEvent, error) {
	recs := map[string]Record{}
	if err := readEndpointGaps(ctx, tx, `SELECT ?`, k.ID, recs); err != nil {
		return nil, err
	}
	var events []EndpointGapEvent
	for _, g := range recs[k.ID].EndpointGaps {
		if endpointID != "" && g.EndpointID != endpointID {
			continue
		}
		if track != nil {
			if err := track(g.ID); err != nil {
				return nil, err
			}
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM endpoint_gaps WHERE id = ?`, g.ID); err != nil {
			return nil, err
		}
		events = append(events, EndpointGapEvent{Op: GapCleared, Key: k, Endpoint: g.Endpoint, Reason: why})
	}
	return events, nil
}

// Worked writes at most once per store.TouchEvery per key and Endpoint;
// call it only when Record.WorkedOn is older than that or there is a gap on
// ep.
func (s *Store) Worked(ctx context.Context, k Key, ep Endpoint, requestID string) error {
	ctx = context.WithoutCancel(ctx)
	now := s.db.Clock().Now().UTC()
	var events []EndpointGapEvent
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		if err := recordSuccessThrottled(ctx, tx, k.ID, ep.ID, now); err != nil {
			return err
		}
		var err error
		events, err = ClearEndpointGaps(ctx, tx, k, ep.ID, "An Attempt on "+ep.Name+" succeeded.", nil)
		return err
	})
	if err != nil {
		return err
	}
	for i := range events {
		events[i].RequestID = requestID
	}
	LogEndpointGaps(s.log, events)
	return nil
}

func forgetSuccesses(ctx context.Context, tx *sql.Tx, keyID string) error {
	_, err := tx.ExecContext(ctx, `DELETE FROM key_endpoint_successes WHERE key_id = ?`, keyID)
	return err
}

type endpointGapSnapshot struct {
	ID          string    `json:"id"`
	KeyID       string    `json:"key_id"`
	EndpointID  string    `json:"endpoint_id"`
	Provider    string    `json:"provider"`
	UpstreamKey string    `json:"upstream_key"`
	Endpoint    string    `json:"endpoint"`
	Reason      string    `json:"reason"`
	Rule        string    `json:"rule,omitempty"`
	RequestID   string    `json:"request_id,omitempty"`
	CreatedAt   time.Time `json:"created_at"`
}

var EndpointGapResource = audit.Register(&audit.Resource[endpointGapSnapshot]{
	Name: "endpoint_gap", Label: "Endpoint Gap", Plural: "Endpoint Gaps", Path: "/api/providers/{provider}/endpoint-gaps",
	Table: "endpoint_gaps", NameColumn: "id",
	NameOf: func(s endpointGapSnapshot) string { return s.Provider + "/" + s.UpstreamKey + "@" + s.Endpoint },
	Load: func(ctx context.Context, q audit.Querier, id string) (*endpointGapSnapshot, error) {
		var s endpointGapSnapshot
		var created int64
		err := q.QueryRowContext(ctx, `SELECT g.id, g.key_id, g.endpoint_id, p.handle, k.name, e.name, g.reason, g.rule, g.request_id, g.created_at
			FROM endpoint_gaps g JOIN upstream_keys k ON k.id = g.key_id JOIN endpoints e ON e.id = g.endpoint_id
			JOIN providers p ON p.id = k.provider_id WHERE g.id = ?`, id).
			Scan(&s.ID, &s.KeyID, &s.EndpointID, &s.Provider, &s.UpstreamKey, &s.Endpoint, &s.Reason, &s.Rule, &s.RequestID, &created)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		s.CreatedAt = store.FromMillis(created)
		return &s, err
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *endpointGapSnapshot) error {
		if s == nil {
			_, err := tx.ExecContext(ctx, `DELETE FROM endpoint_gaps WHERE id = ?`, id)
			return err
		}
		var x int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM upstream_keys k JOIN endpoints e ON e.provider_id = k.provider_id WHERE k.id = ? AND e.id = ?`,
			s.KeyID, s.EndpointID).Scan(&x)
		if errors.Is(err, sql.ErrNoRows) {
			return api.Conflict("endpoint_gap_target_gone", "Restore the Upstream Key or Endpoint first (revert the entry that deleted it), then retry.",
				"Upstream Key %s/%s or Endpoint %s no longer exists, so the Endpoint Gap cannot come back.", s.Provider, s.UpstreamKey, s.Endpoint)
		}
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM endpoint_gaps WHERE key_id = ? AND endpoint_id = ? AND id != ?`, s.KeyID, s.EndpointID, id); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO endpoint_gaps (id, key_id, endpoint_id, reason, rule, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET reason = excluded.reason, rule = excluded.rule, request_id = excluded.request_id, created_at = excluded.created_at`,
			id, s.KeyID, s.EndpointID, s.Reason, s.Rule, s.RequestID, store.Millis(s.CreatedAt))
		if err != nil {
			return fmt.Errorf("restore endpoint gap %s: %w", id, err)
		}
		return nil
	},
})
