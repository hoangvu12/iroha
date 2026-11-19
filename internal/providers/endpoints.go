package providers

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
)

// endpointSnapshot is what an Audit Entry records of an Endpoint. Provider
// (the handle) is shown in the entry and ignored by Restore. Entries written
// before ticket 09 lack the auth and rename fields; their zero values mean
// bearer auth, no static headers and no renames.
type endpointSnapshot struct {
	ID            string            `json:"id"`
	ProviderID    string            `json:"provider_id"`
	Provider      string            `json:"provider"`
	Name          string            `json:"name"`
	URL           string            `json:"url"`
	Shape         string            `json:"shape"`
	AuthStyle     string            `json:"auth_style,omitempty"`
	AuthParam     string            `json:"auth_param,omitempty"`
	StaticHeaders map[string]string `json:"static_headers,omitempty"`
	Renames       map[string]string `json:"renames,omitempty"`
	DiscoveryURL  string            `json:"discovery_url,omitempty"` // ticket 10; empty is the default
	CreatedAt     time.Time         `json:"created_at"`
}

// EndpointResource is the Endpoint resource of the audit machinery.
var EndpointResource = audit.Register(&audit.Resource[endpointSnapshot]{
	Name: "endpoint", Label: "Endpoint", Plural: "Endpoints", Path: "/api/providers/{provider}/endpoints",
	Table:  "endpoints",
	NameOf: func(s endpointSnapshot) string { return s.Provider + "/" + s.Name },
	Load: func(ctx context.Context, q audit.Querier, id string) (*endpointSnapshot, error) {
		var s endpointSnapshot
		var created int64
		var headers, renames string
		err := q.QueryRowContext(ctx, `SELECT e.id, e.provider_id, p.handle, e.name, e.url, e.shape, e.auth_style, e.auth_param, e.static_headers, e.renames, e.discovery_url, e.created_at
			FROM endpoints e JOIN providers p ON p.id = e.provider_id WHERE e.id = ?`, id).
			Scan(&s.ID, &s.ProviderID, &s.Provider, &s.Name, &s.URL, &s.Shape, &s.AuthStyle, &s.AuthParam, &headers, &renames, &s.DiscoveryURL, &created)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		s.CreatedAt = store.FromMillis(created)
		if s.StaticHeaders, err = decodeMap(headers); err != nil {
			return nil, err
		}
		if s.Renames, err = decodeMap(renames); err != nil {
			return nil, err
		}
		return &s, nil
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *endpointSnapshot) error {
		if s == nil {
			var keys string
			if err := tx.QueryRowContext(ctx, `SELECT coalesce(group_concat(k.name, ', '), '') FROM upstream_key_endpoints ke
				JOIN upstream_keys k ON k.id = ke.key_id WHERE ke.endpoint_id = ?`, id).Scan(&keys); err != nil {
				return err
			}
			if keys != "" {
				return api.Conflict("endpoint_in_use", "Lift those keys' restriction to this Endpoint first (PATCH .../keys/<key> {\"endpoints\": [...]}), then retry.",
					"Upstream Keys %s are restricted to this Endpoint.", keys)
			}
			_, err := tx.ExecContext(ctx, `DELETE FROM endpoints WHERE id = ?`, id)
			return err
		}
		if err := childNameFree(ctx, tx, "endpoints", "Endpoint", s.ProviderID, s.Name, id); err != nil {
			return err
		}
		if err := endpointURLFree(ctx, tx, s.ProviderID, s.Provider, s.URL, s.Shape, id); err != nil {
			return err
		}
		style := s.AuthStyle
		if style == "" {
			style = string(planner.AuthBearer)
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO endpoints (id, provider_id, name, url, shape, auth_style, auth_param, static_headers, renames, discovery_url, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, url = excluded.url, shape = excluded.shape, auth_style = excluded.auth_style,
			auth_param = excluded.auth_param, static_headers = excluded.static_headers, renames = excluded.renames, discovery_url = excluded.discovery_url`,
			id, s.ProviderID, s.Name, s.URL, s.Shape, style, s.AuthParam, encodeMap(s.StaticHeaders), encodeMap(s.Renames), s.DiscoveryURL, store.Millis(s.CreatedAt))
		return err
	},
})

// childNameFree refuses a name used by another record of the same Provider.
func childNameFree(ctx context.Context, q audit.Querier, table, label, providerID, name, id string) error {
	var other string
	err := q.QueryRowContext(ctx, `SELECT id FROM `+table+` WHERE provider_id = ? AND name = ? AND id != ?`, providerID, name, id).Scan(&other)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return api.Conflict("name_taken", "Pick another name, or rename that "+label+" first.",
		"Another %s of this Provider (%s) is already named %q.", label, other, name)
}

// findEndpointURL gives the ID and name of the Endpoint of the Provider that
// has url and shape, other than id ("" when none). URLs compare as checkURL
// leaves them, scheme and host case-insensitively.
func findEndpointURL(ctx context.Context, q *sql.Tx, providerID, u, sh, id string) (string, string, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, name, url FROM endpoints WHERE provider_id = ? AND shape = ? AND id != ?`, providerID, sh, id)
	if err != nil {
		return "", "", err
	}
	defer rows.Close()
	want := sameURLKey(u)
	for rows.Next() {
		var otherID, name, other string
		if err := rows.Scan(&otherID, &name, &other); err != nil {
			return "", "", err
		}
		if sameURLKey(other) == want {
			return otherID, name, nil
		}
	}
	return "", "", rows.Err()
}

// sameURLKey is an Endpoint URL in the form duplicates are compared in.
func sameURLKey(u string) string {
	if c, err := checkURL(u); err == nil {
		return c
	}
	return u
}

// endpointURLFree refuses a URL and Shape another Endpoint of the Provider
// already has (SCR-11): keys would rotate over the same URL twice.
func endpointURLFree(ctx context.Context, q *sql.Tx, providerID, handle, u, sh, id string) error {
	_, name, err := findEndpointURL(ctx, q, providerID, u, sh, id)
	if err != nil || name == "" {
		return err
	}
	return api.Conflict("endpoint_duplicate",
		fmt.Sprintf("Address that Endpoint as %s (PATCH /api/providers/%s/endpoints/%s) instead of adding the URL again, or rename it there.", name, handle, name),
		"Endpoint %q of Provider %s already sends %s to %s.", name, handle, sh, u)
}

// CreateEndpoint is the body of POST /api/providers/{provider}/endpoints.
type CreateEndpoint struct {
	Name          string             `json:"name,omitempty" doc:"Unique within the Provider. Repeating a create with an existing name updates that Endpoint. Without a name, the Endpoint with the same url and shape is updated, else the name is \"default\"."`
	URL           *string            `json:"url,omitempty" doc:"Base URL including the version path, e.g. https://api.openai.com/v1 (Iroha appends /chat/completions). Required for a new Endpoint."`
	Shape         *string            `json:"shape,omitempty" enum:"openai-chat,openai-responses,anthropic-messages,gemini" doc:"The API format the URL speaks. Required for a new Endpoint."`
	AuthStyle     *string            `json:"auth_style,omitempty" enum:"bearer,x-api-key,header,query,none" doc:"How the Upstream Key is sent; default bearer. none sends no credential; on a Provider holding no Upstream Keys it also adds the keyless key \"keyless\" (see keyless_key)."`
	AuthParam     *string            `json:"auth_param,omitempty" doc:"The header name for auth_style header (e.g. api-key) or the query parameter name for auth_style query (e.g. key)."`
	StaticHeaders *map[string]string `json:"static_headers,omitempty" doc:"Headers sent on every Attempt, e.g. {\"HTTP-Referer\": \"https://example.com\"}. An empty value sends no such header and drops the Caller's. Replaces the whole set; {} clears it."`
	Renames       *map[string]string `json:"renames,omitempty" doc:"Model renames for this URL, Caller's name -> wire name, e.g. {\"glm-4.6\": \"glm-4.6-fp8\"}. Replaces the whole set; {} clears it."`
	DiscoveryURL  *string            `json:"discovery_url,omitempty" doc:"Where the model list is read: \"\" (default) for <url>/models, \"none\" to never ask this Endpoint, or a full http(s) URL such as https://api.acme.example/api/coding/v4/models."`
}

// UpdateEndpoint is the body of PATCH /api/providers/{provider}/endpoints/{endpoint}.
type UpdateEndpoint struct {
	Name          *string            `json:"name,omitempty"`
	URL           *string            `json:"url,omitempty"`
	Shape         *string            `json:"shape,omitempty" enum:"openai-chat,openai-responses,anthropic-messages,gemini"`
	AuthStyle     *string            `json:"auth_style,omitempty" enum:"bearer,x-api-key,header,query,none" doc:"Changing to a style without a parameter clears auth_param. Changing to none on a Provider holding no Upstream Keys adds the keyless key \"keyless\" (see keyless_key)."`
	AuthParam     *string            `json:"auth_param,omitempty"`
	StaticHeaders *map[string]string `json:"static_headers,omitempty" doc:"Replaces the whole set; {} clears it."`
	Renames       *map[string]string `json:"renames,omitempty" doc:"Replaces the whole set; {} clears it."`
	DiscoveryURL  *string            `json:"discovery_url,omitempty" doc:"\"\" for <url>/models, \"none\" for no discovery, or a URL."`
}

// EndpointResult is the response of a single Endpoint change.
type EndpointResult struct {
	audit.Result
	Endpoint   Endpoint     `json:"endpoint" doc:"The Endpoint after the change (before it, for a delete)."`
	KeylessKey *UpstreamKey `json:"keyless_key,omitempty" doc:"The keyless Upstream Key added with this change: an Endpoint with auth_style none on a Provider that held no Upstream Keys gets one, in the same Audit Entry, so the Provider serves at once."`
}

// KeylessKeyName is the name of the keyless Upstream Key Iroha adds itself.
const KeylessKeyName = "keyless"

// addKeylessKey gives a Provider holding no Upstream Keys one keyless key
// when e needs no auth (auth style none), so a keyless Provider serves with
// no key added by hand (ticket 41). It is an ordinary key, tracked in the
// same mutation: it has a Key State and Model Gaps like any other, and a
// revert of the change removes it. nil when nothing was added.
func addKeylessKey(m *audit.Mutation, p ref, e Endpoint) (*UpstreamKey, error) {
	if planner.AuthStyle(e.AuthStyle) != planner.AuthNone {
		return nil, nil
	}
	var n int
	if err := m.Tx.QueryRowContext(m.Ctx, `SELECT count(*) FROM upstream_keys WHERE provider_id = ?`, p.id).Scan(&n); err != nil || n > 0 {
		return nil, err
	}
	id := ids.New("uk")
	if err := m.Track(KeyResource, id); err != nil {
		return nil, err
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO upstream_keys (id, provider_id, name, secret, created_at) VALUES (?, ?, ?, '', ?)`,
		id, p.id, KeylessKeyName, store.Millis(m.Now)); err != nil {
		return nil, err
	}
	k, err := readKey(m.Ctx, m.Tx, id, m.Now)
	return &k, err
}

// EndpointList is the response of GET /api/providers/{provider}/endpoints.
type EndpointList struct {
	Endpoints []Endpoint `json:"endpoints"`
}

const urlHint = "Send the base URL with its version path, e.g. https://api.openai.com/v1, using http or https, without user:password, query or fragment."

// checkURL validates an Endpoint URL and returns it without trailing slashes.
func checkURL(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", api.BadRequest(urlHint, "url is required.")
	}
	if len(s) > 2048 {
		return "", api.BadRequest(urlHint, "url is longer than 2048 characters.")
	}
	u, err := url.Parse(s)
	switch {
	case err != nil:
		return "", api.BadRequest(urlHint, "url does not parse.")
	case u.Scheme != "http" && u.Scheme != "https":
		return "", api.BadRequest(urlHint, "url must start with http:// or https://.")
	case u.Host == "":
		return "", api.BadRequest(urlHint, "url has no host.")
	case u.User != nil:
		return "", api.BadRequest(urlHint, "url must not contain user:password; add the secret as an Upstream Key.")
	case u.RawQuery != "" || u.Fragment != "":
		return "", api.BadRequest(urlHint, "url must not contain a query or fragment; use auth_style query for a key in the URL, static_headers for anything else.")
	}
	// Scheme and host are case-insensitive: keep them lowercase so one URL
	// has one spelling (no user:password, so the host follows "://").
	n := len(u.Scheme) + len("://") + len(u.Host)
	if len(s) >= n && strings.EqualFold(s[:n], u.Scheme+"://"+u.Host) {
		s = strings.ToLower(s[:n]) + s[n:]
	}
	return strings.TrimRight(s, "/"), nil
}

func checkShape(s string) error {
	if !shape.Shape(s).Valid() {
		return api.BadRequest("Use one of openai-chat, openai-responses, anthropic-messages or gemini.", "shape %q is not a known Shape.", s)
	}
	return nil
}

var (
	headerNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	queryParamPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,128}$`)
)

// reservedHeaders are headers Iroha's HTTP client owns; an Endpoint may not set them.
var reservedHeaders = map[string]bool{
	"host": true, "content-length": true, "transfer-encoding": true, "connection": true, "keep-alive": true,
	"te": true, "trailer": true, "upgrade": true, "proxy-connection": true, "expect": true,
}

const (
	maxStaticHeaders = 32
	maxRenames       = 1000
)

// checkEndpoint validates the auth, static header and rename configuration
// of an Endpoint as a whole.
func checkEndpoint(e *Endpoint) error {
	styleHint := "Use auth_style bearer, x-api-key, header (with auth_param naming the header), query (with auth_param naming the query parameter) or none."
	switch planner.AuthStyle(e.AuthStyle) {
	case planner.AuthBearer, planner.AuthXAPIKey, planner.AuthNone:
		if e.AuthParam != "" {
			return api.BadRequest(styleHint, "auth_param is only used with auth_style header or query.")
		}
	case planner.AuthHeader:
		if !headerNamePattern.MatchString(e.AuthParam) {
			return api.BadRequest("Send auth_param: the header the key goes in, 1 to 128 letters, digits, '-' or '_', e.g. api-key.", "auth_param %q is not a header name.", e.AuthParam)
		}
		if reservedHeaders[strings.ToLower(e.AuthParam)] {
			return api.BadRequest("Pick the header the Provider reads the key from.", "auth_param %q is a header Iroha's HTTP client sets.", e.AuthParam)
		}
	case planner.AuthQuery:
		if !queryParamPattern.MatchString(e.AuthParam) {
			return api.BadRequest("Send auth_param: the query parameter the key goes in, 1 to 128 letters, digits, '.', '-' or '_', e.g. key.", "auth_param %q is not a query parameter name.", e.AuthParam)
		}
	default:
		return api.BadRequest(styleHint, "auth_style %q is not known.", e.AuthStyle)
	}

	if len(e.StaticHeaders) > maxStaticHeaders {
		return api.BadRequest("Send at most 32 static headers.", "static_headers has %d headers.", len(e.StaticHeaders))
	}
	slot, _ := planner.AuthStyle(e.AuthStyle).Slot(e.AuthParam) // "" for query and none
	seen := map[string]string{}
	for k, v := range e.StaticHeaders {
		lk := strings.ToLower(k)
		switch {
		case !headerNamePattern.MatchString(k):
			return api.BadRequest("Header names are 1 to 128 letters, digits, '-' or '_'.", "static header %q is not a header name.", k)
		case reservedHeaders[lk]:
			return api.BadRequest("Leave transport headers to Iroha.", "static header %q is a header Iroha's HTTP client sets.", k)
		case slot != "" && strings.EqualFold(k, slot):
			return api.BadRequest("Put the secret in an Upstream Key; for a fixed credential use auth_style none with the header in static_headers.",
				"static header %q is where auth_style %s puts the Upstream Key.", k, e.AuthStyle)
		case seen[lk] != "":
			return api.BadRequest("Send each header once.", "static headers %q and %q are the same header.", seen[lk], k)
		case len(v) > 4096 || strings.ContainsFunc(v, unicode.IsControl):
			return api.BadRequest("Header values are at most 4096 characters without line breaks or control characters.", "static header %q has a value that cannot be sent.", k)
		}
		seen[lk] = k
	}

	if len(e.Renames) > maxRenames {
		return api.BadRequest("Send at most 1000 renames.", "renames has %d entries.", len(e.Renames))
	}
	renameHint := "Model names in renames are 1 to 256 characters without surrounding spaces or control characters, e.g. {\"glm-4.6\": \"glm-4.6-fp8\"}."
	for from, to := range e.Renames {
		for _, s := range []string{from, to} {
			if s == "" || len(s) > 256 || strings.TrimSpace(s) != s || strings.ContainsFunc(s, unicode.IsControl) {
				return api.BadRequest(renameHint, "renames has an entry %q -> %q that is not a model name.", from, to)
			}
		}
	}
	return nil
}

func (h handlers) endpointRoutes() []api.Route {
	const tag = "Endpoints"
	const base = "/api/providers/{provider}/endpoints"
	return []api.Route{
		{
			Method: http.MethodGet, Path: base, Tag: tag,
			Summary:  "List a Provider's Endpoints",
			Response: EndpointList{},
			Handle: func(c *api.Call) (any, error) {
				p, err := resolveProvider(c.R.Context(), h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				list, err := listEndpoints(c.R.Context(), h.db, p.id)
				return EndpointList{Endpoints: list}, err
			},
		},
		{
			Method: http.MethodGet, Path: base + "/{endpoint}", Tag: tag,
			Summary:  "Read an Endpoint by name or ID",
			Response: Endpoint{},
			Handle: func(c *api.Call) (any, error) {
				p, err := resolveProvider(c.R.Context(), h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				id, err := resolveChild(c.R.Context(), h.db, "endpoints", "Endpoint", "endpoints", p, c.Path("endpoint"))
				if err != nil {
					return nil, err
				}
				return readEndpoint(c.R.Context(), h.db, id)
			},
		},
		{
			Method: http.MethodPost, Path: base, Tag: tag,
			Summary: "Add an Endpoint to a Provider, or update the one with that name",
			Description: "An Endpoint is one URL speaking one Shape, with its own auth style, static headers and model renames. " +
				"Callers' requests go to Endpoints speaking their Shape; Upstream Keys go to every Endpoint unless restricted to some. " +
				"For a service that needs no key, use auth_style none: a Provider holding no Upstream Keys then gets the keyless key \"keyless\" in the same Audit Entry and serves at once.",
			Query:   []api.Param{audit.DryRun},
			Request: CreateEndpoint{}, Response: EndpointResult{},
			Handle: func(c *api.Call) (any, error) {
				var in CreateEndpoint
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Endpoint
				var keyless *UpstreamKey
				res, err := h.tr.Mutate(c, "endpoint.create", "Created", func(m *audit.Mutation) error {
					p, err := resolveProvider(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					if out, err = h.upsertEndpoint(m, p, in); err != nil {
						return err
					}
					keyless, err = addKeylessKey(m, p, out)
					return err
				})
				return EndpointResult{Result: res, Endpoint: out, KeylessKey: keyless}, err
			},
		},
		{
			Method: http.MethodPost, Path: base + "/bulk", Tag: tag,
			Summary:     "Add or update many Endpoints of a Provider, each by name",
			Description: "Each item is applied or refused on its own; read failed and each item's error.",
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[CreateEndpoint]{}, Response: audit.BulkResult[Endpoint]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[CreateEndpoint]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				p, err := resolveProvider(c.R.Context(), h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "endpoint.create", "Created", in.Items, func(m *audit.Mutation, in CreateEndpoint) (Endpoint, error) {
					e, err := h.upsertEndpoint(m, p, in)
					if err == nil {
						_, err = addKeylessKey(m, p, e)
					}
					return e, err
				})
			},
		},
		{
			Method: http.MethodPatch, Path: base + "/{endpoint}", Tag: tag,
			Summary: "Change an Endpoint: name, URL, Shape, auth, static headers or renames",
			Query:   []api.Param{audit.DryRun},
			Request: UpdateEndpoint{}, Response: EndpointResult{},
			Handle: func(c *api.Call) (any, error) {
				var in UpdateEndpoint
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Endpoint
				var keyless *UpstreamKey
				res, err := h.tr.Mutate(c, "endpoint.update", "Edited", func(m *audit.Mutation) error {
					p, err := resolveProvider(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					id, err := resolveChild(m.Ctx, m.Tx, "endpoints", "Endpoint", "endpoints", p, c.Path("endpoint"))
					if err != nil {
						return err
					}
					if out, err = h.updateEndpoint(m, p, id, in); err != nil {
						return err
					}
					keyless, err = addKeylessKey(m, p, out)
					return err
				})
				return EndpointResult{Result: res, Endpoint: out, KeylessKey: keyless}, err
			},
		},
		{
			Method: http.MethodDelete, Path: base + "/{endpoint}", Tag: tag,
			Summary: "Delete an Endpoint",
			Description: "Upstream Keys restricted to it and to other Endpoints lose it from their restriction (in the same Audit Entry). " +
				"Refused with 409 endpoint_in_use while a key may use only this Endpoint. Revertible through its Audit Entry.",
			Query:    []api.Param{audit.DryRun},
			Response: EndpointResult{},
			Handle: func(c *api.Call) (any, error) {
				var out Endpoint
				res, err := h.tr.Mutate(c, "endpoint.delete", "Deleted", func(m *audit.Mutation) error {
					p, err := resolveProvider(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					id, err := resolveChild(m.Ctx, m.Tx, "endpoints", "Endpoint", "endpoints", p, c.Path("endpoint"))
					if err != nil {
						return err
					}
					if out, err = readEndpoint(m.Ctx, m.Tx, id); err != nil {
						return err
					}
					if err := m.Track(EndpointResource, id); err != nil {
						return err
					}
					if err := releaseEndpoint(m, p, id); err != nil {
						return err
					}
					_, err = m.Tx.ExecContext(m.Ctx, `DELETE FROM endpoints WHERE id = ?`, id)
					return err
				})
				return EndpointResult{Result: res, Endpoint: out}, err
			},
		},
	}
}

func (h handlers) upsertEndpoint(m *audit.Mutation, p ref, in CreateEndpoint) (Endpoint, error) {
	if in.Name == "" && in.URL != nil && in.Shape != nil {
		// Like keys by secret: without a name, the same URL and Shape is the
		// same Endpoint, so re-running a script or import never duplicates it.
		u, err := checkURL(*in.URL)
		if err != nil {
			return Endpoint{}, err
		}
		id, _, err := findEndpointURL(m.Ctx, m.Tx, p.id, u, *in.Shape, "")
		if err != nil {
			return Endpoint{}, err
		}
		if id != "" {
			return h.updateEndpoint(m, p, id, UpdateEndpoint{AuthStyle: in.AuthStyle, AuthParam: in.AuthParam, StaticHeaders: in.StaticHeaders, Renames: in.Renames, DiscoveryURL: in.DiscoveryURL})
		}
	}
	if in.Name == "" {
		in.Name = "default"
	}
	if err := api.CheckName("name", in.Name); err != nil {
		return Endpoint{}, err
	}
	upd := UpdateEndpoint{URL: in.URL, Shape: in.Shape, AuthStyle: in.AuthStyle, AuthParam: in.AuthParam, StaticHeaders: in.StaticHeaders, Renames: in.Renames, DiscoveryURL: in.DiscoveryURL}
	var id string
	err := m.Tx.QueryRowContext(m.Ctx, `SELECT id FROM endpoints WHERE provider_id = ? AND name = ?`, p.id, in.Name).Scan(&id)
	if err == nil {
		return h.updateEndpoint(m, p, id, upd)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Endpoint{}, err
	}
	if in.URL == nil {
		return Endpoint{}, api.BadRequest(urlHint, "url is required for a new Endpoint.")
	}
	if in.Shape == nil {
		return Endpoint{}, api.BadRequest("Send shape: openai-chat, openai-responses, anthropic-messages or gemini.", "shape is required for a new Endpoint.")
	}
	e := Endpoint{Name: in.Name, AuthStyle: string(planner.AuthBearer), StaticHeaders: map[string]string{}, Renames: map[string]string{}}
	if err := applyEndpoint(&e, upd); err != nil {
		return Endpoint{}, err
	}
	if err := endpointURLFree(m.Ctx, m.Tx, p.id, p.handle, e.URL, e.Shape, ""); err != nil {
		return Endpoint{}, err
	}
	id = ids.New("ep")
	if err := m.Track(EndpointResource, id); err != nil {
		return Endpoint{}, err
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO endpoints (id, provider_id, name, url, shape, auth_style, auth_param, static_headers, renames, discovery_url, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, p.id, e.Name, e.URL, e.Shape, e.AuthStyle, e.AuthParam, encodeMap(e.StaticHeaders), encodeMap(e.Renames), e.DiscoveryURL, store.Millis(m.Now)); err != nil {
		return Endpoint{}, err
	}
	return readEndpoint(m.Ctx, m.Tx, id)
}

// applyEndpoint applies the fields sent in in to e and validates the result.
func applyEndpoint(e *Endpoint, in UpdateEndpoint) error {
	if in.Name != nil {
		if err := api.CheckName("name", *in.Name); err != nil {
			return err
		}
		e.Name = *in.Name
	}
	if in.URL != nil {
		u, err := checkURL(*in.URL)
		if err != nil {
			return err
		}
		e.URL = u
	}
	if in.Shape != nil {
		if err := checkShape(*in.Shape); err != nil {
			return err
		}
		e.Shape = *in.Shape
	}
	if in.AuthStyle != nil {
		s := strings.ToLower(strings.TrimSpace(*in.AuthStyle))
		if st := planner.AuthStyle(s); s != e.AuthStyle && in.AuthParam == nil && st != planner.AuthHeader && st != planner.AuthQuery {
			e.AuthParam = "" // the new style takes no parameter
		}
		e.AuthStyle = s
	}
	if in.AuthParam != nil {
		e.AuthParam = strings.TrimSpace(*in.AuthParam)
	}
	if in.StaticHeaders != nil {
		e.StaticHeaders = *in.StaticHeaders
	}
	if in.Renames != nil {
		e.Renames = *in.Renames
	}
	if in.DiscoveryURL != nil {
		d, err := checkDiscoveryURL(*in.DiscoveryURL)
		if err != nil {
			return err
		}
		e.DiscoveryURL = d
	}
	return checkEndpoint(e)
}

// checkDiscoveryURL validates an Endpoint's discovery_url: "", "none" or an
// http(s) URL (a query is allowed, a fragment or user:password is not).
func checkDiscoveryURL(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" || strings.EqualFold(s, NoDiscovery) {
		return strings.ToLower(s), nil
	}
	hint := "Send \"\" to read <url>/models, \"none\" to never ask this Endpoint, or a full URL such as https://api.acme.example/v1/models."
	u, err := url.Parse(s)
	switch {
	case len(s) > 2048:
		return "", api.BadRequest(hint, "discovery_url is longer than 2048 characters.")
	case err != nil:
		return "", api.BadRequest(hint, "discovery_url does not parse.")
	case u.Scheme != "http" && u.Scheme != "https":
		return "", api.BadRequest(hint, "discovery_url must start with http:// or https://.")
	case u.Host == "":
		return "", api.BadRequest(hint, "discovery_url has no host.")
	case u.User != nil || u.Fragment != "":
		return "", api.BadRequest(hint, "discovery_url must not contain user:password or a fragment; the key is sent per the Endpoint's auth style.")
	}
	return s, nil
}

func (h handlers) updateEndpoint(m *audit.Mutation, p ref, id string, in UpdateEndpoint) (Endpoint, error) {
	if err := m.Track(EndpointResource, id); err != nil {
		return Endpoint{}, err
	}
	e, err := readEndpoint(m.Ctx, m.Tx, id)
	if err != nil {
		return Endpoint{}, err
	}
	if err := applyEndpoint(&e, in); err != nil {
		return Endpoint{}, err
	}
	if in.Name != nil {
		if err := childNameFree(m.Ctx, m.Tx, "endpoints", "Endpoint", p.id, e.Name, id); err != nil {
			return Endpoint{}, err
		}
	}
	if in.URL != nil || in.Shape != nil {
		if err := endpointURLFree(m.Ctx, m.Tx, p.id, p.handle, e.URL, e.Shape, id); err != nil {
			return Endpoint{}, err
		}
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE endpoints SET name = ?, url = ?, shape = ?, auth_style = ?, auth_param = ?, static_headers = ?, renames = ?, discovery_url = ? WHERE id = ?`,
		e.Name, e.URL, e.Shape, e.AuthStyle, e.AuthParam, encodeMap(e.StaticHeaders), encodeMap(e.Renames), e.DiscoveryURL, id); err != nil {
		return Endpoint{}, err
	}
	return readEndpoint(m.Ctx, m.Tx, id)
}
