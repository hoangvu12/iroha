package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/store"
)

type Entry struct {
	ID            string    `json:"id"`
	Time          time.Time `json:"time"`
	Actor         api.Actor `json:"actor" doc:"The Admin Token or Owner session that made the change."`
	Action        string    `json:"action" doc:"Machine name of the change, e.g. admin_token.create or audit_entry.revert."`
	Summary       string    `json:"summary" doc:"One line for people, e.g. \"Revoked 3 Admin Tokens\"."`
	Changes       []Change  `json:"changes"`
	Revertible    bool      `json:"revertible" doc:"Whether POST .../revert may be tried. It can still refuse with audit_conflict when a record changed since."`
	NotRevertible string    `json:"not_revertible,omitempty" doc:"Why the entry cannot be reverted."`
	RevertOf      string    `json:"revert_of,omitempty" doc:"The Audit Entry this one reverted."`
	RevertedBy    string    `json:"reverted_by,omitempty" doc:"The Audit Entry that reverted this one."`
}

type EntryPage struct {
	Entries    []Entry `json:"entries"`
	NextBefore string  `json:"next_before,omitempty" doc:"Pass as before= to read the next older page; absent on the last page."`
}

// Filter selects Audit Entries. Zero fields do not filter.
type Filter struct {
	Since, Until time.Time
	Actor        string // Admin Token name or ID, or "Owner"
	Resource     string
	Record       string   // a changed record's ID or name
	Actions      []string // exact, or prefixes ending in "*"
	Search       string   // substring of the summary or a changed record's name
	Before       string   // entry ID: only older entries
	Limit        int
}

func (tr *Trail) List(ctx context.Context, f Filter) ([]Entry, error) {
	var where []string
	var args []any
	add := func(cond string, a ...any) { where, args = append(where, cond), append(args, a...) }
	if !f.Since.IsZero() {
		add("e.created_at >= ?", store.Millis(f.Since))
	}
	if !f.Until.IsZero() {
		add("e.created_at < ?", store.Millis(f.Until))
	}
	if f.Actor != "" {
		add("(e.actor_id = ? OR e.actor_name = ?)", f.Actor, f.Actor)
	}
	if f.Resource != "" {
		add("EXISTS (SELECT 1 FROM audit_changes c WHERE c.entry_id = e.id AND c.resource = ?)", f.Resource)
	}
	if f.Record != "" {
		add("EXISTS (SELECT 1 FROM audit_changes c WHERE c.entry_id = e.id AND (c.record_id = ? OR c.record_name = ?))", f.Record, f.Record)
	}
	if len(f.Actions) > 0 {
		var ors []string
		for _, a := range f.Actions {
			if prefix, ok := strings.CutSuffix(a, "*"); ok {
				ors, args = append(ors, "substr(e.action, 1, ?) = ?"), append(args, len(prefix), prefix)
			} else {
				ors, args = append(ors, "e.action = ?"), append(args, a)
			}
		}
		where = append(where, "("+strings.Join(ors, " OR ")+")")
	}
	if f.Search != "" {
		like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(f.Search) + "%"
		add(`(e.summary LIKE ? ESCAPE '\' OR EXISTS (SELECT 1 FROM audit_changes c WHERE c.entry_id = e.id AND c.record_name LIKE ? ESCAPE '\'))`, like, like)
	}
	if f.Before != "" {
		add("e.rowid < (SELECT rowid FROM audit_entries WHERE id = ?)", f.Before)
	}
	q := `SELECT e.id FROM audit_entries e`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	q += " ORDER BY e.rowid DESC LIMIT ?"
	args = append(args, limit)
	rows, err := tr.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	var idList []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		idList = append(idList, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(idList))
	for _, id := range idList {
		e, _, err := tr.read(ctx, tr.db, id)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, nil
}

type FilterOptions struct {
	Actors    []ActorOption    `json:"actors" doc:"The Owner first, then Admin Tokens, most recently active first."`
	Resources []ResourceOption `json:"resources" doc:"Kinds of record changed, by label."`
}

type ActorOption struct {
	Kind    string    `json:"kind" enum:"admin_token,owner_session"`
	ID      string    `json:"id,omitempty" doc:"The Admin Token's ID; absent for the Owner, whose sessions count as one actor."`
	Name    string    `json:"name" doc:"The Admin Token's name in its latest Audit Entry, or Owner."`
	Filter  string    `json:"filter" doc:"The value to pass as actor= (the token's ID, so renames do not matter, or Owner)."`
	Entries int       `json:"entries" doc:"How many Audit Entries this actor made."`
	LastAt  time.Time `json:"last_at" doc:"Time of the actor's latest Audit Entry."`
}

type ResourceOption struct {
	Name    string `json:"name" doc:"The value to pass as resource=, e.g. admin_token."`
	Label   string `json:"label" doc:"e.g. Admin Token."`
	Plural  string `json:"plural" doc:"e.g. Admin Tokens."`
	Entries int    `json:"entries" doc:"How many Audit Entries changed a record of this kind."`
}

const ownerName = "Owner"

func (tr *Trail) Filters(ctx context.Context) (FilterOptions, error) {
	out := FilterOptions{Actors: []ActorOption{}, Resources: []ResourceOption{}}
	rows, err := tr.db.QueryContext(ctx, `SELECT g.kind, g.who, e.actor_name, g.n, e.created_at FROM (
			SELECT actor_kind AS kind, CASE WHEN actor_kind = ? THEN '' ELSE actor_id END AS who, count(*) AS n, max(rowid) AS last
			FROM audit_entries GROUP BY kind, who
		) g JOIN audit_entries e ON e.rowid = g.last
		ORDER BY g.kind = ? DESC, g.last DESC`,
		api.ActorOwnerSession, api.ActorOwnerSession)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var a ActorOption
		var at int64
		if err := rows.Scan(&a.Kind, &a.ID, &a.Name, &a.Entries, &at); err != nil {
			rows.Close()
			return out, err
		}
		a.LastAt, a.Filter = store.FromMillis(at), a.ID
		if a.Kind == api.ActorOwnerSession {
			a.Name, a.Filter = ownerName, ownerName
		}
		out.Actors = append(out.Actors, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}

	rows, err = tr.db.QueryContext(ctx, `SELECT resource, count(DISTINCT entry_id) FROM audit_changes GROUP BY resource`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var r ResourceOption
		if err := rows.Scan(&r.Name, &r.Entries); err != nil {
			return out, err
		}
		r.Label, r.Plural = r.Name, r.Name
		if t, ok := lookup(r.Name); ok {
			if l, ok := t.(interface{ labels() (string, string) }); ok {
				r.Label, r.Plural = l.labels()
			}
		}
		out.Resources = append(out.Resources, r)
	}
	slices.SortFunc(out.Resources, func(a, b ResourceOption) int { return strings.Compare(a.Label, b.Label) })
	return out, rows.Err()
}

type queryer interface {
	Querier
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func (tr *Trail) read(ctx context.Context, q queryer, id string) (Entry, []stored, error) {
	var e Entry
	var at int64
	var irreversible, revertOf, revertedBy sql.NullString
	err := q.QueryRowContext(ctx, `SELECT id, created_at, actor_kind, actor_id, actor_name, action, summary, irreversible, revert_of, reverted_by
		FROM audit_entries WHERE id = ?`, id).
		Scan(&e.ID, &at, &e.Actor.Kind, &e.Actor.ID, &e.Actor.Name, &e.Action, &e.Summary, &irreversible, &revertOf, &revertedBy)
	if errors.Is(err, sql.ErrNoRows) {
		return e, nil, api.NotFound("List Audit Entries with GET /api/audit-entries.", "No Audit Entry has the ID %q.", id)
	}
	if err != nil {
		return e, nil, err
	}
	e.Time = store.FromMillis(at)
	e.RevertOf, e.RevertedBy = revertOf.String, revertedBy.String
	switch {
	case irreversible.Valid:
		e.NotRevertible = irreversible.String
	case revertedBy.Valid:
		e.NotRevertible = "Already reverted by " + revertedBy.String + "; revert that entry to redo this change."
	default:
		e.Revertible = true
	}
	rows, err := q.QueryContext(ctx, `SELECT resource, record_id, record_name, before, after FROM audit_changes WHERE entry_id = ? ORDER BY seq`, id)
	if err != nil {
		return e, nil, err
	}
	defer rows.Close()
	var all []stored
	e.Changes = []Change{}
	for rows.Next() {
		var resource, rid, name string
		var before, after sql.NullString
		if err := rows.Scan(&resource, &rid, &name, &before, &after); err != nil {
			return e, nil, err
		}
		s := stored{id: rid, name: name, before: rawOrNil(before), after: rawOrNil(after)}
		r, ok := lookup(resource)
		if !ok {
			r = unregisteredResource(resource)
		}
		s.r = r
		all = append(all, s)
		e.Changes = append(e.Changes, view(r, rid, name, s.before, s.after))
	}
	return e, all, rows.Err()
}

func rawOrNil(s sql.NullString) json.RawMessage {
	if !s.Valid {
		return nil
	}
	return json.RawMessage(s.String)
}

type unregisteredResource string

func (u unregisteredResource) resourceName() string { return string(u) }
func (u unregisteredResource) secrets() []string    { return nil }
func (u unregisteredResource) load(context.Context, Querier, string) (json.RawMessage, string, error) {
	return nil, "", fmt.Errorf("audit: resource %q is not registered", string(u))
}
func (u unregisteredResource) restore(context.Context, *sql.Tx, string, json.RawMessage) error {
	return fmt.Errorf("audit: resource %q is not registered", string(u))
}

type RevertResult struct {
	Result
	Reverted string `json:"reverted" doc:"The Audit Entry that was (or, on a dry run, would be) reverted."`
}

type Conflict struct {
	Resource string   `json:"resource"`
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Later    []string `json:"later_entries" doc:"Newer Audit Entries that changed this record, newest first."`
}

func (tr *Trail) Revert(c *api.Call, id string) (RevertResult, error) {
	dry, err := IsDryRun(c)
	if err != nil {
		return RevertResult{}, err
	}
	ctx := c.R.Context()
	res := RevertResult{Reverted: id}
	var entry *committed
	err = tr.db.Tx(ctx, func(tx *sql.Tx) error {
		e, changes, err := tr.read(ctx, tx, id)
		if err != nil {
			return err
		}
		if e.RevertedBy != "" {
			return api.Conflict("audit_already_reverted",
				fmt.Sprintf("To redo the change, revert %s (POST /api/audit-entries/%s/revert).", e.RevertedBy, e.RevertedBy),
				"Audit Entry %s was already reverted by %s.", e.ID, e.RevertedBy)
		}
		if !e.Revertible {
			return api.Conflict("audit_irreversible", e.NotRevertible, "Audit Entry %s (%s) cannot be reverted.", e.ID, e.Summary)
		}
		var conflicts []Conflict
		for _, ch := range changes {
			if _, ok := lookup(ch.r.resourceName()); !ok {
				return api.Conflict("audit_irreversible", "This kind of record is no longer managed by Iroha; change it by hand if it still matters.",
					"Audit Entry %s changed a %s, which this version of Iroha cannot restore.", e.ID, ch.r.resourceName())
			}
			current, name, err := ch.r.load(ctx, tx, ch.id)
			if err != nil {
				return err
			}
			if matchesStoredFields(ch.after, current) {
				continue
			}
			later, err := laterEntries(ctx, tx, e.ID, ch.r.resourceName(), ch.id)
			if err != nil {
				return err
			}
			if name == "" {
				name = ch.name
			}
			conflicts = append(conflicts, Conflict{Resource: ch.r.resourceName(), ID: ch.id, Name: name, Later: later})
		}
		if len(conflicts) > 0 {
			hint := "Revert the later Audit Entries listed in details first, newest first, then retry; or make the change you want directly."
			return api.Conflict("audit_conflict", hint,
				"%d record(s) changed after Audit Entry %s, so reverting it would overwrite newer changes.", len(conflicts), e.ID).
				WithDetails(map[string]any{"conflicts": conflicts})
		}

		m := tr.begin(c, tx, dry, "audit_entry.revert", "")
		m.Summarize("Reverted: " + e.Summary)
		for _, ch := range changes {
			if err := m.Track(ch.r, ch.id); err != nil {
				return err
			}
		}
		if err := restoreInDependencyOrder(ctx, tx, changes); err != nil {
			return err
		}
		done, outcome, err := m.collect()
		if err != nil {
			return err
		}
		res.Result = Result{DryRun: dry, Outcome: outcome, Changes: views(done)}
		if dry {
			return errDryRun
		}
		if entry, err = m.write(done, e.ID); err != nil || entry == nil {
			return err
		}
		res.AuditEntry = entry.id
		_, err = tx.ExecContext(ctx, `UPDATE audit_entries SET reverted_by = ? WHERE id = ?`, entry.id, e.ID)
		return err
	})
	if errors.Is(err, errDryRun) {
		err = nil
	}
	if err != nil {
		return RevertResult{}, err
	}
	tr.logCommitted(entry)
	return res, nil
}

func restoreInDependencyOrder(ctx context.Context, tx *sql.Tx, changes []stored) error {
	for _, ch := range changes {
		if ch.before != nil {
			if err := ch.r.restore(ctx, tx, ch.id, ch.before); err != nil {
				return err
			}
		}
	}
	for i := len(changes) - 1; i >= 0; i-- {
		if ch := changes[i]; ch.before == nil {
			if err := ch.r.restore(ctx, tx, ch.id, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

func laterEntries(ctx context.Context, q queryer, entryID, resource, recordID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT e.id, e.rowid FROM audit_entries e JOIN audit_changes c ON c.entry_id = e.id
		WHERE c.resource = ? AND c.record_id = ? AND e.rowid > (SELECT rowid FROM audit_entries WHERE id = ?)
		ORDER BY e.rowid DESC`, resource, recordID, entryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		var rowid int64
		if err := rows.Scan(&id, &rowid); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

const maxLimit = 1000

func Routes(tr *Trail) []api.Route {
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/audit-entries", Tag: "Audit Entries",
			Summary:     "List Audit Entries, newest first",
			Description: "Every change to Iroha's configuration, with who made it and each record's before and after. Filters combine with AND.",
			Query: []api.Param{
				{Name: "actor", Description: "Admin Token name or ID, or Owner."},
				{Name: "resource", Description: "Only entries changing this kind of record, e.g. admin_token."},
				{Name: "record", Description: "Only entries changing this record (its ID or name)."},
				{Name: "action", Description: "Comma-separated actions; a trailing * matches a prefix (admin_token.*)."},
				{Name: "q", Description: "Text to find in the summary or a changed record's name."},
				{Name: "since", Description: "Only entries at or after this time: RFC 3339, or a duration back from now such as 24h."},
				{Name: "until", Description: "Only entries before this time: RFC 3339, or a duration back from now."},
				{Name: "before", Description: "Only entries older than this entry ID (paging; use next_before)."},
				{Name: "limit", Type: "integer", Description: "Page size, default 100, at most 1000."},
			},
			Response: EntryPage{},
			Handle: func(c *api.Call) (any, error) {
				f, err := tr.parseFilter(c)
				if err != nil {
					return nil, err
				}
				entries, err := tr.List(c.R.Context(), f)
				if err != nil {
					return nil, err
				}
				p := EntryPage{Entries: entries}
				if len(entries) == f.Limit {
					p.NextBefore = entries[len(entries)-1].ID
				}
				return p, nil
			},
		},
		{
			Method: http.MethodGet, Path: "/api/audit-entries/filters", Tag: "Audit Entries",
			Summary:     "List who made changes and what kinds of record they changed",
			Description: "The values worth offering for actor= and resource= on GET /api/audit-entries, with how many entries each has.",
			Response:    FilterOptions{},
			Handle: func(c *api.Call) (any, error) {
				return tr.Filters(c.R.Context())
			},
		},
		{
			Method: http.MethodGet, Path: "/api/audit-entries/{entry}", Tag: "Audit Entries",
			Summary:  "Read one Audit Entry",
			Response: Entry{},
			Handle: func(c *api.Call) (any, error) {
				e, _, err := tr.read(c.R.Context(), tr.db, c.Path("entry"))
				return e, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/audit-entries/{entry}/revert", Tag: "Audit Entries",
			Summary: "Revert an Audit Entry, restoring every record's before-state",
			Description: "The revert is itself an Audit Entry (action audit_entry.revert, revert_of set), so it can be reverted to redo the change. " +
				"Refused with audit_conflict when a record changed after the entry (details list the later entries to revert first), " +
				"with audit_irreversible for changes that cannot be undone (such as revoking a secret), and with audit_already_reverted.",
			Query:    []api.Param{DryRun},
			Response: RevertResult{},
			Handle: func(c *api.Call) (any, error) {
				return tr.Revert(c, c.Path("entry"))
			},
		},
	}
}

func (tr *Trail) parseFilter(c *api.Call) (Filter, error) {
	q := c.R.URL.Query()
	f := Filter{Limit: 100, Actor: q.Get("actor"), Resource: q.Get("resource"), Record: q.Get("record"),
		Search: q.Get("q"), Before: q.Get("before")}
	var err error
	timeHint := "Use an RFC 3339 time (2026-01-02T15:04:05Z) or a duration such as 24h."
	if f.Since, err = tr.parseTime(q.Get("since")); err != nil {
		return f, api.BadRequest(timeHint, "since: %v", err)
	}
	if f.Until, err = tr.parseTime(q.Get("until")); err != nil {
		return f, api.BadRequest(timeHint, "until: %v", err)
	}
	for _, a := range strings.Split(q.Get("action"), ",") {
		if a = strings.TrimSpace(a); a != "" {
			f.Actions = append(f.Actions, a)
		}
	}
	if s := q.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxLimit {
			return f, api.BadRequest("Use a limit between 1 and 1000.", "limit must be between 1 and %d.", maxLimit)
		}
		f.Limit = n
	}
	return f, nil
}

func (tr *Trail) parseTime(s string) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	if d, err := time.ParseDuration(s); err == nil && d >= 0 {
		return tr.clock.Now().Add(-d), nil
	}
	return time.Time{}, fmt.Errorf("%q is neither an RFC 3339 time nor a duration", s)
}
