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
	"github.com/hoangvu12/iroha/internal/caching"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/logos"
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
	Budget           Budget     `json:"budget" doc:"The Request budget for this Provider."`
	Strict           bool       `json:"strict" doc:"true: a model missing from the Provider's model list (GET /api/providers/{provider}/models) is refused before any Attempt. false: it is forwarded anyway."`
	Discovery        string     `json:"discovery" enum:"none,provider,key" doc:"How the model list is discovered: provider (once per Endpoint, with one key), key (per key and Endpoint; keys whose list names a model are tried first for it) or none."`
	ModelsDevBrand   string     `json:"models_dev_brand" doc:"The models.dev provider ID model metadata is looked up under; \"\": none (by model name in models.dev's maker catalog only)."`
	LogoDomain       string     `json:"logo_domain" doc:"The site whose logo the UI shows for this Provider (GET /api/providers/{provider}/logo): the Owner's, else guessed from the first Endpoint's host; \"\" when there is none (the UI draws the first letter)."`
	LogoGuessed      bool       `json:"logo_domain_guessed" doc:"true when logo_domain is a guess (the Owner set none)."`
	Affinity         string     `json:"affinity" enum:"on,off" doc:"on: the turns of one conversation go to one Upstream Key (so its prompt cache stays warm), moving to the conversation's next key only while that key cannot serve; off: keys are used in turn."`
	Endpoints        []Endpoint `json:"endpoints"`
	UpstreamKeyCount int        `json:"upstream_key_count"`
}

// Budget is a Provider's Request budget.
type Budget struct {
	MaxAttempts      int  `json:"max_attempts" doc:"Attempts per Request at most."`
	FirstByteSeconds int  `json:"first_byte_seconds" doc:"Seconds a Request may wait for the first upstream byte, across its Attempts."`
	Overridden       bool `json:"overridden" doc:"true when either value is this Provider's own rather than the default."`
}

// Request budget defaults and limits (spec "Request handling").
const (
	DefaultMaxAttempts = 3
	MaxAttemptsLimit   = 10
	DefaultFirstByte   = 60 * time.Second
	// FirstByteCeiling is the hard ceiling of any Request's wait for a first
	// byte, kept under the 100 s edge cutoff in front of Iroha.
	FirstByteCeiling = 95 * time.Second
)

// EffectiveBudget applies the defaults to a Provider's overrides (0 = default).
func EffectiveBudget(maxAttempts int, firstByte time.Duration) (int, time.Duration) {
	if maxAttempts <= 0 {
		maxAttempts = DefaultMaxAttempts
	}
	if firstByte <= 0 {
		firstByte = DefaultFirstByte
	}
	return maxAttempts, min(firstByte, FirstByteCeiling)
}

// Endpoint is an Endpoint as the API returns it.
type Endpoint struct {
	ID            string            `json:"id"`
	Provider      string            `json:"provider" doc:"Handle of the Provider."`
	Name          string            `json:"name"`
	URL           string            `json:"url" doc:"Base URL including the version path; Iroha appends the operation path such as /chat/completions."`
	Shape         string            `json:"shape" enum:"openai-chat,openai-responses,anthropic-messages,gemini" doc:"The API format the URL speaks."`
	AuthStyle     string            `json:"auth_style" enum:"bearer,x-api-key,header,query,none" doc:"How the Upstream Key is sent: Authorization: Bearer, an x-api-key header, the header named auth_param, the query parameter named auth_param, or not at all. A key with an empty secret sends nothing in any style."`
	AuthParam     string            `json:"auth_param,omitempty" doc:"Header name (auth_style header) or query parameter name (auth_style query)."`
	StaticHeaders map[string]string `json:"static_headers" doc:"Headers sent on every Attempt to this Endpoint; they replace a Caller header of the same name. An empty value sends no such header."`
	Renames       map[string]string `json:"renames" doc:"Model renames: the model a Caller names -> the model this URL is sent. Applied per Attempt, after the Endpoint is chosen."`
	DiscoveryURL  string            `json:"discovery_url" doc:"Where this Endpoint's model list is read: empty for <url>/models, \"none\" to never ask it, or a URL."`
	caching.Settings
	Caching   EndpointCaching `json:"caching" doc:"What requests translated to this Endpoint get for the Provider's prompt cache, from the two settings above, its Shape and host. Read-only."`
	CreatedAt time.Time       `json:"created_at"`
}

// EndpointCaching is the effect of an Endpoint's caching settings.
type EndpointCaching struct {
	Markers        string `json:"markers" enum:",strip,keep,blocks,top_level,top_only" doc:"\"\": as RelayKit converts (no markers toward Anthropic; toward OpenAI Chat an Anthropic Caller's message markers but not its system prompt's); strip: none; keep: the Caller's own; blocks: the Caller's, else the last tool, system block and message; top_level: the Caller's, else Anthropic's automatic top-level marker; top_only: one top-level marker."`
	PromptCacheKey bool   `json:"prompt_cache_key" doc:"A prompt_cache_key derived from the conversation is sent when the request has none."`
	Summary        string `json:"summary" doc:"The same in a sentence."`
}

// endpointCaching is the effect of e's caching settings.
func endpointCaching(e Endpoint) EndpointCaching {
	p := caching.For(shape.Shape(e.Shape), e.URL, e.Settings)
	return EndpointCaching{Markers: string(p.Markers), PromptCacheKey: p.PromptCacheKey, Summary: p.Describe(shape.Shape(e.Shape))}
}

// Discovery modes of a Provider.
const (
	DiscoveryNone     = "none"
	DiscoveryProvider = "provider"
	DiscoveryKey      = "key"
)

// Affinity settings of a Provider.
const (
	AffinityOn  = "on"
	AffinityOff = "off"
)

// NoDiscovery is the discovery_url of an Endpoint that is never asked for models.
const NoDiscovery = "none"

// UpstreamKey is an Upstream Key as the API returns it, secret included.
type UpstreamKey struct {
	ID            string                     `json:"id"`
	Provider      string                     `json:"provider" doc:"Handle of the Provider."`
	Name          string                     `json:"name"`
	Secret        string                     `json:"secret" doc:"The key itself; empty for a keyless slot (no auth header is sent)."`
	Enabled       bool                       `json:"enabled" doc:"false: the Owner disabled the key; its state is disabled."`
	State         keystate.State             `json:"state" doc:"The key's one Key State and why it is in it."`
	CoolingModels []keystate.ModelCooling    `json:"cooling_models" doc:"Models this key is cooling for while it serves the others."`
	ModelGaps     []keystate.ModelGap        `json:"model_gaps" doc:"Models the Provider refused this key; they are not sent to it until each gap expires or is cleared. The key's Key State is unaffected."`
	Endpoints     []string                   `json:"endpoints" doc:"Names of the Endpoints this key is restricted to; empty: every Endpoint of the Provider."`
	EndpointGaps  []keystate.EndpointGap     `json:"endpoint_gaps" doc:"Endpoints the Provider refused this key on (as invalid) after it had worked on another: it is not sent to them until each gap is cleared, and keeps serving its other Endpoints. The key's Key State is unaffected."`
	WorkedOn      []keystate.EndpointSuccess `json:"worked_on" doc:"Endpoints this key has worked on (a 2xx Attempt or a passing key test), with the latest time. An invalid refusal elsewhere makes an Endpoint Gap only while one of these remains usable."`
	CreatedAt     time.Time                  `json:"created_at"`
	LastUsedAt    *time.Time                 `json:"last_used_at,omitempty" doc:"Last Attempt with this key, to the minute; absent when never used."`
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
	case h == "pools":
		return api.BadRequest("Pick another handle; \"pools\" is a word of the UI's paths (/providers/pools/<pool>).", "handle %q is reserved.", h)
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
	var maxAttempts, firstByte int
	var logo string
	err := q.QueryRowContext(ctx, `SELECT id, handle, name, enabled, archived, created_at, max_attempts, first_byte_seconds, strict, discovery, models_dev_brand, logo_domain,
		(SELECT count(*) FROM upstream_keys k WHERE k.provider_id = providers.id), affinity
		FROM providers WHERE id = ?`, id).
		Scan(&p.ID, &p.Handle, &p.Name, &p.Enabled, &p.Archived, &created, &maxAttempts, &firstByte, &p.Strict, &p.Discovery, &p.ModelsDevBrand, &logo, &p.UpstreamKeyCount, &p.Affinity)
	if err != nil {
		return p, err
	}
	n, d := EffectiveBudget(maxAttempts, time.Duration(firstByte)*time.Second)
	p.Budget = Budget{MaxAttempts: n, FirstByteSeconds: int(d / time.Second), Overridden: maxAttempts > 0 || firstByte > 0}
	p.CreatedAt = store.FromMillis(created)
	p.CallerPath = "/providers/" + p.Handle + "/v1"
	p.Endpoints, err = listEndpoints(ctx, q, id)
	p.LogoDomain, p.LogoGuessed = effectiveLogo(logo, p.Endpoints)
	return p, err
}

// NoLogo is the logo_domain of a Provider shown with its first letter only.
const NoLogo = "none"

// effectiveLogo is the logo domain shown for a Provider: the Owner's, else
// the site of its first Endpoint.
func effectiveLogo(owner string, eps []Endpoint) (string, bool) {
	switch owner {
	case NoLogo:
		return "", false
	case "":
		for _, e := range eps {
			if d := logos.SiteOf(e.URL); d != "" {
				return d, true
			}
		}
		return "", false
	}
	return owner, false
}

// LogoDomain is the logo domain of the Provider addressed by handle or ID
// (with the uniform 404 when there is none); "" when it has none.
func LogoDomain(ctx context.Context, db *store.DB, ref string) (string, error) {
	id, err := Resource.Resolve(ctx, db, ref)
	if err != nil {
		return "", err
	}
	p, err := readProvider(ctx, db, id)
	return p.LogoDomain, err
}

const endpointColumns = `e.id, p.handle, e.name, e.url, e.shape, e.auth_style, e.auth_param, e.static_headers, e.renames, e.discovery_url, e.cache_markers, e.send_prompt_cache_key, e.created_at`

func scanEndpoint(row interface{ Scan(...any) error }) (Endpoint, error) {
	var e Endpoint
	var created int64
	var headers, renames string
	if err := row.Scan(&e.ID, &e.Provider, &e.Name, &e.URL, &e.Shape, &e.AuthStyle, &e.AuthParam, &headers, &renames, &e.DiscoveryURL, &e.CacheMarkers, &e.SendPromptCacheKey, &created); err != nil {
		return e, err
	}
	e.CreatedAt = store.FromMillis(created)
	e.Caching = endpointCaching(e)
	var err error
	if e.StaticHeaders, err = decodeMap(headers); err != nil {
		return e, fmt.Errorf("endpoint %s static_headers: %w", e.ID, err)
	}
	if e.Renames, err = decodeMap(renames); err != nil {
		return e, fmt.Errorf("endpoint %s renames: %w", e.ID, err)
	}
	return e, nil
}

// decodeMap reads a stored JSON object of strings; never nil.
func decodeMap(s string) (map[string]string, error) {
	m := map[string]string{}
	if s == "" {
		return m, nil
	}
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, err
	}
	if m == nil {
		m = map[string]string{}
	}
	return m, nil
}

// encodeMap is the stored form of a map of strings ("{}" when empty).
func encodeMap(m map[string]string) string {
	if len(m) == 0 {
		return "{}"
	}
	b, _ := json.Marshal(m)
	return string(b)
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

const keyColumns = `k.id, p.handle, k.name, k.secret, k.created_at, k.last_used_at, k.disabled, k.disabled_by, k.disabled_at`

// scanKey reads a key row; its Key State is filled in by withState.
func scanKey(row interface{ Scan(...any) error }) (UpstreamKey, *keystate.OwnerDisabled, error) {
	var k UpstreamKey
	var created int64
	var used, disabledAt sql.NullInt64
	var disabled bool
	var disabledBy string
	err := row.Scan(&k.ID, &k.Provider, &k.Name, &k.Secret, &created, &used, &disabled, &disabledBy, &disabledAt)
	k.CreatedAt = store.FromMillis(created)
	if used.Valid {
		at := store.FromMillis(used.Int64)
		k.LastUsedAt = &at
	}
	k.Enabled = !disabled
	if disabled {
		return k, &keystate.OwnerDisabled{By: disabledBy, At: store.NullMillis(disabledAt)}, err
	}
	return k, nil, err
}

// withState sets the visible Key State of k from its record at now.
func withState(k UpstreamKey, d *keystate.OwnerDisabled, rec keystate.Record, now time.Time) UpstreamKey {
	k.State, k.CoolingModels = keystate.View(d, rec, now)
	k.ModelGaps = rec.LiveGaps(now)
	k.EndpointGaps, k.WorkedOn = rec.EndpointGaps, rec.Worked
	if k.EndpointGaps == nil {
		k.EndpointGaps = []keystate.EndpointGap{}
	}
	if k.WorkedOn == nil {
		k.WorkedOn = []keystate.EndpointSuccess{}
	}
	return k
}

func readKey(ctx context.Context, q queryer, id string, at time.Time) (UpstreamKey, error) {
	k, d, err := scanKey(q.QueryRowContext(ctx, `SELECT `+keyColumns+` FROM upstream_keys k JOIN providers p ON p.id = k.provider_id WHERE k.id = ?`, id))
	if err != nil {
		return k, err
	}
	rec, err := keystate.ForKey(ctx, q, id)
	if err != nil {
		return k, err
	}
	if k.Endpoints, err = keyEndpointNames(ctx, q, id); err != nil {
		return k, err
	}
	return withState(k, d, rec, at), nil
}

// listKeys reads every key of a Provider with its Key State.
func listKeys(ctx context.Context, q queryer, providerID string, at time.Time) ([]UpstreamKey, error) {
	rows, err := q.QueryContext(ctx, `SELECT `+keyColumns+` FROM upstream_keys k JOIN providers p ON p.id = k.provider_id
		WHERE k.provider_id = ? ORDER BY k.created_at, k.rowid`, providerID)
	if err != nil {
		return nil, err
	}
	type item struct {
		k UpstreamKey
		d *keystate.OwnerDisabled
	}
	var items []item
	for rows.Next() {
		k, d, err := scanKey(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, item{k, d})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	recs, err := keystate.ForProvider(ctx, q, providerID)
	if err != nil {
		return nil, err
	}
	names, err := keyEndpointNamesByKey(ctx, q, providerID)
	if err != nil {
		return nil, err
	}
	out := make([]UpstreamKey, 0, len(items))
	for _, it := range items {
		it.k.Endpoints = names[it.k.ID]
		if it.k.Endpoints == nil {
			it.k.Endpoints = []string{}
		}
		out = append(out, withState(it.k, it.d, recs[it.k.ID], at))
	}
	return out, nil
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
	// Model list configuration (ticket 10): Strict refuses unlisted models,
	// Discovery is the mode, DiscoveryURLs maps Endpoint IDs to their
	// discovery_url as configured ("" default, NoDiscovery, or a URL).
	Strict        bool
	Discovery     string
	DiscoveryURLs map[string]string
}

// Routing reads the Provider with this handle for planning. ok is false
// when no Provider has the handle (or the handle is not valid).
func (s *Store) Routing(ctx context.Context, handle string) (r Routing, ok bool, err error) {
	if CheckHandle(handle) != nil {
		return r, false, nil
	}
	var firstByte int
	var aff string
	err = s.db.QueryRowContext(ctx, `SELECT id, handle, enabled, archived, max_attempts, first_byte_seconds, strict, discovery, affinity FROM providers WHERE handle = ?`, handle).
		Scan(&r.ID, &r.Handle, &r.Enabled, &r.Archived, &r.MaxAttempts, &firstByte, &r.Strict, &r.Discovery, &aff)
	r.AffinityOff = aff == AffinityOff
	if errors.Is(err, sql.ErrNoRows) {
		return r, false, nil
	}
	if err != nil {
		return r, false, err
	}
	r.FirstByte = time.Duration(firstByte) * time.Second
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, url, shape, auth_style, auth_param, static_headers, renames, discovery_url, cache_markers, send_prompt_cache_key
		FROM endpoints WHERE provider_id = ? ORDER BY created_at, rowid`, r.ID)
	if err != nil {
		return r, false, err
	}
	r.DiscoveryURLs = map[string]string{}
	for rows.Next() {
		var e planner.Endpoint
		var sh, headers, renames, discovery string
		if err := rows.Scan(&e.ID, &e.Name, &e.URL, &sh, &e.AuthStyle, &e.AuthParam, &headers, &renames, &discovery, &e.Caching.CacheMarkers, &e.Caching.SendPromptCacheKey); err != nil {
			rows.Close()
			return r, false, err
		}
		r.DiscoveryURLs[e.ID] = discovery
		e.Shape = shape.Shape(sh)
		var err error
		if e.StaticHeaders, err = decodeMap(headers); err != nil {
			rows.Close()
			return r, false, fmt.Errorf("endpoint %s static_headers: %w", e.ID, err)
		}
		if e.Renames, err = decodeMap(renames); err != nil {
			rows.Close()
			return r, false, fmt.Errorf("endpoint %s renames: %w", e.ID, err)
		}
		r.Endpoints = append(r.Endpoints, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return r, false, err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT id, name, secret, disabled FROM upstream_keys WHERE provider_id = ? ORDER BY created_at, rowid`, r.ID)
	if err != nil {
		return r, false, err
	}
	for rows.Next() {
		var k planner.Key
		if err := rows.Scan(&k.ID, &k.Name, &k.Secret, &k.Disabled); err != nil {
			rows.Close()
			return r, false, err
		}
		r.Keys = append(r.Keys, k)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return r, false, err
	}
	restricted, err := keyEndpointIDs(ctx, s.db, r.ID)
	if err != nil {
		return r, false, err
	}
	recs, err := keystate.ForProvider(ctx, s.db, r.ID)
	if err != nil {
		return r, false, err
	}
	for i := range r.Keys {
		k := &r.Keys[i]
		k.Endpoints = restricted[k.ID]
		rec, ok := recs[k.ID]
		if !ok {
			continue
		}
		k.Invalid = rec.Invalid()
		if rec.Key != nil && rec.Key.State == keystate.Cooling {
			k.CoolingUntil = rec.Key.Until
		}
		for _, m := range rec.Models {
			if k.ModelCooling == nil {
				k.ModelCooling = map[string]time.Time{}
			}
			k.ModelCooling[m.Model] = m.Until
		}
		k.ModelGaps = rec.GapsByModel()
		k.EndpointGaps, k.WorkedOn = rec.EndpointGapSet(), rec.WorkedOn()
	}
	return r, true, nil
}

// ResolveRouting reads the routing view of the Provider addressed by handle
// or ID, with the uniform 404 when there is none.
func (s *Store) ResolveRouting(ctx context.Context, ref string) (Routing, error) {
	p, err := resolveProvider(ctx, s.db, ref)
	if err != nil {
		return Routing{}, err
	}
	r, _, err := s.Routing(ctx, p.handle)
	return r, err
}

// ResolveKey finds the Upstream Key addressed by name or ID in a routing
// view, with the uniform 404 when there is none.
func (s *Store) ResolveKey(ctx context.Context, r *Routing, keyRef string) (*planner.Key, error) {
	id, err := resolveChild(ctx, s.db, "upstream_keys", "Upstream Key", "keys", ref{id: r.ID, handle: r.Handle}, keyRef)
	if err != nil {
		return nil, err
	}
	for i := range r.Keys {
		if r.Keys[i].ID == id {
			return &r.Keys[i], nil
		}
	}
	return nil, fmt.Errorf("upstream key %s vanished while it was read", id)
}

// KeyState is the visible Key State of key id now.
func (s *Store) KeyState(ctx context.Context, id string) (keystate.State, error) {
	k, err := readKey(ctx, s.db, id, s.clock.Now())
	return k.State, err
}

// MarkKeyUsed records that an Attempt used Upstream Key id (at most once a
// minute per key).
func (s *Store) MarkKeyUsed(ctx context.Context, id string) error {
	return s.db.Touch(ctx, "upstream_keys", "last_used_at", id, nil, s.clock.Now(), store.TouchEvery)
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
