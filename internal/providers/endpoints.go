package providers

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
)

// endpointSnapshot is what an Audit Entry records of an Endpoint. Provider
// (the handle) is shown in the entry and ignored by Restore.
type endpointSnapshot struct {
	ID         string    `json:"id"`
	ProviderID string    `json:"provider_id"`
	Provider   string    `json:"provider"`
	Name       string    `json:"name"`
	URL        string    `json:"url"`
	Shape      string    `json:"shape"`
	CreatedAt  time.Time `json:"created_at"`
}

// EndpointResource is the Endpoint resource of the audit machinery.
var EndpointResource = audit.Register(&audit.Resource[endpointSnapshot]{
	Name: "endpoint", Label: "Endpoint", Plural: "Endpoints", Path: "/api/providers/{provider}/endpoints",
	Table:  "endpoints",
	NameOf: func(s endpointSnapshot) string { return s.Provider + "/" + s.Name },
	Load: func(ctx context.Context, q audit.Querier, id string) (*endpointSnapshot, error) {
		var s endpointSnapshot
		var created int64
		err := q.QueryRowContext(ctx, `SELECT e.id, e.provider_id, p.handle, e.name, e.url, e.shape, e.created_at
			FROM endpoints e JOIN providers p ON p.id = e.provider_id WHERE e.id = ?`, id).
			Scan(&s.ID, &s.ProviderID, &s.Provider, &s.Name, &s.URL, &s.Shape, &created)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		s.CreatedAt = store.FromMillis(created)
		return &s, err
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *endpointSnapshot) error {
		if s == nil {
			_, err := tx.ExecContext(ctx, `DELETE FROM endpoints WHERE id = ?`, id)
			return err
		}
		if err := childNameFree(ctx, tx, "endpoints", "Endpoint", s.ProviderID, s.Name, id); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO endpoints (id, provider_id, name, url, shape, created_at) VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, url = excluded.url, shape = excluded.shape`,
			id, s.ProviderID, s.Name, s.URL, s.Shape, store.Millis(s.CreatedAt))
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

// CreateEndpoint is the body of POST /api/providers/{provider}/endpoints.
type CreateEndpoint struct {
	Name  string  `json:"name,omitempty" doc:"Unique within the Provider; default \"default\". Repeating a create with an existing name updates that Endpoint."`
	URL   *string `json:"url,omitempty" doc:"Base URL including the version path, e.g. https://api.openai.com/v1 (Iroha appends /chat/completions). Required for a new Endpoint."`
	Shape *string `json:"shape,omitempty" enum:"openai-chat,openai-responses,anthropic-messages,gemini" doc:"The API format the URL speaks. Required for a new Endpoint."`
}

// UpdateEndpoint is the body of PATCH /api/providers/{provider}/endpoints/{endpoint}.
type UpdateEndpoint struct {
	Name  *string `json:"name,omitempty"`
	URL   *string `json:"url,omitempty"`
	Shape *string `json:"shape,omitempty" enum:"openai-chat,openai-responses,anthropic-messages,gemini"`
}

// EndpointResult is the response of a single Endpoint change.
type EndpointResult struct {
	audit.Result
	Endpoint Endpoint `json:"endpoint" doc:"The Endpoint after the change (before it, for a delete)."`
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
		return "", api.BadRequest(urlHint, "url must not contain a query or fragment.")
	}
	return strings.TrimRight(s, "/"), nil
}

func checkShape(s string) error {
	if !shape.Shape(s).Valid() {
		return api.BadRequest("Use one of openai-chat, openai-responses, anthropic-messages or gemini.", "shape %q is not a known Shape.", s)
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
			Summary:     "Add an Endpoint to a Provider, or update the one with that name",
			Description: "An Endpoint is one URL speaking one Shape. Callers' requests go to Endpoints speaking their Shape.",
			Query:       []api.Param{audit.DryRun},
			Request:     CreateEndpoint{}, Response: EndpointResult{},
			Handle: func(c *api.Call) (any, error) {
				var in CreateEndpoint
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Endpoint
				res, err := h.tr.Mutate(c, "endpoint.create", "Created", func(m *audit.Mutation) error {
					p, err := resolveProvider(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					out, err = h.upsertEndpoint(m, p, in)
					return err
				})
				return EndpointResult{Result: res, Endpoint: out}, err
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
					return h.upsertEndpoint(m, p, in)
				})
			},
		},
		{
			Method: http.MethodPatch, Path: base + "/{endpoint}", Tag: tag,
			Summary: "Rename an Endpoint or change its URL or Shape",
			Query:   []api.Param{audit.DryRun},
			Request: UpdateEndpoint{}, Response: EndpointResult{},
			Handle: func(c *api.Call) (any, error) {
				var in UpdateEndpoint
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Endpoint
				res, err := h.tr.Mutate(c, "endpoint.update", "Edited", func(m *audit.Mutation) error {
					p, err := resolveProvider(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					id, err := resolveChild(m.Ctx, m.Tx, "endpoints", "Endpoint", "endpoints", p, c.Path("endpoint"))
					if err != nil {
						return err
					}
					out, err = h.updateEndpoint(m, p, id, in)
					return err
				})
				return EndpointResult{Result: res, Endpoint: out}, err
			},
		},
		{
			Method: http.MethodDelete, Path: base + "/{endpoint}", Tag: tag,
			Summary:     "Delete an Endpoint",
			Description: "Revertible through its Audit Entry.",
			Query:       []api.Param{audit.DryRun},
			Response:    EndpointResult{},
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
					_, err = m.Tx.ExecContext(m.Ctx, `DELETE FROM endpoints WHERE id = ?`, id)
					return err
				})
				return EndpointResult{Result: res, Endpoint: out}, err
			},
		},
	}
}

func (h handlers) upsertEndpoint(m *audit.Mutation, p ref, in CreateEndpoint) (Endpoint, error) {
	if in.Name == "" {
		in.Name = "default"
	}
	if err := api.CheckName("name", in.Name); err != nil {
		return Endpoint{}, err
	}
	var id string
	err := m.Tx.QueryRowContext(m.Ctx, `SELECT id FROM endpoints WHERE provider_id = ? AND name = ?`, p.id, in.Name).Scan(&id)
	if err == nil {
		return h.updateEndpoint(m, p, id, UpdateEndpoint{URL: in.URL, Shape: in.Shape})
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Endpoint{}, err
	}
	if in.URL == nil {
		return Endpoint{}, api.BadRequest(urlHint, "url is required for a new Endpoint.")
	}
	u, err := checkURL(*in.URL)
	if err != nil {
		return Endpoint{}, err
	}
	if in.Shape == nil {
		return Endpoint{}, api.BadRequest("Send shape: openai-chat, openai-responses, anthropic-messages or gemini.", "shape is required for a new Endpoint.")
	}
	if err := checkShape(*in.Shape); err != nil {
		return Endpoint{}, err
	}
	id = ids.New("ep")
	if err := m.Track(EndpointResource, id); err != nil {
		return Endpoint{}, err
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO endpoints (id, provider_id, name, url, shape, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		id, p.id, in.Name, u, *in.Shape, store.Millis(m.Now)); err != nil {
		return Endpoint{}, err
	}
	return readEndpoint(m.Ctx, m.Tx, id)
}

func (h handlers) updateEndpoint(m *audit.Mutation, p ref, id string, in UpdateEndpoint) (Endpoint, error) {
	if err := m.Track(EndpointResource, id); err != nil {
		return Endpoint{}, err
	}
	if in.Name != nil {
		if err := api.CheckName("name", *in.Name); err != nil {
			return Endpoint{}, err
		}
		if err := childNameFree(m.Ctx, m.Tx, "endpoints", "Endpoint", p.id, *in.Name, id); err != nil {
			return Endpoint{}, err
		}
	}
	if in.URL != nil {
		u, err := checkURL(*in.URL)
		if err != nil {
			return Endpoint{}, err
		}
		in.URL = &u
	}
	if in.Shape != nil {
		if err := checkShape(*in.Shape); err != nil {
			return Endpoint{}, err
		}
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE endpoints SET name = coalesce(?, name), url = coalesce(?, url), shape = coalesce(?, shape) WHERE id = ?`,
		in.Name, in.URL, in.Shape, id); err != nil {
		return Endpoint{}, err
	}
	return readEndpoint(m.Ctx, m.Tx, id)
}
