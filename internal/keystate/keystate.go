// Package keystate keeps the Key State of every Upstream Key: active,
// disabled (the Owner's choice, stored with the key), invalid (refused by
// the Provider until a test passes or the secret changes) or cooling until
// a known time, for the whole key or for one key-and-model pair. Every state
// carries the reason it was entered.
//
// The Gateway reports failed and successful Attempts here; candidate
// planning reads the state through providers.Store.Routing; the admin API
// shows it on every Upstream Key. Every change is logged as key.state.
package keystate

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/store"
)

// KindKeyState is logged on every Key State change.
var KindKeyState = logs.NewKind("key.state", "An Upstream Key changed Key State (or cooling for one model): Provider, key, from, to, model, until, reason, rule and Request.")

// The visible Key States.
const (
	Active   = "active"
	Disabled = "disabled"
	Invalid  = "invalid"
	Cooling  = "cooling"
)

// Cooling defaults (spec "Failure handling").
const (
	DefaultCooling   = 60 * time.Second
	MaxDefaultCool   = time.Hour
	EscalationModels = 3               // distinct models refused...
	EscalationWindow = 5 * time.Minute // ...within this window cool the whole key
	// repeatWindow: a cooling that starts within this time after the last
	// one ended counts as a repeat and doubles.
	repeatWindow = time.Hour
)

// State is the one visible Key State of an Upstream Key.
type State struct {
	State     string     `json:"state" enum:"active,disabled,invalid,cooling"`
	Reason    string     `json:"reason" doc:"Why the key is in this state, e.g. \"429 rate_limit_exceeded: Slow down (rule rate-limited)\"."`
	Since     *time.Time `json:"since,omitempty" doc:"When the key entered this state; absent for a key that has been active since it was added."`
	Until     *time.Time `json:"until,omitempty" doc:"cooling only: when the key is tried again."`
	Rule      string     `json:"rule,omitempty" doc:"The Failure Rule that put the key in this state."`
	RequestID string     `json:"request_id,omitempty" doc:"The Request whose Attempt put the key in this state."`
}

// ModelCooling is the cooling of one key for one model.
type ModelCooling struct {
	Model     string    `json:"model" doc:"The model as sent upstream."`
	Until     time.Time `json:"until"`
	Since     time.Time `json:"since"`
	Reason    string    `json:"reason"`
	Rule      string    `json:"rule,omitempty"`
	RequestID string    `json:"request_id,omitempty"`
}

// Record is the stored runtime state of one key (key_states and
// key_model_cooling), whether or not it is current.
type Record struct {
	Key    *row  // nil: active since added
	Models []row // every key-and-model cooling row, current or past
}

type row struct {
	Model     string
	State     string
	Reason    string
	Rule      string
	RequestID string
	Since     time.Time
	Until     time.Time
	Level     int
}

// Querier is what reads need from *sql.Tx or *store.DB.
type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// ForProvider reads the Record of every key of a Provider that has one.
func ForProvider(ctx context.Context, q Querier, providerID string) (map[string]Record, error) {
	return read(ctx, q, `SELECT id FROM upstream_keys WHERE provider_id = ?`, providerID)
}

// ForKey reads the Record of one key.
func ForKey(ctx context.Context, q Querier, keyID string) (Record, error) {
	m, err := read(ctx, q, `SELECT ?`, keyID)
	return m[keyID], err
}

func read(ctx context.Context, q Querier, keysQuery string, arg string) (map[string]Record, error) {
	out := map[string]Record{}
	rows, err := q.QueryContext(ctx, `SELECT key_id, state, reason, rule, request_id, since_at, until_at, level FROM key_states
		WHERE key_id IN (`+keysQuery+`)`, arg)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var r row
		var since int64
		var until sql.NullInt64
		if err := rows.Scan(&id, &r.State, &r.Reason, &r.Rule, &r.RequestID, &since, &until, &r.Level); err != nil {
			rows.Close()
			return nil, err
		}
		r.Since, r.Until = store.FromMillis(since), store.NullMillis(until)
		rec := out[id]
		rec.Key = &r
		out[id] = rec
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, `SELECT key_id, model, reason, rule, request_id, since_at, until_at, level FROM key_model_cooling
		WHERE key_id IN (`+keysQuery+`) ORDER BY until_at`, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var r row
		var since, until int64
		if err := rows.Scan(&id, &r.Model, &r.Reason, &r.Rule, &r.RequestID, &since, &until, &r.Level); err != nil {
			return nil, err
		}
		r.State, r.Since, r.Until = Cooling, store.FromMillis(since), store.FromMillis(until)
		rec := out[id]
		rec.Models = append(rec.Models, r)
		out[id] = rec
	}
	return out, rows.Err()
}

// Invalid reports whether the key is invalid.
func (r Record) Invalid() bool { return r.Key != nil && r.Key.State == Invalid }

// CoolingUntil is when the key's own cooling ends; zero when it is not cooling at now.
func (r Record) CoolingUntil(now time.Time) time.Time {
	if r.Key != nil && r.Key.State == Cooling && r.Key.Until.After(now) {
		return r.Key.Until
	}
	return time.Time{}
}

// ModelsCooling maps each model the key is cooling for at now to when it ends.
func (r Record) ModelsCooling(now time.Time) map[string]time.Time {
	var out map[string]time.Time
	for _, m := range r.Models {
		if m.Until.After(now) {
			if out == nil {
				out = map[string]time.Time{}
			}
			out[m.Model] = m.Until
		}
	}
	return out
}

// Recovering reports whether a successful Attempt on model has state to
// clear: a past key cooling, a repeat level, or a cooling row for model.
func (r Record) Recovering(model string) bool {
	if r.Key != nil && r.Key.State == Cooling {
		return true
	}
	return slices.ContainsFunc(r.Models, func(m row) bool { return m.Model == model })
}

// OwnerDisabled is the Owner's disabled flag of a key with who set it and when.
type OwnerDisabled struct {
	By string
	At time.Time
}

// View is the visible Key State at now, and the models the key is cooling
// for. disabled is nil for an enabled key.
func View(disabled *OwnerDisabled, r Record, now time.Time) (State, []ModelCooling) {
	models := []ModelCooling{}
	for _, m := range r.Models {
		if m.Until.After(now) {
			models = append(models, ModelCooling{Model: m.Model, Until: m.Until, Since: m.Since, Reason: m.Reason, Rule: m.Rule, RequestID: m.RequestID})
		}
	}
	if disabled != nil {
		s := State{State: Disabled, Reason: "Disabled by the Owner."}
		if disabled.By != "" {
			s.Reason = "Disabled by " + disabled.By + "."
		}
		if !disabled.At.IsZero() {
			s.Since = ptr(disabled.At)
		}
		return s, models
	}
	k := r.Key
	switch {
	case k == nil:
		return State{State: Active, Reason: "Added; no Attempt has failed since."}, models
	case k.State == Invalid:
		return State{State: Invalid, Reason: k.Reason, Since: ptr(k.Since), Rule: k.Rule, RequestID: k.RequestID}, models
	case k.State == Cooling && k.Until.After(now):
		return State{State: Cooling, Reason: k.Reason, Since: ptr(k.Since), Until: ptr(k.Until), Rule: k.Rule, RequestID: k.RequestID}, models
	case k.State == Cooling:
		return State{State: Active, Reason: "Cooling ended at " + k.Until.UTC().Format(time.RFC3339) + " (it began: " + k.Reason + ").", Since: ptr(k.Until)}, models
	}
	return State{State: Active, Reason: k.Reason, Since: ptr(k.Since)}, models
}

func ptr(t time.Time) *time.Time { t = t.UTC(); return &t }

// Store writes Key States.
type Store struct {
	db  *store.DB
	log *slog.Logger
}

// New returns a Store.
func New(db *store.DB, log *slog.Logger) *Store { return &Store{db: db, log: log} }

// Key names the key a change is about, for log events.
type Key struct {
	ID       string
	Name     string
	Provider string // handle
}

// Failure is a failed Attempt the rules decided changes the key.
type Failure struct {
	Key       Key
	Model     string // wire model of the Attempt
	RequestID string
	Decision  rules.Decision
}

// Effect is what Fail did, for the Attempt's record.
type Effect struct {
	State     string    // invalid or cooling; "" when nothing changed
	Model     string    // set when only this model cools
	Until     time.Time // cooling end
	Escalated bool      // a model cooling escalated to the whole key
	Action    string    // one line for the Attempt's record
}

// Fail applies a decision with outcome invalid, cooling_key or
// cooling_key_model. Other outcomes change nothing.
func (s *Store) Fail(ctx context.Context, f Failure) (Effect, error) {
	ctx = context.WithoutCancel(ctx)
	now := s.db.Clock().Now().UTC()
	d := f.Decision
	reason := d.Reason
	if d.Rule != "" {
		reason += " (rule " + d.Rule + ")"
	}
	var eff Effect
	var events []event
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		events = nil
		cur, err := ForKey(ctx, tx, f.Key.ID)
		if err != nil {
			return err
		}
		switch d.Outcome {
		case rules.Invalid:
			if cur.Invalid() {
				eff = Effect{Action: "Upstream Key " + f.Key.Name + " stays invalid."}
				return nil
			}
			if err := putKey(ctx, tx, f.Key.ID, row{State: Invalid, Reason: reason, Rule: d.Rule, RequestID: f.RequestID, Since: now}); err != nil {
				return err
			}
			eff = Effect{State: Invalid, Action: "Upstream Key " + f.Key.Name + " is now invalid until a test passes or its secret changes."}
			events = append(events, event{from: visible(cur, now), to: Invalid, reason: reason, rule: d.Rule})
		case rules.CoolingKey:
			if cur.Invalid() {
				eff = Effect{Action: "Upstream Key " + f.Key.Name + " stays invalid."}
				return nil
			}
			until, ev, err := coolKey(ctx, tx, f.Key.ID, cur.Key, d, reason, f.RequestID, now)
			if err != nil {
				return err
			}
			events = append(events, ev)
			eff = Effect{State: Cooling, Until: until, Action: fmt.Sprintf("Upstream Key %s cooling until %s.", f.Key.Name, until.Format(time.RFC3339))}
		case rules.CoolingKeyModel:
			if cur.Invalid() {
				eff = Effect{Action: "Upstream Key " + f.Key.Name + " stays invalid."}
				return nil
			}
			var prev *row
			for i := range cur.Models {
				if cur.Models[i].Model == f.Model {
					prev = &cur.Models[i]
				}
			}
			until, level := coolingEnd(prev, d, now)
			if _, err := tx.ExecContext(ctx, `INSERT INTO key_model_cooling (key_id, model, reason, rule, request_id, since_at, until_at, level)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key_id, model) DO UPDATE SET reason = excluded.reason, rule = excluded.rule,
				request_id = excluded.request_id, since_at = excluded.since_at, until_at = excluded.until_at, level = excluded.level`,
				f.Key.ID, f.Model, reason, d.Rule, f.RequestID, store.Millis(now), store.Millis(until), level); err != nil {
				return err
			}
			eff = Effect{State: Cooling, Model: f.Model, Until: until,
				Action: fmt.Sprintf("Upstream Key %s cooling for %s until %s.", f.Key.Name, f.Model, until.Format(time.RFC3339))}
			events = append(events, event{from: Active, to: Cooling, model: f.Model, until: until, reason: reason, rule: d.Rule})

			// Escalation: distinct models refused within the window.
			rows, err := tx.QueryContext(ctx, `SELECT model FROM key_model_cooling WHERE key_id = ? AND since_at > ? ORDER BY since_at, model`,
				f.Key.ID, store.Millis(now.Add(-EscalationWindow)))
			if err != nil {
				return err
			}
			var models []string
			for rows.Next() {
				var m string
				if err := rows.Scan(&m); err != nil {
					rows.Close()
					return err
				}
				models = append(models, m)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return err
			}
			if len(models) >= EscalationModels && cur.CoolingUntil(now).IsZero() {
				why := fmt.Sprintf("Refused for %d models within %s (%s); last: %s", len(models), EscalationWindow, strings.Join(models, ", "), reason)
				kd := rules.Decision{Rule: d.Rule, Outcome: rules.CoolingKey}
				if until.After(now.Add(DefaultCooling)) {
					kd.ResetAt = until
				}
				kuntil, ev, err := coolKey(ctx, tx, f.Key.ID, cur.Key, kd, why, f.RequestID, now)
				if err != nil {
					return err
				}
				events = append(events, ev)
				eff.Escalated, eff.Until, eff.Model = true, kuntil, ""
				eff.Action += fmt.Sprintf(" Refused for %d models within %s, so the whole key cools until %s.", len(models), EscalationWindow, kuntil.Format(time.RFC3339))
			}
		}
		return nil
	})
	if err != nil {
		return Effect{}, err
	}
	for _, e := range events {
		s.logEvent(f.Key, f.RequestID, e)
	}
	return eff, nil
}

type event struct {
	from, to, model, reason, rule string
	until                         time.Time
}

func (s *Store) logEvent(k Key, requestID string, e event) {
	attrs := []any{logs.Kind(KindKeyState), logs.Provider(k.Provider), "upstream_key", k.Name, "upstream_key_id", k.ID,
		"from", e.from, "to", e.to, "reason", e.reason}
	if requestID != "" {
		attrs = append(attrs, logs.Request(requestID))
	}
	if e.model != "" {
		attrs = append(attrs, "model", e.model)
	}
	if !e.until.IsZero() {
		attrs = append(attrs, "until", e.until.UTC().Format(time.RFC3339))
	}
	if e.rule != "" {
		attrs = append(attrs, "rule", e.rule)
	}
	msg := "Upstream Key " + e.to
	if e.model != "" {
		msg = "Upstream Key " + e.to + " for one model"
	}
	s.log.Info(msg, attrs...)
}

// visible is the state name a Record shows at now (ignoring disabled).
func visible(r Record, now time.Time) string {
	st, _ := View(nil, r, now)
	return st.State
}

// coolingEnd is when a new cooling ends and its repeat level, given the
// previous cooling of the same scope (nil when none).
func coolingEnd(prev *row, d rules.Decision, now time.Time) (time.Time, int) {
	level := 0
	if prev != nil && prev.State == Cooling {
		switch {
		case prev.Until.After(now): // already cooling (concurrent Attempts): not a repeat
			level = prev.Level
		case now.Sub(prev.Until) < repeatWindow:
			level = prev.Level + 1
		}
	}
	var until time.Time
	switch {
	case !d.ResetAt.IsZero():
		until = d.ResetAt
		if !until.After(now) {
			until = now.Add(time.Second)
		}
	case d.Cooling > 0:
		until = now.Add(d.Cooling)
	default:
		dur := DefaultCooling
		for range level {
			dur *= 2
			if dur >= MaxDefaultCool {
				dur = MaxDefaultCool
				break
			}
		}
		until = now.Add(dur)
	}
	// A cooling never shortens one already running (FAIL-61).
	if prev != nil && prev.State == Cooling && prev.Until.After(until) {
		until = prev.Until
	}
	return until.UTC(), level
}

func coolKey(ctx context.Context, tx *sql.Tx, keyID string, prev *row, d rules.Decision, reason, requestID string, now time.Time) (time.Time, event, error) {
	until, level := coolingEnd(prev, d, now)
	from := Active
	if prev != nil && prev.State == Cooling && prev.Until.After(now) {
		from = Cooling
	}
	err := putKey(ctx, tx, keyID, row{State: Cooling, Reason: reason, Rule: d.Rule, RequestID: requestID, Since: now, Until: until, Level: level})
	return until, event{from: from, to: Cooling, until: until, reason: reason, rule: d.Rule}, err
}

func putKey(ctx context.Context, tx *sql.Tx, keyID string, r row) error {
	var until any
	if !r.Until.IsZero() {
		until = store.Millis(r.Until)
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO key_states (key_id, state, reason, rule, request_id, since_at, until_at, level)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key_id) DO UPDATE SET state = excluded.state, reason = excluded.reason,
		rule = excluded.rule, request_id = excluded.request_id, since_at = excluded.since_at, until_at = excluded.until_at, level = excluded.level`,
		keyID, r.State, r.Reason, r.Rule, r.RequestID, store.Millis(r.Since), until, r.Level)
	return err
}

// Succeeded records that an Attempt with the key on model succeeded: the
// cooling of that model and a past key cooling are cleared. Call it only
// when Record.Recovering(model) said there is something to clear.
func (s *Store) Succeeded(ctx context.Context, k Key, model, requestID string) error {
	ctx = context.WithoutCancel(ctx)
	now := s.db.Clock().Now().UTC()
	var events []event
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		events = nil
		cur, err := ForKey(ctx, tx, k.ID)
		if err != nil {
			return err
		}
		res, err := tx.ExecContext(ctx, `DELETE FROM key_model_cooling WHERE key_id = ? AND model = ?`, k.ID, model)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			events = append(events, event{from: Cooling, to: Active, model: model, reason: "An Attempt on this model succeeded."})
		}
		if cur.Key != nil && cur.Key.State == Cooling {
			if err := putKey(ctx, tx, k.ID, row{State: Active, Reason: "Served an Attempt after cooling.", RequestID: requestID, Since: now}); err != nil {
				return err
			}
			events = append(events, event{from: visible(cur, now), to: Active, reason: "Served an Attempt after cooling."})
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, e := range events {
		if e.from != e.to || e.model != "" {
			s.logEvent(k, requestID, e)
		}
	}
	return nil
}

// TestPassed makes the key active after a passing key test: invalid and
// cooling end, and the tested model's cooling is cleared.
func (s *Store) TestPassed(ctx context.Context, k Key, model string) error {
	ctx = context.WithoutCancel(ctx)
	now := s.db.Clock().Now().UTC()
	var from string
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		cur, err := ForKey(ctx, tx, k.ID)
		if err != nil {
			return err
		}
		from = visible(cur, now)
		if _, err := tx.ExecContext(ctx, `DELETE FROM key_model_cooling WHERE key_id = ? AND model = ?`, k.ID, model); err != nil {
			return err
		}
		return putKey(ctx, tx, k.ID, row{State: Active, Reason: "A key test passed (" + model + ").", Since: now})
	})
	if err == nil && from != Active {
		s.logEvent(k, "", event{from: from, to: Active, reason: "A key test passed (" + model + ")."})
	}
	return err
}

// Reset clears every runtime state of a key inside tx: its secret changed,
// so it is a new credential. The caller logs the change after commit
// (LogChange).
func Reset(ctx context.Context, tx *sql.Tx, keyID string, now time.Time) error {
	cur, err := ForKey(ctx, tx, keyID)
	if err != nil {
		return err
	}
	if cur.Key == nil && len(cur.Models) == 0 {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM key_model_cooling WHERE key_id = ?`, keyID); err != nil {
		return err
	}
	return putKey(ctx, tx, keyID, row{State: Active, Reason: "The secret was replaced.", Since: now})
}

// LogChange logs a Key State change made outside this package (the Owner
// disabling or enabling a key, a secret change), after it committed.
func LogChange(log *slog.Logger, k Key, from, to, reason string) {
	(&Store{log: log}).logEvent(k, "", event{from: from, to: to, reason: reason})
}
