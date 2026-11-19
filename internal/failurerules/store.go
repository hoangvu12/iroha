// Package failurerules manages Failure Rules through the admin API: the
// Owner's rules (new ones, overrides of built-ins by name, built-ins switched
// off) in the failure_rules table, audited as the failure_rule resource; the
// live rules.Set the Gateway classifies with (Store.Set), reloaded whenever
// the table changes; hit counts from recorded Attempts; and the replay of
// recent failed Attempts a dry run reports.
//
// The engine itself is internal/rules (pure). A Failure Rule is addressed by
// its name, which is also its audit record ID, so built-in rules that have
// no row are records too: they always exist and cannot be deleted.
package failurerules

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"sync"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/store"
)

// Sources of a rule.
const (
	SourceBuiltin = "builtin" // shipped with Iroha, unchanged (it may be switched off)
	SourceOwner   = "owner"   // added by the Owner or an agent, or a built-in overridden
)

type queryer interface {
	audit.Querier
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// row is one row of failure_rules.
type row struct {
	name    string
	enabled bool
	def     *rules.Rule // nil: the built-in rule of this name as shipped
}

// entry is one rule as it stands now.
type entry struct {
	rule    rules.Rule
	enabled bool
	source  string
	builtin *rules.Rule // the shipped rule of this name, if any
}

func builtin(name string) (rules.Rule, bool) {
	for _, r := range rules.Builtin {
		if r.Name == name {
			return r, true
		}
	}
	return rules.Rule{}, false
}

func readRows(ctx context.Context, q queryer) ([]row, error) {
	rs, err := q.QueryContext(ctx, `SELECT name, enabled, definition FROM failure_rules ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	defer rs.Close()
	var out []row
	for rs.Next() {
		var r row
		var def sql.NullString
		if err := rs.Scan(&r.name, &r.enabled, &def); err != nil {
			return nil, err
		}
		if r.def, err = decodeDef(r.name, def); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rs.Err()
}

func readRow(ctx context.Context, q audit.Querier, name string) (*row, error) {
	r := row{name: name}
	var def sql.NullString
	err := q.QueryRowContext(ctx, `SELECT enabled, definition FROM failure_rules WHERE name = ?`, name).Scan(&r.enabled, &def)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if r.def, err = decodeDef(name, def); err != nil {
		return nil, err
	}
	return &r, nil
}

func decodeDef(name string, def sql.NullString) (*rules.Rule, error) {
	if !def.Valid {
		return nil, nil
	}
	var r rules.Rule
	if err := json.Unmarshal([]byte(def.String), &r); err != nil {
		return nil, err
	}
	r.Name = name
	return &r, nil
}

// entryOf combines a row (nil: none) with the built-in of its name. ok is
// false when the name is neither.
func entryOf(name string, r *row) (entry, bool) {
	b, isBuiltin := builtin(name)
	e := entry{enabled: true, source: SourceBuiltin}
	if isBuiltin {
		e.builtin = &b
		e.rule = b
	}
	if r != nil {
		e.enabled = r.enabled
		if r.def != nil {
			e.rule, e.source = *r.def, SourceOwner
		}
	}
	if e.rule.Name == "" {
		return entry{}, false
	}
	return e, true
}

func readEntry(ctx context.Context, q audit.Querier, name string) (entry, bool, error) {
	r, err := readRow(ctx, q, name)
	if err != nil {
		return entry{}, false, err
	}
	e, ok := entryOf(name, r)
	return e, ok, nil
}

// readEntries lists every rule in the order they are tried: rules limited to
// a Provider or host first, then the others; within each, the Owner's new
// rules (in the order added) before the built-ins, an override taking its
// built-in's place.
func readEntries(ctx context.Context, q queryer) ([]entry, error) {
	rows, err := readRows(ctx, q)
	if err != nil {
		return nil, err
	}
	byName := map[string]row{}
	var owner []rules.Rule
	for _, r := range rows {
		byName[r.name] = r
		if r.def != nil {
			owner = append(owner, *r.def)
		}
	}
	merged := rules.Merge(owner, rules.Builtin)
	out := make([]entry, 0, len(merged))
	for _, rule := range merged {
		var rp *row
		if r, ok := byName[rule.Name]; ok {
			rp = &r
		}
		if e, ok := entryOf(rule.Name, rp); ok {
			out = append(out, e)
		}
	}
	// The order Compile uses: scoped rules first, each group stable.
	slices.SortStableFunc(out, func(a, b entry) int {
		switch {
		case a.rule.Scoped() == b.rule.Scoped():
			return 0
		case a.rule.Scoped():
			return -1
		}
		return 1
	})
	return out, nil
}

// compile builds the Set of the enabled rules, leaving out (and logging)
// any stored rule this version of Iroha no longer accepts.
func compile(entries []entry, log *slog.Logger) *rules.Set {
	rs := make([]rules.Rule, 0, len(entries))
	for _, e := range entries {
		if !e.enabled {
			continue
		}
		if err := rules.Validate(e.rule); err != nil {
			if log != nil {
				log.Warn("a stored Failure Rule is not valid and is ignored", logs.Kind(logs.KindGeneric), "rule", e.rule.Name, "err", err.Error())
			}
			continue
		}
		rs = append(rs, e.rule)
	}
	set, err := rules.Compile(rs)
	if err != nil { // names are unique and every rule was validated
		panic(err)
	}
	return set
}

// snapshot is what an Audit Entry records of a Failure Rule: its definition
// and whether it is on.
type snapshot struct {
	rules.Rule
	Enabled bool `json:"enabled"`
}

// Resource is the Failure Rule resource of the audit machinery. The record
// ID is the rule's name.
var Resource = audit.Register(&audit.Resource[snapshot]{
	Name: "failure_rule", Label: "Failure Rule", Plural: "Failure Rules", Path: "/api/rules",
	Table: "failure_rules", NameColumn: "name",
	NameOf: func(s snapshot) string { return s.Name },
	Load: func(ctx context.Context, q audit.Querier, name string) (*snapshot, error) {
		e, ok, err := readEntry(ctx, q, name)
		if err != nil || !ok {
			return nil, err
		}
		return &snapshot{Rule: e.rule, Enabled: e.enabled}, nil
	},
	Restore: func(ctx context.Context, tx *sql.Tx, name string, s *snapshot) error {
		return write(ctx, tx, name, s)
	},
})

// write makes rule name equal to s, or removes the Owner's row when s is nil
// (a built-in then stands as shipped). A row exists only while the rule
// differs from the built-in of its name; a built-in only switched off keeps
// no copy of its definition.
func write(ctx context.Context, tx *sql.Tx, name string, s *snapshot) error {
	if s == nil {
		_, err := tx.ExecContext(ctx, `DELETE FROM failure_rules WHERE name = ?`, name)
		return err
	}
	var def any
	if b, ok := builtin(name); !ok || !sameRule(b, s.Rule) {
		r := s.Rule
		r.Name = name
		data, err := json.Marshal(r)
		if err != nil {
			return err
		}
		def = string(data)
	} else if s.Enabled {
		_, err := tx.ExecContext(ctx, `DELETE FROM failure_rules WHERE name = ?`, name)
		return err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO failure_rules (name, enabled, definition) VALUES (?, ?, ?)
		ON CONFLICT (name) DO UPDATE SET enabled = excluded.enabled, definition = excluded.definition`, name, s.Enabled, def)
	return err
}

func sameRule(a, b rules.Rule) bool {
	x, _ := json.Marshal(a)
	y, _ := json.Marshal(b)
	return string(x) == string(y)
}

// Store gives the Gateway the Failure Rules in force.
type Store struct {
	db  *store.DB
	log *slog.Logger

	mu      sync.Mutex
	version int64
	set     *rules.Set
}

// New returns a Store.
func New(db *store.DB, log *slog.Logger) *Store {
	return &Store{db: db, log: log}
}

// Set returns the Failure Rules in force: the built-ins merged with the
// Owner's rules, without those switched off. It notices every committed
// change (API call or revert) through failure_rules_version, so the next
// Attempt after a change uses it. Pass it as gateway.Options.Rules.
func (s *Store) Set() *rules.Set {
	ctx := context.Background()
	var n int64
	if err := s.db.QueryRowContext(ctx, `SELECT n FROM failure_rules_version WHERE id = 1`).Scan(&n); err != nil {
		s.log.Error("reading the Failure Rules failed; using the last ones read", logs.Kind(logs.KindGeneric), "err", err.Error())
		return s.cached()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.set != nil && s.version == n {
		return s.set
	}
	entries, err := readEntries(ctx, s.db)
	if err != nil {
		s.log.Error("reading the Failure Rules failed; using the last ones read", logs.Kind(logs.KindGeneric), "err", err.Error())
		if s.set == nil {
			return rules.Default
		}
		return s.set
	}
	s.set, s.version = compile(entries, s.log), n
	return s.set
}

func (s *Store) cached() *rules.Set {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.set == nil {
		return rules.Default
	}
	return s.set
}

// notFound is the 404 of a name that is no rule.
func notFound(name string) *api.Error {
	return Resource.NotFound(name)
}
