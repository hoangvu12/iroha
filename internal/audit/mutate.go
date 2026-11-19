package audit

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/store"
)

// KindChange is logged after every committed Audit Entry.
var KindChange = logs.NewKind("config.change", "Iroha's configuration changed: Audit Entry ID, action, actor and summary (never before/after values).")

// DryRun documents the dry_run query parameter. Put it in the Query of
// every mutating route; Mutate, Bulk and revert read it.
var DryRun = api.Param{
	Name: "dry_run", Type: "boolean",
	Description: "true: run the change, report exactly what would change, and write nothing.",
}

// MaxBulkItems caps one bulk call.
const MaxBulkItems = 1000

// Trail writes and reads Audit Entries and runs audited mutations.
type Trail struct {
	db    *store.DB
	clock clock.Clock
	log   *slog.Logger
}

// New returns a Trail.
func New(db *store.DB, log *slog.Logger) *Trail {
	return &Trail{db: db, clock: db.Clock(), log: log}
}

// Change is one record an Audit Entry (or a dry run) changed.
type Change struct {
	Resource string          `json:"resource" doc:"Resource name, e.g. admin_token."`
	ID       string          `json:"id"`
	Name     string          `json:"name"`
	Op       string          `json:"op" enum:"create,update,delete"`
	Fields   []string        `json:"fields,omitempty" doc:"Top-level fields an update changed."`
	Before   json.RawMessage `json:"before" doc:"The record before the change; null when it was created. Secrets are masked."`
	After    json.RawMessage `json:"after" doc:"The record after the change; null when it was deleted. Secrets are masked."`
}

// Outcomes of one mutation or bulk item, from its primary record.
const (
	OutcomeCreated   = "created"
	OutcomeUpdated   = "updated"
	OutcomeDeleted   = "deleted"
	OutcomeUnchanged = "unchanged"
)

// Result is the audit part of every mutation response. Resource responses
// embed it next to the record.
type Result struct {
	DryRun     bool     `json:"dry_run" doc:"true when nothing was written."`
	Outcome    string   `json:"outcome" enum:"created,updated,deleted,unchanged" doc:"What happened to the record addressed (or would have, on a dry run)."`
	AuditEntry string   `json:"audit_entry,omitempty" doc:"ID of the Audit Entry written; absent on a dry run or when nothing changed."`
	Changes    []Change `json:"changes" doc:"Every record changed, with before and after."`
}

// Mutation is one audited change in progress. Handlers make their writes
// on Tx and call Track before touching each record.
type Mutation struct {
	Ctx    context.Context
	Tx     *sql.Tx
	DryRun bool
	Actor  api.Actor
	Now    time.Time

	trail        *Trail
	tracked      []*tracked // current item
	irreversible string
	summary      string
	action, verb string
}

type tracked struct {
	r          Tracker
	id         string
	before     json.RawMessage
	beforeName string
}

// Track records the current state of record id of r as its before-state.
// Call it before writing the record, including before inserting a new one
// (its before is then "absent"). Track every record the change touches,
// children included (a deleted Provider's keys), parents before children.
// Tracking a record twice is harmless.
func (m *Mutation) Track(r Tracker, id string) error {
	for _, t := range m.tracked {
		if t.r.resourceName() == r.resourceName() && t.id == id {
			return nil
		}
	}
	before, name, err := r.load(m.Ctx, m.Tx, id)
	if err != nil {
		return err
	}
	m.tracked = append(m.tracked, &tracked{r: r, id: id, before: before, beforeName: name})
	return nil
}

// Irreversible marks the change as impossible to revert and says why (for
// example "Revoked Admin Tokens never work again; create a new one.").
func (m *Mutation) Irreversible(reason string) { m.irreversible = reason }

// Summarize replaces the generated one-line summary of the Audit Entry.
func (m *Mutation) Summarize(s string) { m.summary = s }

// stored is a change as stored: whole snapshots, unmasked.
type stored struct {
	r             Tracker
	id, name      string
	before, after json.RawMessage
}

// collect loads every tracked record's after-state and returns the records
// that changed, in tracking order.
func (m *Mutation) collect() ([]stored, string, error) {
	var out []stored
	outcome := OutcomeUnchanged
	for i, t := range m.tracked {
		after, name, err := t.r.load(m.Ctx, m.Tx, t.id)
		if err != nil {
			return nil, "", err
		}
		if name == "" {
			name = t.beforeName
		}
		if i == 0 {
			outcome = outcomeOf(t.before, after)
		}
		if t.before == nil && after == nil || bytes.Equal(t.before, after) {
			continue
		}
		out = append(out, stored{r: t.r, id: t.id, name: name, before: t.before, after: after})
	}
	return out, outcome, nil
}

func outcomeOf(before, after json.RawMessage) string {
	switch {
	case before == nil && after != nil:
		return OutcomeCreated
	case before != nil && after == nil:
		return OutcomeDeleted
	case bytes.Equal(before, after):
		return OutcomeUnchanged
	default:
		return OutcomeUpdated
	}
}

// IsDryRun reads ?dry_run= of the call.
func IsDryRun(c *api.Call) (bool, error) {
	s := c.Query("dry_run")
	if s == "" {
		return false, nil
	}
	v, err := strconv.ParseBool(s)
	if err != nil {
		return false, api.BadRequest("Use dry_run=true or dry_run=false.", "dry_run must be true or false, not %q.", s)
	}
	return v, nil
}

// errDryRun rolls back a dry run's transaction.
var errDryRun = errors.New("dry run")

// Mutate runs fn as one audited change in one transaction. action is the
// machine name of the change ("admin_token.revoke") and verb its past tense
// for the generated summary ("Revoked"). On a dry run fn runs fully and is
// rolled back. When something changed, one Audit Entry is written. The
// success status becomes 201 when the primary (first tracked) record was
// created.
func (tr *Trail) Mutate(c *api.Call, action, verb string, fn func(m *Mutation) error) (Result, error) {
	dry, err := IsDryRun(c)
	if err != nil {
		return Result{}, err
	}
	var res Result
	var entry *committed
	err = tr.db.Tx(c.R.Context(), func(tx *sql.Tx) error {
		m := tr.begin(c, tx, dry, action, verb)
		if err := fn(m); err != nil {
			return err
		}
		changes, outcome, err := m.collect()
		if err != nil {
			return err
		}
		res = Result{DryRun: dry, Outcome: outcome, Changes: views(changes)}
		if dry {
			return errDryRun
		}
		entry, err = m.write(changes, "")
		if entry != nil {
			res.AuditEntry = entry.id
		}
		return err
	})
	if errors.Is(err, errDryRun) {
		err = nil
	}
	if err != nil {
		return Result{}, err
	}
	tr.logCommitted(entry)
	if res.Outcome == OutcomeCreated && !dry {
		c.SetStatus(http.StatusCreated)
	}
	return res, nil
}

// BulkRequest is the body of every bulk route.
type BulkRequest[T any] struct {
	Items []T `json:"items" doc:"The items; each succeeds or fails on its own."`
}

// BulkItem is the result of one item of a bulk call.
type BulkItem[T any] struct {
	Index   int        `json:"index" doc:"Position of the item in the request, from 0."`
	OK      bool       `json:"ok"`
	Outcome string     `json:"outcome,omitempty" enum:"created,updated,deleted,unchanged"`
	Result  *T         `json:"result,omitempty" doc:"The item's result when ok."`
	Error   *api.Error `json:"error,omitempty" doc:"Why the item failed when not ok; nothing of it was applied."`
	Changes []Change   `json:"changes"`
}

// BulkResult is the response of every bulk route.
type BulkResult[T any] struct {
	DryRun     bool          `json:"dry_run" doc:"true when nothing was written."`
	AuditEntry string        `json:"audit_entry,omitempty" doc:"ID of the one Audit Entry covering every applied item; absent on a dry run or when nothing changed."`
	Succeeded  int           `json:"succeeded"`
	Failed     int           `json:"failed"`
	Items      []BulkItem[T] `json:"items"`
}

// Bulk runs fn for each item in one transaction, each item inside its own
// savepoint: an item that returns an *api.Error is rolled back and reported,
// and the rest still apply. Any other error aborts the whole call. One Audit
// Entry covers every applied item. The response is 200 even when items fail;
// read "failed".
func Bulk[In, Out any](tr *Trail, c *api.Call, action, verb string, items []In, fn func(m *Mutation, in In) (Out, error)) (BulkResult[Out], error) {
	dry, err := IsDryRun(c)
	if err != nil {
		return BulkResult[Out]{}, err
	}
	if len(items) == 0 {
		return BulkResult[Out]{}, api.BadRequest(`Send {"items": [...]} with at least one item.`, "The bulk call has no items.")
	}
	if len(items) > MaxBulkItems {
		return BulkResult[Out]{}, api.BadRequest(fmt.Sprintf("Split the work into calls of at most %d items.", MaxBulkItems), "The bulk call has %d items.", len(items))
	}
	ctx := c.R.Context()
	res := BulkResult[Out]{DryRun: dry, Items: make([]BulkItem[Out], 0, len(items))}
	var entry *committed
	err = tr.db.Tx(ctx, func(tx *sql.Tx) error {
		m := tr.begin(c, tx, dry, action, verb)
		var all []stored
		for i, in := range items {
			if _, err := tx.ExecContext(ctx, `SAVEPOINT bulk_item`); err != nil {
				return err
			}
			m.tracked = nil
			irreversible := m.irreversible
			out, err := fn(m, in)
			var changes []stored
			outcome := ""
			if err == nil {
				changes, outcome, err = m.collect()
			}
			item := BulkItem[Out]{Index: i, Changes: []Change{}}
			if err != nil {
				var apiErr *api.Error
				if !errors.As(err, &apiErr) || api.AsError(err).Status >= 500 {
					return err
				}
				if _, err := tx.ExecContext(ctx, `ROLLBACK TO bulk_item`); err != nil {
					return err
				}
				item.Error = api.AsError(err)
				m.irreversible = irreversible
				res.Failed++
			} else {
				item.OK, item.Outcome, item.Result, item.Changes = true, outcome, &out, views(changes)
				all = append(all, changes...)
				res.Succeeded++
			}
			if _, err := tx.ExecContext(ctx, `RELEASE bulk_item`); err != nil {
				return err
			}
			res.Items = append(res.Items, item)
		}
		if dry {
			return errDryRun
		}
		var err error
		entry, err = m.write(merge(all), "")
		if entry != nil {
			res.AuditEntry = entry.id
		}
		return err
	})
	if errors.Is(err, errDryRun) {
		err = nil
	}
	if err != nil {
		return BulkResult[Out]{}, err
	}
	tr.logCommitted(entry)
	return res, nil
}

// merge folds several changes of one record (two bulk items touching it)
// into one, keeping the first before and the last after.
func merge(in []stored) []stored {
	var out []stored
	at := map[string]int{}
	for _, s := range in {
		key := s.r.resourceName() + "\x00" + s.id
		if i, ok := at[key]; ok {
			out[i].after, out[i].name = s.after, s.name
			continue
		}
		at[key] = len(out)
		out = append(out, s)
	}
	return slices.DeleteFunc(out, func(s stored) bool { return bytes.Equal(s.before, s.after) })
}

func (tr *Trail) begin(c *api.Call, tx *sql.Tx, dry bool, action, verb string) *Mutation {
	return &Mutation{Ctx: c.R.Context(), Tx: tx, DryRun: dry, Actor: c.Actor, Now: tr.clock.Now().UTC(),
		trail: tr, action: action, verb: verb}
}

type committed struct {
	id, action, summary string
	actor               api.Actor
}

// write stores one Audit Entry for changes (nothing when there are none).
func (m *Mutation) write(changes []stored, revertOf string) (*committed, error) {
	if len(changes) == 0 {
		return nil, nil
	}
	summary := m.summary
	if summary == "" {
		summary = generatedSummary(m.verb, changes)
	}
	e := &committed{id: ids.New("ae"), action: m.action, summary: summary, actor: m.Actor}
	var irreversible, rev any
	if m.irreversible != "" {
		irreversible = m.irreversible
	}
	if revertOf != "" {
		rev = revertOf
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO audit_entries
		(id, created_at, actor_kind, actor_id, actor_name, action, summary, irreversible, revert_of)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		e.id, store.Millis(m.Now), m.Actor.Kind, m.Actor.ID, m.Actor.Name, m.action, summary, irreversible, rev); err != nil {
		return nil, err
	}
	for i, ch := range changes {
		if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO audit_changes
			(entry_id, seq, resource, record_id, record_name, before, after) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			e.id, i, ch.r.resourceName(), ch.id, ch.name, nullJSON(ch.before), nullJSON(ch.after)); err != nil {
			return nil, err
		}
	}
	return e, nil
}

func (tr *Trail) logCommitted(e *committed) {
	if e == nil {
		return
	}
	tr.log.Info("configuration changed", logs.Kind(KindChange),
		"audit_entry", e.id, "action", e.action, "actor", e.actor.Name, "actor_kind", e.actor.Kind, "summary", e.summary)
}

func nullJSON(b json.RawMessage) any {
	if b == nil {
		return nil
	}
	return string(b)
}

// generatedSummary is "Revoked Admin Token agent-1" or "Revoked 3 Admin
// Tokens" (by the first change's resource).
func generatedSummary(verb string, changes []stored) string {
	if verb == "" {
		verb = "Changed"
	}
	first := changes[0]
	label, plural := first.r.resourceName(), first.r.resourceName()+"s"
	if r, ok := first.r.(interface{ labels() (string, string) }); ok {
		label, plural = r.labels()
	}
	same := 0
	for _, c := range changes {
		if c.r.resourceName() == first.r.resourceName() {
			same++
		}
	}
	if same == 1 {
		return verb + " " + label + " " + first.name
	}
	return verb + " " + strconv.Itoa(same) + " " + plural
}

func (r *Resource[T]) labels() (string, string) { return r.Label, r.Plural }

// views turns stored changes into API views with secrets masked.
func views(in []stored) []Change {
	out := make([]Change, 0, len(in))
	for _, s := range in {
		out = append(out, view(s.r, s.id, s.name, s.before, s.after))
	}
	return out
}

func view(r Tracker, id, name string, before, after json.RawMessage) Change {
	c := Change{Resource: r.resourceName(), ID: id, Name: name, Op: "update"}
	switch {
	case before == nil:
		c.Op = "create"
	case after == nil:
		c.Op = "delete"
	default:
		c.Fields = changedFields(before, after)
	}
	c.Before, c.After = mask(before, r.secrets()), mask(after, r.secrets())
	return c
}

func changedFields(before, after json.RawMessage) []string {
	var b, a map[string]json.RawMessage
	if json.Unmarshal(before, &b) != nil || json.Unmarshal(after, &a) != nil {
		return nil
	}
	var out []string
	for k, v := range a {
		if !bytes.Equal(b[k], v) {
			out = append(out, k)
		}
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			out = append(out, k)
		}
	}
	slices.Sort(out)
	return out
}

// mask replaces secret fields with "…" and their last four characters.
func mask(snap json.RawMessage, secrets []string) json.RawMessage {
	if snap == nil || len(secrets) == 0 {
		return snap
	}
	var m map[string]any
	if json.Unmarshal(snap, &m) != nil {
		return snap
	}
	for _, f := range secrets {
		if s, ok := m[f].(string); ok && s != "" {
			m[f] = MaskSecret(s)
		}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return snap
	}
	return b
}

// MaskSecret shows only the last four characters of a secret.
func MaskSecret(s string) string {
	if len(s) <= 8 {
		return "…"
	}
	return "…" + s[len(s)-4:]
}

// matches reports whether current still equals a stored snapshot, comparing
// only the fields the stored snapshot has (fields added to a resource after
// the entry was written do not count as a change).
func matches(storedSnap, current json.RawMessage) bool {
	if storedSnap == nil || current == nil {
		return storedSnap == nil && current == nil
	}
	var s, c map[string]json.RawMessage
	if json.Unmarshal(storedSnap, &s) != nil || json.Unmarshal(current, &c) != nil {
		return bytes.Equal(storedSnap, current)
	}
	for k, v := range s {
		if !jsonEqual(v, c[k]) {
			return false
		}
	}
	return true
}

func jsonEqual(a, b json.RawMessage) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return bytes.Equal(a, b)
	}
	xa, _ := json.Marshal(x)
	ya, _ := json.Marshal(y)
	return bytes.Equal(xa, ya)
}
