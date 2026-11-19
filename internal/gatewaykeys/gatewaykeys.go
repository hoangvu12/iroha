// Package gatewaykeys stores Gateway Keys, authenticates Callers by them,
// answers what a Caller's scope allows, and serves /api/gateway-keys.
package gatewaykeys

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/pools"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/store"
)

// SecretPrefix starts every Gateway Key secret.
const SecretPrefix = "sk-iroha"

// GatewayKey is a Gateway Key as the API returns it.
type GatewayKey struct {
	ID         string     `json:"id"`
	Name       string     `json:"name" doc:"Who the key was issued to; Requests are attributed to it."`
	Secret     string     `json:"secret" doc:"The key itself. Callers send it as \"Authorization: Bearer <secret>\", \"x-api-key\", \"api-key\", \"x-goog-api-key\" or Gemini's ?key= parameter."`
	Scope      Scope      `json:"scope"`
	Capture    bool       `json:"capture" doc:"true: the full prompt and response of every Request made with this key are stored (GET /api/requests/{request}/capture), for retention.captures_days. false: neither is stored."`
	Revoked    bool       `json:"revoked"`
	CreatedAt  time.Time  `json:"created_at"`
	RevokedAt  *time.Time `json:"revoked_at,omitempty"`
	LastUsedAt *time.Time `json:"last_used_at,omitempty" doc:"Last authenticated use, to the minute; absent when never used."`
	// Ticket 24: activity for the Gateway Keys list.
	RecentRequests int `json:"recent_requests" doc:"Requests made with this key in the last 24 hours (test Requests sent as it from the chat are not counted). GET /api/requests?caller=<name or ID> lists them."`
}

// recentWindow is the period recent_requests counts.
const recentWindow = 24 * time.Hour

// countRecent counts the key's own Requests (not test Requests sent as it)
// started since now - recentWindow, over the requests_gateway_key index.
func countRecent(ctx context.Context, q queryer, id string, now time.Time) (int, error) {
	var n int
	err := q.QueryRowContext(ctx, `SELECT count(*) FROM requests WHERE gateway_key_id = ? AND started_at >= ? AND caller_kind = 'gateway_key'`,
		id, store.Millis(now.Add(-recentWindow))).Scan(&n)
	return n, err
}

// Scope is what a Gateway Key may use.
type Scope struct {
	All       bool            `json:"all" doc:"true: every Provider and Model Pool, including ones added later, and every model."`
	Providers []ScopeProvider `json:"providers,omitempty" doc:"When all is false: the Providers the key may use. An empty list allows nothing."`
	Pools     []string        `json:"pools,omitempty" doc:"When all is false: the Model Pools (name or ID; answers carry names) the key may use as the model on the global routes. A Pool is served by all its members, whatever Providers the key has."`
}

// ScopeProvider is one Provider of a Scope.
type ScopeProvider struct {
	Provider string   `json:"provider" doc:"Provider handle or ID; answers carry the handle."`
	Models   []string `json:"models,omitempty" doc:"Only these models, exactly as Callers name them; omit for every model of the Provider."`
}

// stored is a Scope as stored: Provider IDs, so a scope survives anything
// that happens to handles.
type stored struct {
	All       bool             `json:"all"`
	Providers []storedProvider `json:"providers,omitempty"`
	Pools     []string         `json:"pools,omitempty"` // Pool IDs
}

type storedProvider struct {
	ProviderID string   `json:"provider_id"`
	Models     []string `json:"models,omitempty"`
}

func (s stored) json() string {
	b, _ := json.Marshal(s)
	return string(b)
}

func parseStored(s string) (stored, error) {
	var v stored
	err := json.Unmarshal([]byte(s), &v)
	return v, err
}

type queryer interface {
	audit.Querier
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

const scopeHint = `Send {"all": true} for everything, or {"all": false, "providers": [{"provider": "<handle>"}, {"provider": "<handle>", "models": ["<model>"]}], "pools": ["<pool>"]}.`

// normalize validates a Scope from a request and returns its stored form.
func normalize(ctx context.Context, q queryer, in Scope) (stored, error) {
	if in.All {
		if len(in.Providers) > 0 || len(in.Pools) > 0 {
			return stored{}, api.BadRequest(scopeHint, "scope has all: true and a list of providers or pools; send one or the other.")
		}
		return stored{All: true}, nil
	}
	out := stored{Providers: []storedProvider{}}
	for _, ref := range in.Pools {
		id, err := pools.ResolveID(ctx, q, ref)
		if err != nil {
			return stored{}, err
		}
		if !slices.Contains(out.Pools, id) {
			out.Pools = append(out.Pools, id)
		}
	}
	at := map[string]int{}
	for _, p := range in.Providers {
		id, err := providers.ResolveID(ctx, q, p.Provider)
		if err != nil {
			return stored{}, err
		}
		models, err := cleanModels(p.Models)
		if err != nil {
			return stored{}, err
		}
		if i, ok := at[id]; ok { // the same Provider twice: the wider grant wins
			if out.Providers[i].Models == nil || models == nil {
				out.Providers[i].Models = nil
			} else {
				out.Providers[i].Models = dedupe(append(out.Providers[i].Models, models...))
			}
			continue
		}
		at[id] = len(out.Providers)
		out.Providers = append(out.Providers, storedProvider{ProviderID: id, Models: models})
	}
	return out, nil
}

func cleanModels(in []string) ([]string, error) {
	if len(in) == 0 {
		return nil, nil
	}
	var out []string
	for _, m := range in {
		m = strings.TrimSpace(m)
		if m == "" {
			continue
		}
		if len(m) > 256 {
			return nil, api.BadRequest("Use model names as Callers send them, at most 256 characters.", "A scope model is longer than 256 characters.")
		}
		out = append(out, m)
	}
	if len(out) == 0 {
		return nil, api.BadRequest("Omit models to allow every model of the Provider, or list at least one model.", "A scope's models list holds only blank names.")
	}
	return dedupe(out), nil
}

func dedupe(in []string) []string {
	var out []string
	for _, s := range in {
		if !slices.Contains(out, s) {
			out = append(out, s)
		}
	}
	return out
}

// view turns a stored scope into its API form, with handles.
func view(ctx context.Context, q queryer, s stored) (Scope, error) {
	out := Scope{All: s.All}
	if s.All {
		return out, nil
	}
	var idList []string
	for _, p := range s.Providers {
		idList = append(idList, p.ProviderID)
	}
	handles, err := providers.Handles(ctx, q, idList)
	if err != nil {
		return out, err
	}
	out.Providers = []ScopeProvider{}
	for _, p := range s.Providers {
		h, ok := handles[p.ProviderID]
		if !ok {
			h = p.ProviderID
		}
		out.Providers = append(out.Providers, ScopeProvider{Provider: h, Models: p.Models})
	}
	names, err := pools.Names(ctx, q, s.Pools)
	if err != nil {
		return out, err
	}
	for _, id := range s.Pools {
		if n, ok := names[id]; ok { // a deleted Pool drops out
			out.Pools = append(out.Pools, n)
		}
	}
	return out, nil
}

const keyColumns = `id, name, secret, scope, capture, created_at, revoked_at, last_used_at`

type row struct {
	GatewayKey
	scope stored
}

func scan(r interface{ Scan(...any) error }) (row, error) {
	var k row
	var scope string
	var created int64
	var revoked, used sql.NullInt64
	if err := r.Scan(&k.ID, &k.Name, &k.Secret, &scope, &k.Capture, &created, &revoked, &used); err != nil {
		return k, err
	}
	var err error
	if k.scope, err = parseStored(scope); err != nil {
		return k, err
	}
	k.CreatedAt = store.FromMillis(created)
	if revoked.Valid {
		at := store.FromMillis(revoked.Int64)
		k.RevokedAt, k.Revoked = &at, true
	}
	if used.Valid {
		at := store.FromMillis(used.Int64)
		k.LastUsedAt = &at
	}
	return k, nil
}

// byID reads one Gateway Key with its scope view and its Requests of the
// 24 hours before now; sql.ErrNoRows when absent.
func byID(ctx context.Context, q queryer, id string, now time.Time) (GatewayKey, error) {
	r, err := scan(q.QueryRowContext(ctx, `SELECT `+keyColumns+` FROM gateway_keys WHERE id = ?`, id))
	if err != nil {
		return r.GatewayKey, err
	}
	if r.GatewayKey.Scope, err = view(ctx, q, r.scope); err != nil {
		return r.GatewayKey, err
	}
	r.RecentRequests, err = countRecent(ctx, q, id, now)
	return r.GatewayKey, err
}

// Caller is an authenticated Caller: the Gateway Key it presented.
type Caller struct {
	KeyID string
	Name  string
	// Capture says the Request's prompt and response are to be stored.
	Capture bool
	scope   stored
}

// AllowsProvider reports whether the Caller may use the Provider at all.
func (c Caller) AllowsProvider(providerID string) bool {
	if c.scope.All {
		return true
	}
	return slices.ContainsFunc(c.scope.Providers, func(p storedProvider) bool { return p.ProviderID == providerID })
}

// AllowsModel reports whether the Caller may use model on the Provider.
func (c Caller) AllowsModel(providerID, model string) bool {
	if c.scope.All {
		return true
	}
	for _, p := range c.scope.Providers {
		if p.ProviderID == providerID {
			return p.Models == nil || slices.Contains(p.Models, model)
		}
	}
	return false
}

// AllowsPool reports whether the Caller may name the Pool on the global
// routes.
func (c Caller) AllowsPool(poolID string) bool {
	return c.scope.All || slices.Contains(c.scope.Pools, poolID)
}

// Unrestricted is a Caller whose scope is everything: the Owner, for
// previews that take no Gateway Key's scope.
func Unrestricted(name string) Caller { return Caller{Name: name, scope: stored{All: true}} }

// CallerOf returns the Caller a Gateway Key, addressed by name or ID, would
// be (scope included), with the uniform 404 when there is none and 409
// gateway_key_revoked for a revoked key.
func (s *Store) CallerOf(ctx context.Context, ref string) (Caller, error) {
	id, err := Resource.Resolve(ctx, s.db, ref)
	if err != nil {
		return Caller{}, err
	}
	k, err := scan(s.db.QueryRowContext(ctx, `SELECT `+keyColumns+` FROM gateway_keys WHERE id = ?`, id))
	if err != nil {
		return Caller{}, err
	}
	if k.Revoked {
		return Caller{}, api.Conflict("gateway_key_revoked", "Pick an unrevoked Gateway Key (GET /api/gateway-keys?revoked=false).",
			"The Gateway Key %q is revoked; its Requests are refused before routing.", k.Name)
	}
	return Caller{KeyID: k.ID, Name: k.Name, Capture: k.Capture, scope: k.scope}, nil
}

// SecretOf returns the secret of the unrevoked Gateway Key addressed by name
// or ID (errors as CallerOf), for the test chat's snippets sending as it.
func (s *Store) SecretOf(ctx context.Context, ref string) (string, error) {
	c, err := s.CallerOf(ctx, ref)
	if err != nil {
		return "", err
	}
	var secret string
	err = s.db.QueryRowContext(ctx, `SELECT secret FROM gateway_keys WHERE id = ?`, c.KeyID).Scan(&secret)
	return secret, err
}

// ScopeModels returns the models the Caller's scope narrows the Provider
// to, or nil when it allows every model of it (or the Provider not at all).
func (c Caller) ScopeModels(providerID string) []string {
	for _, p := range c.scope.Providers {
		if p.ProviderID == providerID {
			return slices.Clone(p.Models)
		}
	}
	return nil
}

// Store authenticates Callers.
type Store struct {
	db    *store.DB
	clock clock.Clock
}

// New returns a Store.
func New(db *store.DB) *Store { return &Store{db: db, clock: db.Clock()} }

// Credential returns the Gateway Key a request presents: "Authorization:
// Bearer", then "x-api-key", "api-key", Gemini's "x-goog-api-key", then
// Gemini's key query parameter. The Gateway builds upstream URLs from the
// Endpoint alone, so the key parameter is never forwarded either.
func Credential(r *http.Request) string {
	if t := api.BearerToken(r); t != "" {
		return t
	}
	for _, h := range []string{"x-api-key", "api-key", "x-goog-api-key"} {
		if v := strings.TrimSpace(r.Header.Get(h)); v != "" {
			return v
		}
	}
	return strings.TrimSpace(r.URL.Query().Get("key"))
}

// CredentialHeaders are the request headers that may carry a Caller's
// credential; the Gateway never forwards them.
var CredentialHeaders = []string{"authorization", "x-api-key", "api-key", "x-goog-api-key"}

const lastUsedGranularity = time.Minute

var errInvalid = &api.Error{
	Status: http.StatusUnauthorized, Code: "gateway_key_invalid",
	Message: "The Gateway Key is not valid.",
	Hint:    "Check that you copied the whole Gateway Key (it starts with " + SecretPrefix + "_); ask the Owner for a new one if yours was revoked.",
}

// Authenticate identifies the Caller of r. Unknown and revoked keys get the
// same answer.
func (s *Store) Authenticate(r *http.Request) (Caller, *api.Error) {
	secret := Credential(r)
	if secret == "" {
		return Caller{}, &api.Error{
			Status: http.StatusUnauthorized, Code: "gateway_key_missing",
			Message: "This route needs a Gateway Key.",
			Hint:    "Send your Gateway Key as \"Authorization: Bearer <key>\" (or in an x-api-key, api-key or x-goog-api-key header, or Gemini's ?key= parameter).",
		}
	}
	k, err := scan(s.db.QueryRowContext(r.Context(), `SELECT `+keyColumns+` FROM gateway_keys WHERE secret = ?`, secret))
	if errors.Is(err, sql.ErrNoRows) || err == nil && k.Revoked {
		return Caller{}, errInvalid
	}
	if err != nil {
		return Caller{}, api.AsError(err)
	}
	now := s.clock.Now()
	if k.LastUsedAt == nil || now.Sub(*k.LastUsedAt) >= lastUsedGranularity {
		_, _ = s.db.ExecContext(r.Context(), `UPDATE gateway_keys SET last_used_at = ? WHERE id = ?`, store.Millis(now), k.ID)
	}
	return Caller{KeyID: k.ID, Name: k.Name, Capture: k.Capture, scope: k.scope}, nil
}
