package audit

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"

	"github.com/hoangvu12/iroha/internal/api"
)

type Querier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Resource's T is a JSON-encodable snapshot of the record's configuration.
// Leave runtime state (last used, Key State, counters) out of T: it changes
// without Audit Entries and would make every revert look like a conflict.
type Resource[T any] struct {
	Name   string // snake_case, stored in Audit Entries: "admin_token"
	Label  string
	Plural string
	Path   string // the list route, named in not-found hints: "/api/admin-tokens"

	// Table must have an id column. NameColumn defaults to "name".
	Table, NameColumn string

	// Secrets lists top-level snapshot fields masked in Audit Entry views;
	// storage keeps them whole.
	Secrets []string

	NameOf func(T) string
	// Load returns nil and no error when the record does not exist.
	Load func(ctx context.Context, q Querier, id string) (*T, error)
	// Restore deletes the record when snap is nil. Update in place (INSERT
	// ... ON CONFLICT(id) DO UPDATE), never delete and re-insert, so
	// foreign-key cascades do not take children with it. Return an
	// *api.Error (409) when the state forbids it.
	Restore func(ctx context.Context, tx *sql.Tx, id string, snap *T) error
}

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

// Call Register from a package-level var; it panics on a duplicate name or
// a missing field.
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

// Resolve takes an ID or a name; an ID wins when a name equals another
// record's ID.
func (r *Resource[T]) Resolve(ctx context.Context, q Querier, ref string) (string, error) {
	id, err := r.Find(ctx, q, ref)
	if err == nil && id == "" {
		return "", r.NotFound(ref)
	}
	return id, err
}

func (r *Resource[T]) Find(ctx context.Context, q Querier, ref string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx,
		`SELECT id FROM `+r.Table+` WHERE id = ? OR `+r.NameColumn+` = ? ORDER BY id = ? DESC LIMIT 1`,
		ref, ref, ref).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return id, err
}

func (r *Resource[T]) Taken(id, name, put string) *api.Error {
	article := "A"
	if strings.ContainsRune("AEIOU", rune(r.Label[0])) {
		article = "An"
	}
	return api.Conflict("name_taken", fmt.Sprintf("Pick another name, or update that %s with PUT %s.", r.Label, put),
		"%s %s named %q exists.", article, r.Label, name).
		WithDetails(map[string]string{"resource": r.Name, "id": id, "name": name})
}

func CheckPutName(field, ref, sent, current string) error {
	if sent == "" || sent == ref || sent == current {
		return nil
	}
	return api.BadRequest(fmt.Sprintf("Leave %s out of the body (the path names the record), or rename it with PATCH.", field),
		"The body's %s %q differs from the path's %q.", field, sent, ref)
}

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
