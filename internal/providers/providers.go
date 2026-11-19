// Package providers stores Providers, their Endpoints and their Upstream
// Keys, serves their admin routes (/api/providers/...), and gives the
// Gateway the routing view of one Provider (Store.Routing).
package providers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
)

// Provider is a Provider as the API returns it.
type Provider struct {
	ID               string     `json:"id"`
	Handle           string     `json:"handle" doc:"Unique, immutable name Callers use: /providers/<handle>/v1/... and <handle>/<model>."`
	Name             string     `json:"name" doc:"Display name."`
	Enabled          bool       `json:"enabled" doc:"A disabled Provider refuses Callers; its configuration is kept."`
	Archived         bool       `json:"archived" doc:"An archived Provider refuses Callers and keeps its handle reserved."`
	CallerPath       string     `json:"caller_path" doc:"Base path Callers use for this Provider, e.g. /providers/acme/v1."`
	CreatedAt        time.Time  `json:"created_at"`
	Endpoints        []Endpoint `json:"endpoints"`
	UpstreamKeyCount int        `json:"upstream_key_count"`
}

// Endpoint is an Endpoint as the API returns it.
type Endpoint struct {
	ID        string    `json:"id"`
	Provider  string    `json:"provider" doc:"Handle of the Provider."`
	Name      string    `json:"name"`
	URL       string    `json:"url" doc:"Base URL including the version path; Iroha appends the operation path such as /chat/completions."`
	Shape     string    `json:"shape" enum:"openai-chat,openai-responses,anthropic-messages,gemini" doc:"The API format the URL speaks."`
	CreatedAt time.Time `json:"created_at"`
}

// UpstreamKey is an Upstream Key as the API returns it, secret included.
type UpstreamKey struct {
	ID         string     `json:"id"`
	Provider   string     `json:"provider" doc:"Handle of the Provider."`
	Name       string     `json:"name"`
	Secret     string     `json:"secret" doc:"The key itself; empty for a keyless slot (no auth header is sent)."`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty" doc:"Last Attempt with this key, to the minute; absent when never used."`
}

// HandleMaxLen is the longest handle.
const HandleMaxLen = 63

var handlePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)

const handleHint = "Use 1 to 63 lowercase letters, digits and single hyphens, e.g. \"openrouter\" or \"zai-coding\". The handle is part of Callers' URLs and model names and never changes."

// CheckHandle validates a Provider handle exactly as given (never normalised).
func CheckHandle(h string) error {
	switch {
	case h == "":
		return api.BadRequest(handleHint, "handle is required.")
	case len(h) > HandleMaxLen:
		return api.BadRequest(handleHint, "handle is longer than %d characters.", HandleMaxLen)
	case !handlePattern.MatchString(h):
		return api.BadRequest(handleHint, "handle %q is not valid.", h)
	case h == "bulk":
		return api.BadRequest("Pick another handle; \"bulk\" is a word of the admin API's paths.", "handle %q is reserved.", h)
	}
	return nil
}

// checkDisplayName validates a Provider display name.
func checkDisplayName(s string) error {
	hint := "Use 1 to 128 printable characters, e.g. \"Z.ai coding plan\"."
	if strings.TrimSpace(s) == "" {
		return api.BadRequest(hint, "name is empty.")
	}
	if len(s) > 128 {
		return api.BadRequest(hint, "name is longer than 128 characters.")
	}
	for _, c := range s {
		if unicode.IsControl(c) {
			return api.BadRequest(hint, "name contains a control character.")
		}
	}
	return nil
}

// queryer is what reads need from *sql.Tx or *store.DB.
type queryer interface {
	audit.Querier
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// readProvider reads one Provider with its Endpoints; sql.ErrNoRows when absent.
func readProvider(ctx context.Context, q queryer, id string) (Provider, error) {
	var p Provider
	var created int64
	err := q.QueryRowContext(ctx, `SELECT id, handle, name, enabled, archived, created_at,
		(SELECT count(*) FROM upstream_keys k WHERE k.provider_id = providers.id)
		FROM providers WHERE id = ?`, id).
		Scan(&p.ID, &p.Handle, &p.Name, &p.Enabled, &p.Archived, &created, &p.UpstreamKeyCount)
	if err != nil {
		return p, err
	}
	p.CreatedAt = store.FromMillis(created)
	p.CallerPath = "/providers/" + p.Handle + "/v1"
	p.Endpoints, err = listEndpoints(ctx, q, id)
	return p, err
}

const endpointColumns = `e.id, p.handle, e.name, e.url, e.shape, e.created_at`

func scanEndpoint(row interface{ Scan(...any) error }) (Endpoint, error) {
	var e Endpoint
	var created int64
	err := row.Scan(&e.ID, &e.Provider, &e.Name, &e.URL, &e.Shape, &created)
	e.CreatedAt = store.FromMillis(created)
	return e, err
}

func listEndpoints(ctx context.Context, q queryer, providerID string) ([]Endpoint, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+endpointColumns+` FROM endpoints e JOIN providers p ON p.id = e.provider_id
		WHERE e.provider_id = ? ORDER BY e.created_at, e.rowid`, providerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Endpoint{}
	for rows.Next() {
		e, err := scanEndpoint(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

func readEndpoint(ctx context.Context, q queryer, id string) (Endpoint, error) {
	return scanEndpoint(q.QueryRowContext(ctx, `SELECT `+endpointColumns+` FROM endpoints e JOIN providers p ON p.id = e.provider_id WHERE e.id = ?`, id))
}

const keyColumns = `k.id, p.handle, k.name, k.secret, k.created_at, k.last_used_at`

func scanKey(row interface{ Scan(...any) error }) (UpstreamKey, error) {
	var k UpstreamKey
	var created int64
	var used sql.NullInt64
	err := row.Scan(&k.ID, &k.Provider, &k.Name, &k.Secret, &created, &used)
	k.CreatedAt = store.FromMillis(created)
	if used.Valid {
		at := store.FromMillis(used.Int64)
		k.LastUsedAt = &at
	}
	return k, err
}

func readKey(ctx context.Context, q queryer, id string) (UpstreamKey, error) {
	return scanKey(q.QueryRowContext(ctx, `SELECT `+keyColumns+` FROM upstream_keys k JOIN providers p ON p.id = k.provider_id WHERE k.id = ?`, id))
}

// ref is a resolved Provider: its ID and handle.
type ref struct{ id, handle string }

// resolveProvider resolves a Provider by handle or ID.
func resolveProvider(ctx context.Context, q queryer, s string) (ref, error) {
	id, err := Resource.Resolve(ctx, q, s)
	if err != nil {
		return ref{}, err
	}
	var h string
	err = q.QueryRowContext(ctx, `SELECT handle FROM providers WHERE id = ?`, id).Scan(&h)
	return ref{id: id, handle: h}, err
}

// resolveChild finds a record of table (endpoints or upstream_keys) of
// Provider p by its name or ID.
func resolveChild(ctx context.Context, q queryer, table, label, list string, p ref, s string) (string, error) {
	var id string
	err := q.QueryRowContext(ctx, `SELECT id FROM `+table+` WHERE provider_id = ? AND (id = ? OR name = ?) ORDER BY id = ? DESC LIMIT 1`,
		p.id, s, s, s).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", api.NotFound(fmt.Sprintf("List them with GET /api/providers/%s/%s; address one by its name or ID.", p.handle, list),
			"Provider %s has no %s named %q or with that ID.", p.handle, label, s).
			WithDetails(map[string]string{"provider": p.handle, "ref": s})
	}
	return id, err
}

// Store gives the Gateway what it needs of Providers.
type Store struct {
	db    *store.DB
	clock clock.Clock
}

// New returns a Store.
func New(db *store.DB) *Store { return &Store{db: db, clock: db.Clock()} }

// Routing is the routing view of one Provider.
type Routing struct {
	planner.Provider
	Enabled  bool
	Archived bool
}

// Routing reads the Provider with this handle for planning. ok is false
// when no Provider has the handle (or the handle is not valid).
func (s *Store) Routing(ctx context.Context, handle string) (r Routing, ok bool, err error) {
	if CheckHandle(handle) != nil {
		return r, false, nil
	}
	err = s.db.QueryRowContext(ctx, `SELECT id, handle, enabled, archived FROM providers WHERE handle = ?`, handle).
		Scan(&r.ID, &r.Handle, &r.Enabled, &r.Archived)
	if errors.Is(err, sql.ErrNoRows) {
		return r, false, nil
	}
	if err != nil {
		return r, false, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, url, shape, auth_style, auth_param, static_headers, renames
		FROM endpoints WHERE provider_id = ? ORDER BY created_at, rowid`, r.ID)
	if err != nil {
		return r, false, err
	}
	for rows.Next() {
		var e planner.Endpoint
		var sh, headers, renames string
		if err := rows.Scan(&e.ID, &e.Name, &e.URL, &sh, &e.AuthStyle, &e.AuthParam, &headers, &renames); err != nil {
			rows.Close()
			return r, false, err
		}
		e.Shape = shape.Shape(sh)
		if err := json.Unmarshal([]byte(headers), &e.StaticHeaders); err != nil {
			rows.Close()
			return r, false, fmt.Errorf("endpoint %s static_headers: %w", e.ID, err)
		}
		if err := json.Unmarshal([]byte(renames), &e.Renames); err != nil {
			rows.Close()
			return r, false, fmt.Errorf("endpoint %s renames: %w", e.ID, err)
		}
		r.Endpoints = append(r.Endpoints, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return r, false, err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT id, name, secret FROM upstream_keys WHERE provider_id = ? ORDER BY created_at, rowid`, r.ID)
	if err != nil {
		return r, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var k planner.Key
		if err := rows.Scan(&k.ID, &k.Name, &k.Secret); err != nil {
			return r, false, err
		}
		r.Keys = append(r.Keys, k)
	}
	return r, true, rows.Err()
}

// lastUsedGranularity limits last_used_at writes to one per key per minute.
const lastUsedGranularity = time.Minute

// MarkKeyUsed records that an Attempt used Upstream Key id.
func (s *Store) MarkKeyUsed(ctx context.Context, id string) error {
	now := s.clock.Now()
	_, err := s.db.ExecContext(ctx, `UPDATE upstream_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at <= ?)`,
		store.Millis(now), id, store.Millis(now.Add(-lastUsedGranularity)))
	return err
}

// Handles maps Provider IDs to handles (IDs without a Provider are left out).
func Handles(ctx context.Context, q queryer, ids []string) (map[string]string, error) {
	out := map[string]string{}
	for _, id := range ids {
		var h string
		err := q.QueryRowContext(ctx, `SELECT handle FROM providers WHERE id = ?`, id).Scan(&h)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		out[id] = h
	}
	return out, nil
}

// ResolveID returns the ID of the Provider addressed by handle or ID, with
// the uniform 404 when there is none.
func ResolveID(ctx context.Context, q audit.Querier, s string) (string, error) {
	return Resource.Resolve(ctx, q, s)
}
