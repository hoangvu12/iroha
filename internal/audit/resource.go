// Package audit is the shared machinery of every admin resource: name-or-ID
// addressing, audited mutations with dry run, bulk calls with per-item
// results, Audit Entries and revert. docs/agents/architecture.md ("Add an
// admin resource") shows how a resource plugs in.
package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"

	"github.com/hoangvu12/iroha/internal/api"
)

// Querier reads rows; *sql.Tx, *sql.DB and *store.DB satisfy it.
type Querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Resource describes one kind of configuration record (Admin Token,
// Provider, Upstream Key...) to the audit machinery. T is its snapshot: the
// configuration fields an Audit Entry records and a revert restores, as a
// JSON-encodable struct. Leave runtime state (last used, Key State, counters)
// out of T: it changes without Audit Entries and would make every revert
// look like a conflict.
type Resource[T any] struct {
	Name   string // stored in Audit Entries and filterable: "admin_token"
	Label  string // "Admin Token"
	Plural string // "Admin Tokens"
	Path   string // the list route, named in not-found hints: "/api/admin-tokens"

	// Table and NameColumn let Resolve find a record by ID (column id) or
	// by name. NameColumn defaults to "name".
	Table, NameColumn string

	// Secrets lists top-level snapshot fields shown masked in Audit Entry
	// views (they stay whole in storage so a revert can restore them).
	Secrets []string

	// NameOf returns the record's display name from a snapshot.
	NameOf func(T) string
	// Load returns the snapshot of record id, or nil (and no error) when it
	// does not exist.
	Load func(ctx context.Context, q Querier, id string) (*T, error)
	// Restore makes record id equal to snap, or deletes it when snap is nil.
	// Update in place (INSERT ... ON CONFLICT(id) DO UPDATE), never delete
	// and re-insert, so foreign-key cascades do not take children with it.
	// Return an *api.Error (409) when the state forbids it, e.g. the name is
	// now taken by another record.
	Restore func(ctx context.Context, tx *sql.Tx, id string, snap *T) error
}

// Tracker is a registered Resource of any snapshot type.
type Tracker interface {
	resourceName() string
	load(ctx context.Context, q Querier, id string) (json.RawMessage, string, error)
	restore(ctx context.Context, tx *sql.Tx, id string, snap json.RawMessage) error
	secrets() []string
}

var (
	registryMu sync.Mutex
	registry   = map[string]Tracker{}
)

// Register makes r known to revert and returns it. Call it from a
// package-level var; it panics on a duplicate name or a missing function.
func Register[T any](r *Resource[T]) *Resource[T] {
	if r.Name == "" || r.Label == "" || r.Plural == "" || r.Path == "" || r.Table == "" ||
		r.NameOf == nil || r.Load == nil || r.Restore == nil {
		panic(fmt.Sprintf("audit: resource %q: Name, Label, Plural, Path, Table, NameOf, Load and Restore are required", r.Name))
	}
	if r.NameColumn == "" {
		r.NameColumn = "name"
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	if _, ok := registry[r.Name]; ok {
		panic(fmt.Sprintf("audit: resource %q registered twice", r.Name))
	}
	registry[r.Name] = r
	return r
}

func lookup(name string) (Tracker, bool) {
	registryMu.Lock()
	defer registryMu.Unlock()
	t, ok := registry[name]
	return t, ok
}

// ResourceNames lists registered resource names, sorted.
func ResourceNames() []string {
	registryMu.Lock()
	defer registryMu.Unlock()
	var out []string
	for n := range registry {
		out = append(out, n)
	}
	slices.Sort(out)
	return out
}

// Resolve returns the ID of the record addressed by ref, which is its ID or
// its name. An ID wins when a name happens to equal another record's ID.
// A missing record is a 404 not_found whose hint names the list route.
func (r *Resource[T]) Resolve(ctx context.Context, q Querier, ref string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx,
		`SELECT id FROM `+r.Table+` WHERE id = ? OR `+r.NameColumn+` = ? ORDER BY id = ? DESC LIMIT 1`,
		ref, ref, ref).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", r.NotFound(ref)
	}
	return id, err
}

// Get resolves ref and loads the record's snapshot.
func (r *Resource[T]) Get(ctx context.Context, q Querier, ref string) (string, *T, error) {
	id, err := r.Resolve(ctx, q, ref)
	if err != nil {
		return "", nil, err
	}
	v, err := r.Load(ctx, q, id)
	if err == nil && v == nil {
		err = r.NotFound(ref)
	}
	return id, v, err
}

// NotFound is the uniform 404 for a ref that names no record.
func (r *Resource[T]) NotFound(ref string) *api.Error {
	return api.NotFound(
		fmt.Sprintf("List %s with GET %s; address one by its name or ID.", r.Plural, r.Path),
		"No %s is named %q or has that ID.", r.Label, ref).
		WithDetails(map[string]string{"resource": r.Name, "ref": ref})
}

func (r *Resource[T]) resourceName() string { return r.Name }
func (r *Resource[T]) secrets() []string    { return r.Secrets }

func (r *Resource[T]) load(ctx context.Context, q Querier, id string) (json.RawMessage, string, error) {
	v, err := r.Load(ctx, q, id)
	if err != nil || v == nil {
		return nil, "", err
	}
	b, err := json.Marshal(v)
	return b, r.NameOf(*v), err
}

func (r *Resource[T]) restore(ctx context.Context, tx *sql.Tx, id string, snap json.RawMessage) error {
	if snap == nil {
		return r.Restore(ctx, tx, id, nil)
	}
	v := new(T)
	if err := json.Unmarshal(snap, v); err != nil {
		return fmt.Errorf("audit: %s %s: stored snapshot does not decode: %w", r.Name, id, err)
	}
	return r.Restore(ctx, tx, id, v)
}
