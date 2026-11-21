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

const (
	Active   = "active"
	Disabled = "disabled"
	Invalid  = "invalid"
	Cooling  = "cooling"
)

const (
	DefaultCooling         = 60 * time.Second
	MaxDefaultCool         = time.Hour
	ModelsRefusedToCoolKey = 3
	EscalationWindow       = 5 * time.Minute
	repeatWindow           = time.Hour
)

type State struct {
	State     string     `json:"state" enum:"active,disabled,invalid,cooling"`
	Reason    string     `json:"reason" doc:"Why the key is in this state, e.g. \"429 rate_limit_exceeded: Slow down (rule rate-limited)\"."`
	Since     *time.Time `json:"since,omitempty" doc:"When the key entered this state; absent for a key that has been active since it was added."`
	Until     *time.Time `json:"until,omitempty" doc:"cooling only: when the key is tried again."`
	Rule      string     `json:"rule,omitempty" doc:"The Failure Rule that put the key in this state."`
	RequestID string     `json:"request_id,omitempty" doc:"The Request whose Attempt put the key in this state."`
}

type ModelCooling struct {
	Model     string    `json:"model" doc:"The model as sent upstream."`
	Until     time.Time `json:"until"`
	Since     time.Time `json:"since"`
	Reason    string    `json:"reason"`
	Rule      string    `json:"rule,omitempty"`
	RequestID string    `json:"request_id,omitempty"`
}

type Record struct {
	Key    *row
	Models []row      // every key-and-model cooling row, current or past
	Gaps   []ModelGap // every stored Model Gap, live or expired, soonest expiry first
	// EndpointGaps and Worked are in Endpoint order.
	EndpointGaps []EndpointGap
	Worked       []EndpointSuccess
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

type Querier interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

func ForProvider(ctx context.Context, q Querier, providerID string) (map[string]Record, error) {
	return read(ctx, q, `SELECT id FROM upstream_keys WHERE provider_id = ?`, providerID)
}

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
	if err := rows.Err(); err != nil {
		return nil, err
	}
	rows.Close()
	if err := readGaps(ctx, q, keysQuery, arg, out); err != nil {
		return nil, err
	}
	return out, readEndpointGaps(ctx, q, keysQuery, arg, out)
}

func (r Record) Invalid() bool { return r.Key != nil && r.Key.State == Invalid }

// CoolingUntil is when the key's own cooling ends; zero when it is not cooling at now.
func (r Record) CoolingUntil(now time.Time) time.Time {
	if r.Key != nil && r.Key.State == Cooling && r.Key.Until.After(now) {
		return r.Key.Until
	}
	return time.Time{}
}

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

// Recovering reports whether Succeeded on model has state to clear.
func (r Record) Recovering(model string) bool {
	if r.Key != nil && r.Key.State == Cooling {
		return true
	}
	return slices.ContainsFunc(r.Models, func(m row) bool { return m.Model == model })
}

type OwnerDisabled struct {
	By string
	At time.Time
}

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

type Store struct {
	db  *store.DB
	log *slog.Logger
}

func New(db *store.DB, log *slog.Logger) *Store { return &Store{db: db, log: log} }

type Key struct {
	ID       string
	Name     string
	Provider string // handle
}

type Failure struct {
	Key       Key
	Endpoint  Endpoint // empty: an invalid outcome never becomes an Endpoint Gap
	Model     string   // wire model of the Attempt
	RequestID string
	Decision  rules.Decision
}

type Effect struct {
	State     string // invalid or cooling; "" when nothing changed
	Model     string
	Until     time.Time
	Escalated bool
	GapUntil  time.Time
	// EndpointGap names the Endpoint an invalid outcome became an Endpoint
	// Gap on instead of changing the Key State.
	EndpointGap string
	Action      string
}

// Fail applies a decision with outcome invalid, cooling_key,
// cooling_key_model or model_gap (which leaves the Key State alone). Other
// outcomes change nothing. An invalid outcome on an Endpoint, for a key that
// has worked on another Endpoint it may still use, records an Endpoint Gap
// instead.
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
	var gaps []GapEvent
	var egaps []EndpointGapEvent
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		events, gaps, egaps = nil, nil, nil
		cur, err := ForKey(ctx, tx, f.Key.ID)
		if err != nil {
			return err
		}
		switch d.Outcome {
		case rules.ModelGap:
			until, err := putGap(ctx, tx, f.Key.ID, f.Model, reason, d.Rule, f.RequestID, now)
			if err != nil {
				return err
			}
			eff = Effect{Model: f.Model, GapUntil: until,
				Action: fmt.Sprintf("Upstream Key %s has a Model Gap for %s until %s; its Key State is unchanged and it keeps serving other models.", f.Key.Name, f.Model, until.Format(time.RFC3339))}
			gaps = append(gaps, GapEvent{Op: GapCreated, Key: f.Key, Model: f.Model, Reason: reason, Until: until, RequestID: f.RequestID})
		case rules.Invalid:
			if cur.Invalid() {
				eff = Effect{Action: "Upstream Key " + f.Key.Name + " stays invalid."}
				return nil
			}
			if f.Endpoint.ID != "" {
				worked, err := workedElsewhere(ctx, tx, f.Key.ID, f.Endpoint.ID)
				if err != nil {
					return err
				}
				if worked != "" {
					why := reason + "; it works on " + worked
					if err := putEndpointGap(ctx, tx, f.Key.ID, f.Endpoint.ID, why, d.Rule, f.RequestID, now); err != nil {
						return err
					}
					eff = Effect{EndpointGap: f.Endpoint.Name,
						Action: fmt.Sprintf("Upstream Key %s has an Endpoint Gap on %s: refused there but it works on %s, so it is not invalid; it is not sent to %s until the gap is cleared and keeps serving its other Endpoints.",
							f.Key.Name, f.Endpoint.Name, worked, f.Endpoint.Name)}
					egaps = append(egaps, EndpointGapEvent{Op: GapCreated, Key: f.Key, Endpoint: f.Endpoint.Name, Reason: why, RequestID: f.RequestID})
					return nil
				}
			}
			if err := putKey(ctx, tx, f.Key.ID, row{State: Invalid, Reason: reason, Rule: d.Rule, RequestID: f.RequestID, Since: now}); err != nil {
				return err
			}
			cleared, err := ClearEndpointGaps(ctx, tx, f.Key, "", "The key became invalid (refused on every Endpoint it had worked on).", nil)
			if err != nil {
				return err
			}
			for i := range cleared {
				cleared[i].RequestID = f.RequestID
			}
			egaps = append(egaps, cleared...)
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
			esc, err := escalateToKey(ctx, tx, f, cur, reason, until, now)
			if err != nil || esc == nil {
				return err
			}
			events = append(events, esc.event)
			eff.Escalated, eff.Until, eff.Model = true, esc.until, ""
			eff.Action += fmt.Sprintf(" Refused for %d models within %s, so the whole key cools until %s.", len(esc.models), EscalationWindow, esc.until.Format(time.RFC3339))
		}
		return nil
	})
	if err != nil {
		return Effect{}, err
	}
	for _, e := range events {
		s.logEvent(f.Key, f.RequestID, e)
	}
	LogGaps(s.log, gaps)
	LogEndpointGaps(s.log, egaps)
	return eff, nil
}

type keyEscalation struct {
	until  time.Time
	event  event
	models []string
}

func escalateToKey(ctx context.Context, tx *sql.Tx, f Failure, cur Record, reason string, modelUntil, now time.Time) (*keyEscalation, error) {
	if !cur.CoolingUntil(now).IsZero() {
		return nil, nil
	}
	models, err := modelsCooledSince(ctx, tx, f.Key.ID, now.Add(-EscalationWindow))
	if err != nil || len(models) < ModelsRefusedToCoolKey {
		return nil, err
	}
	why := fmt.Sprintf("Refused for %d models within %s (%s); last: %s", len(models), EscalationWindow, strings.Join(models, ", "), reason)
	kd := rules.Decision{Rule: f.Decision.Rule, Outcome: rules.CoolingKey}
	if modelUntil.After(now.Add(DefaultCooling)) {
		kd.ResetAt = modelUntil
	}
	until, ev, err := coolKey(ctx, tx, f.Key.ID, cur.Key, kd, why, f.RequestID, now)
	if err != nil {
		return nil, err
	}
	return &keyEscalation{until: until, event: ev, models: models}, nil
}

func modelsCooledSince(ctx context.Context, tx *sql.Tx, keyID string, since time.Time) ([]string, error) {
	rows, err := tx.QueryContext(ctx, `SELECT model FROM key_model_cooling WHERE key_id = ? AND since_at > ? ORDER BY since_at, model`,
		keyID, store.Millis(since))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var models []string
	for rows.Next() {
		var m string
		if err := rows.Scan(&m); err != nil {
			return nil, err
		}
		models = append(models, m)
	}
	return models, rows.Err()
}

type event struct {
	from, to, model, reason, rule string
	until                         time.Time
}

func (s *Store) logEvent(k Key, requestID string, e event) {
	attrs := []any{logs.Kind(logs.KindKeyState), logs.Provider(k.Provider), "upstream_key", k.Name, "upstream_key_id", k.ID,
		"from", e.from, "state", e.to, "reason", e.reason}
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
	if e.to == Invalid || e.to == Cooling {
		s.log.Warn(msg, attrs...)
		return
	}
	s.log.Info(msg, attrs...)
}

func visible(r Record, now time.Time) string {
	st, _ := View(nil, r, now)
	return st.State
}

// FirstCooling ignores repeats: Fail doubles the default for a key that
// cooled within the last hour.
func FirstCooling(d rules.Decision, now time.Time) time.Time {
	until, _ := coolingEnd(nil, d, now)
	return until
}

func coolingEnd(prev *row, d rules.Decision, now time.Time) (time.Time, int) {
	level := 0
	switch {
	case prev.stillCooling(now):
		level = prev.Level
	case prev.cooledWithin(repeatWindow, now):
		level = prev.Level + 1
	}
	var until time.Time
	switch {
	case !d.ResetAt.IsZero() && d.ResetAt.After(now):
		until = d.ResetAt
	case d.Cooling > 0:
		until = now.Add(d.Cooling)
	default:
		until = now.Add(escalatingDefault(level))
	}
	if prev.stillCooling(now) && prev.Until.After(until) {
		until = prev.Until
	}
	return until.UTC(), level
}

func (r *row) stillCooling(now time.Time) bool {
	return r != nil && r.State == Cooling && r.Until.After(now)
}

func (r *row) cooledWithin(window time.Duration, now time.Time) bool {
	return r != nil && r.State == Cooling && !r.Until.After(now) && now.Sub(r.Until) < window
}

func escalatingDefault(level int) time.Duration {
	dur := DefaultCooling
	for range level {
		dur *= 2
		if dur >= MaxDefaultCool {
			return MaxDefaultCool
		}
	}
	return dur
}

func coolKey(ctx context.Context, tx *sql.Tx, keyID string, prev *row, d rules.Decision, reason, requestID string, now time.Time) (time.Time, event, error) {
	until, level := coolingEnd(prev, d, now)
	from := Active
	if prev.stillCooling(now) {
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

// Call Succeeded only when Record.Recovering(model) is true.
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

// TestPassed makes the key active, clears the tested model's cooling, every
// Model Gap of the key and its Endpoint Gap on ep, and records that it has
// worked on ep.
func (s *Store) TestPassed(ctx context.Context, k Key, ep Endpoint, model string) error {
	ctx = context.WithoutCancel(ctx)
	now := s.db.Clock().Now().UTC()
	var from string
	var gaps []GapEvent
	var egaps []EndpointGapEvent
	err := s.db.Tx(ctx, func(tx *sql.Tx) error {
		cur, err := ForKey(ctx, tx, k.ID)
		if err != nil {
			return err
		}
		from = visible(cur, now)
		if _, err := tx.ExecContext(ctx, `DELETE FROM key_model_cooling WHERE key_id = ? AND model = ?`, k.ID, model); err != nil {
			return err
		}
		if gaps, err = ClearGaps(ctx, tx, k, "", "A key test passed ("+model+").", now, nil); err != nil {
			return err
		}
		if ep.ID != "" {
			if _, err := tx.ExecContext(ctx, `INSERT INTO key_endpoint_successes (key_id, endpoint_id, succeeded_at) VALUES (?, ?, ?)
				ON CONFLICT (key_id, endpoint_id) DO UPDATE SET succeeded_at = excluded.succeeded_at`, k.ID, ep.ID, store.Millis(now)); err != nil {
				return err
			}
			if egaps, err = ClearEndpointGaps(ctx, tx, k, ep.ID, "A key test passed on "+ep.Name+".", nil); err != nil {
				return err
			}
		}
		return putKey(ctx, tx, k.ID, row{State: Active, Reason: "A key test passed (" + model + ").", Since: now})
	})
	if err == nil && from != Active {
		s.logEvent(k, "", event{from: from, to: Active, reason: "A key test passed (" + model + ")."})
	}
	if err == nil {
		LogGaps(s.log, gaps)
		LogEndpointGaps(s.log, egaps)
	}
	return err
}

// Reset leaves the key's gaps and logging to the caller: clear the gaps
// tracked, and call LogChange after commit.
func Reset(ctx context.Context, tx *sql.Tx, keyID string, now time.Time) error {
	if err := forgetSuccesses(ctx, tx, keyID); err != nil {
		return err
	}
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

// Call LogChange only after the change committed.
func LogChange(log *slog.Logger, k Key, from, to, reason string) {
	(&Store{log: log}).logEvent(k, "", event{from: from, to: to, reason: reason})
}
