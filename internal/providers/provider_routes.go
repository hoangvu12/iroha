package providers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/ids"
	"github.com/hoangvu12/iroha/internal/logos"
	"github.com/hoangvu12/iroha/internal/store"
)

type providerSnapshot struct {
	ID               string    `json:"id"`
	Handle           string    `json:"handle"`
	Name             string    `json:"name"`
	Enabled          bool      `json:"enabled"`
	Archived         bool      `json:"archived"`
	CreatedAt        time.Time `json:"created_at"`
	MaxAttempts      int       `json:"max_attempts,omitempty"`
	FirstByteSeconds int       `json:"first_byte_seconds,omitempty"`
	Strict           bool      `json:"strict,omitempty"`
	Discovery        string    `json:"discovery,omitempty"`
	ModelsDevBrand   string    `json:"models_dev_brand,omitempty"`
	LogoDomain       string    `json:"logo_domain,omitempty"`
	Affinity         string    `json:"affinity,omitempty"`
}

func (s providerSnapshot) MarshalJSON() ([]byte, error) {
	type stored providerSnapshot
	out := stored(s)
	if out.Discovery == DiscoveryProvider {
		out.Discovery = ""
	}
	if out.Affinity == AffinityOn {
		out.Affinity = ""
	}
	return json.Marshal(out)
}

func (s *providerSnapshot) UnmarshalJSON(b []byte) error {
	type stored providerSnapshot
	in := stored{Discovery: DiscoveryProvider, Affinity: AffinityOn}
	if err := json.Unmarshal(b, &in); err != nil {
		return err
	}
	*s = providerSnapshot(in)
	return nil
}

var Resource = audit.Register(&audit.Resource[providerSnapshot]{
	Name: "provider", Label: "Provider", Plural: "Providers", Path: "/api/providers",
	Table: "providers", NameColumn: "handle",
	NameOf: func(s providerSnapshot) string { return s.Handle },
	Load: func(ctx context.Context, q audit.Querier, id string) (*providerSnapshot, error) {
		var s providerSnapshot
		var created int64
		err := q.QueryRowContext(ctx, `SELECT id, handle, name, enabled, archived, created_at, max_attempts, first_byte_seconds, strict, discovery, models_dev_brand, logo_domain, affinity FROM providers WHERE id = ?`, id).
			Scan(&s.ID, &s.Handle, &s.Name, &s.Enabled, &s.Archived, &created, &s.MaxAttempts, &s.FirstByteSeconds, &s.Strict, &s.Discovery, &s.ModelsDevBrand, &s.LogoDomain, &s.Affinity)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		s.CreatedAt = store.FromMillis(created)
		return &s, err
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *providerSnapshot) error {
		if s == nil {
			var children int
			if err := tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM endpoints WHERE provider_id = ?) + (SELECT count(*) FROM upstream_keys WHERE provider_id = ?)`,
				id, id).Scan(&children); err != nil {
				return err
			}
			if children > 0 {
				return api.Conflict("provider_has_children", "Delete the Provider's Endpoints and Upstream Keys first (or revert the entries that added them), then retry.",
					"The Provider still has %d Endpoints and Upstream Keys.", children)
			}
			_, err := tx.ExecContext(ctx, `DELETE FROM providers WHERE id = ?`, id)
			return err
		}
		var other string
		err := tx.QueryRowContext(ctx, `SELECT id FROM providers WHERE handle = ? AND id != ?`, s.Handle, id).Scan(&other)
		if err == nil {
			return api.Conflict("handle_taken", "Handles are never reused; nothing can be restored over another Provider.",
				"Another Provider (%s) has the handle %q.", other, s.Handle)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO providers (id, handle, name, enabled, archived, created_at, max_attempts, first_byte_seconds, strict, discovery, models_dev_brand, logo_domain, affinity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET name = excluded.name, enabled = excluded.enabled, archived = excluded.archived,
			max_attempts = excluded.max_attempts, first_byte_seconds = excluded.first_byte_seconds, strict = excluded.strict, discovery = excluded.discovery,
			models_dev_brand = excluded.models_dev_brand, logo_domain = excluded.logo_domain, affinity = excluded.affinity`,
			id, s.Handle, s.Name, s.Enabled, s.Archived, store.Millis(s.CreatedAt), s.MaxAttempts, s.FirstByteSeconds, s.Strict, s.Discovery, s.ModelsDevBrand, s.LogoDomain, s.Affinity)
		return err
	},
})

type CreateProvider struct {
	Handle  string  `json:"handle" doc:"Unique handle: lowercase letters, digits and single hyphens, at most 63. Never changes. On PUT the path names the Provider: leave it out or send the same handle."`
	Name    *string `json:"name,omitempty" doc:"Display name; defaults to the handle for a new Provider."`
	Enabled *bool   `json:"enabled,omitempty" doc:"Default true for a new Provider."`
	BudgetOverrides
	ModelListSettings
	RoutingSettings
}

type RoutingSettings struct {
	Affinity *string `json:"affinity,omitempty" enum:"on,off" doc:"on (default): the turns of one conversation go to one Upstream Key (keys ranked per conversation by rendezvous hashing), so the Provider's prompt cache stays warm; off: keys are used in turn (round-robin) whatever the conversation."`
}

func (s RoutingSettings) check() error {
	if s.Affinity != nil && *s.Affinity != AffinityOn && *s.Affinity != AffinityOff {
		return api.BadRequest("Use affinity on or off.", "affinity %q is not on or off.", *s.Affinity)
	}
	return nil
}

type ModelListSettings struct {
	Strict         *bool   `json:"strict,omitempty" doc:"true: refuse models missing from the model list before any Attempt (404 model_not_found). Default false: unlisted models are forwarded."`
	Discovery      *string `json:"discovery,omitempty" enum:"none,provider,key" doc:"provider (default): read each Endpoint's model list with one key. key: read it with every key, so keys whose list names a model are tried first for it; use it when keys see different models. none: never discover."`
	ModelsDevBrand *string `json:"models_dev_brand,omitempty" doc:"The models.dev provider ID this Provider's models are looked up under for metadata, e.g. anthropic, openai, zai-coding-plan, alibaba-cn, openrouter. \"\" (default): none; models are looked up by name in models.dev's maker catalog only. Takes effect at the next model refresh."`
	LogoDomain     *string `json:"logo_domain,omitempty" doc:"The site whose logo the UI shows for this Provider, e.g. alibabacloud.com (a URL is read for its host). \"\" (default): the site of the first Endpoint's host; \"none\": no logo, the first letter is drawn."`
}

var brandPattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)

func (s *ModelListSettings) check() error {
	if d := s.LogoDomain; d != nil && *d != "" && *d != NoLogo {
		n, err := logos.NormalizeDomain(*d)
		if err != nil {
			return api.BadRequest("Use a site's domain such as alibabacloud.com (no IP address or port), \"\" to guess it from the Endpoints, or \"none\" for no logo.",
				"logo_domain %q is not a domain.", *d)
		}
		s.LogoDomain = &n
	}
	if b := s.ModelsDevBrand; b != nil && *b != "" && (len(*b) > 64 || !brandPattern.MatchString(*b)) {
		return api.BadRequest("Use a models.dev provider ID: lowercase letters, digits, and single dots, dashes or underscores, e.g. \"zai-coding-plan\"; \"\" for none.",
			"models_dev_brand %q is not a models.dev provider ID.", *b)
	}
	if s.Discovery != nil {
		switch *s.Discovery {
		case DiscoveryNone, DiscoveryProvider, DiscoveryKey:
		default:
			return api.BadRequest("Use discovery provider, key or none.", "discovery %q is not a discovery mode.", *s.Discovery)
		}
	}
	return nil
}

type BudgetOverrides struct {
	MaxAttempts      *int `json:"max_attempts,omitempty" doc:"Attempts per Request at most, 1 to 10; 0 restores the default (3)."`
	FirstByteSeconds *int `json:"first_byte_seconds,omitempty" doc:"Seconds a Request waits for the first upstream byte across its Attempts, 1 to 95; 0 restores the default (60). Never above the 95 s ceiling, so every Request answers before the 100 s edge cutoff."`
}

func (b BudgetOverrides) Check() error { return b.check() }

func (b BudgetOverrides) check() error {
	if b.MaxAttempts != nil && (*b.MaxAttempts < 0 || *b.MaxAttempts > MaxAttemptsLimit) {
		return api.BadRequest("Use 1 to 10, or 0 for the default of 3.", "max_attempts must be between 0 and %d.", MaxAttemptsLimit)
	}
	ceiling := int(FirstByteCeiling / time.Second)
	if b.FirstByteSeconds != nil && (*b.FirstByteSeconds < 0 || *b.FirstByteSeconds > ceiling) {
		return api.BadRequest(fmt.Sprintf("Use 1 to %d seconds, or 0 for the default of 60; the edge in front of Iroha cuts Requests at 100 s.", ceiling),
			"first_byte_seconds must be between 0 and %d.", ceiling)
	}
	return nil
}

type UpdateProvider struct {
	Handle   *string `json:"handle,omitempty" doc:"Handles never change; a different value is refused with handle_immutable."`
	Name     *string `json:"name,omitempty"`
	Enabled  *bool   `json:"enabled,omitempty"`
	Archived *bool   `json:"archived,omitempty" doc:"Archive to retire the Provider: Callers are refused and the handle stays reserved."`
	BudgetOverrides
	ModelListSettings
	RoutingSettings
}

type ProviderResult struct {
	audit.Result
	Provider Provider `json:"provider" doc:"The Provider after the change (on a dry run, as it would be)."`
}

type ProviderList struct {
	Providers []Provider `json:"providers"`
}

func Routes(tr *audit.Trail, db *store.DB, log *slog.Logger) []api.Route {
	h := handlers{tr: tr, db: db, log: log}
	return slices.Concat(h.providerRoutes(), []api.Route{h.summaryRoute()}, h.endpointRoutes(), h.keyRoutes(), h.gapRoutes(), h.endpointGapRoutes())
}

type handlers struct {
	tr  *audit.Trail
	db  *store.DB
	log *slog.Logger
}

func (h handlers) providerRoutes() []api.Route {
	const tag = "Providers"
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/providers", Tag: tag,
			Summary: "List Providers with their Endpoints",
			Query: []api.Param{
				{Name: "archived", Type: "boolean", Description: "true: only archived Providers; false: only the others. Default: all."},
			},
			Response: ProviderList{},
			Handle:   h.listProviders,
		},
		{
			Method: http.MethodGet, Path: "/api/providers/{provider}", Tag: tag,
			Summary:  "Read a Provider by handle or ID",
			Response: Provider{},
			Handle: func(c *api.Call) (any, error) {
				id, err := Resource.Resolve(c.R.Context(), h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				return readProvider(c.R.Context(), h.db, id)
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers", Tag: tag,
			Summary: "Create a Provider",
			Description: "Answers 201 with the new Provider; a handle in use answers 409 name_taken (PUT /api/providers/{provider} updates that Provider). " +
				"A new Provider has no Endpoints or Upstream Keys; add them with POST /api/providers/{provider}/endpoints and POST /api/providers/{provider}/keys. " +
				"Callers then reach it at /providers/<handle>/v1/...",
			Query:   []api.Param{audit.DryRun},
			Request: CreateProvider{}, Response: ProviderResult{},
			Handle: func(c *api.Call) (any, error) {
				var in CreateProvider
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Provider
				res, err := h.tr.Mutate(c, "provider.create", "Created", func(m *audit.Mutation) error {
					var err error
					out, err = h.createProvider(m, in)
					return err
				})
				return ProviderResult{Result: res, Provider: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers/bulk", Tag: tag,
			Summary:     "Create many Providers",
			Description: "Each item is created or refused on its own (a handle in use: 409 name_taken); read failed and each item's error.",
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[CreateProvider]{}, Response: audit.BulkResult[Provider]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[CreateProvider]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "provider.create", "Created", in.Items, h.createProvider)
			},
		},
		{
			Method: http.MethodPut, Path: "/api/providers/{provider}", Tag: tag,
			Summary:     "Create or update the Provider with that handle",
			Description: "Answers 201 with a new Provider whose handle is the path, or 200 when the Provider exists (outcome updated or unchanged): fields sent are applied, the others kept.",
			Query:       []api.Param{audit.DryRun},
			Request:     CreateProvider{}, Response: ProviderResult{},
			Handle: func(c *api.Call) (any, error) {
				var in CreateProvider
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Provider
				res, err := h.tr.Mutate(c, "provider.update", "Saved", func(m *audit.Mutation) error {
					var err error
					out, err = h.putProvider(m, c.Path("provider"), in)
					return err
				})
				return ProviderResult{Result: res, Provider: out}, err
			},
		},
		{
			Method: http.MethodPut, Path: "/api/providers/bulk", Tag: tag,
			Summary:     "Create or update many Providers, each by handle",
			Description: "Each item is PUT /api/providers/{provider} with the item's handle, applied or refused on its own; read failed and each item's error.",
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[CreateProvider]{}, Response: audit.BulkResult[Provider]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[CreateProvider]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "provider.update", "Saved", in.Items, func(m *audit.Mutation, in CreateProvider) (Provider, error) {
					return h.putProvider(m, in.Handle, in)
				})
			},
		},
		{
			Method: http.MethodPatch, Path: "/api/providers/{provider}", Tag: tag,
			Summary: "Rename, enable, disable, archive or unarchive a Provider, or change its Request budget, model list or affinity settings",
			Query:   []api.Param{audit.DryRun},
			Request: UpdateProvider{}, Response: ProviderResult{},
			Handle: func(c *api.Call) (any, error) {
				var in UpdateProvider
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Provider
				res, err := h.tr.Mutate(c, "provider.update", "Edited", func(m *audit.Mutation) error {
					id, err := Resource.Resolve(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					out, err = h.updateProvider(m, id, in)
					return err
				})
				return ProviderResult{Result: res, Provider: out}, err
			},
		},
	}
}

func (h handlers) listProviders(c *api.Call) (any, error) {
	q := `SELECT id FROM providers`
	switch c.Query("archived") {
	case "":
	case "true":
		q += ` WHERE archived = 1`
	case "false":
		q += ` WHERE archived = 0`
	default:
		return nil, api.BadRequest("Use archived=true, archived=false, or leave it out for all Providers.", "archived must be true or false.")
	}
	rows, err := h.db.QueryContext(c.R.Context(), q+` ORDER BY handle`)
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
	out := ProviderList{Providers: []Provider{}}
	for _, id := range idList {
		p, err := readProvider(c.R.Context(), h.db, id)
		if err != nil {
			return nil, err
		}
		out.Providers = append(out.Providers, p)
	}
	return out, nil
}

func (h handlers) putProvider(m *audit.Mutation, ref string, in CreateProvider) (Provider, error) {
	id, err := Resource.Find(m.Ctx, m.Tx, ref)
	if err != nil {
		return Provider{}, err
	}
	current := ""
	if id != "" {
		if err := m.Tx.QueryRowContext(m.Ctx, `SELECT handle FROM providers WHERE id = ?`, id).Scan(&current); err != nil {
			return Provider{}, err
		}
	}
	if err := audit.CheckPutName("handle", ref, in.Handle, current); err != nil {
		return Provider{}, err
	}
	if id == "" {
		m.Act("provider.create", "Created")
		in.Handle = ref
		return h.createProvider(m, in)
	}
	m.Act("provider.update", "Edited")
	return h.updateProvider(m, id, UpdateProvider{Name: in.Name, Enabled: in.Enabled, BudgetOverrides: in.BudgetOverrides, ModelListSettings: in.ModelListSettings, RoutingSettings: in.RoutingSettings})
}

func (h handlers) createProvider(m *audit.Mutation, in CreateProvider) (Provider, error) {
	if err := CheckHandle(in.Handle); err != nil {
		return Provider{}, err
	}
	var id string
	err := m.Tx.QueryRowContext(m.Ctx, `SELECT id FROM providers WHERE handle = ?`, in.Handle).Scan(&id)
	if err == nil {
		return Provider{}, Resource.Taken(id, in.Handle, "/api/providers/"+in.Handle)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Provider{}, err
	}
	name, enabled := in.Handle, true
	if in.Name != nil {
		if err := checkDisplayName(*in.Name); err != nil {
			return Provider{}, err
		}
		name = *in.Name
	}
	if in.Enabled != nil {
		enabled = *in.Enabled
	}
	if err := in.BudgetOverrides.check(); err != nil {
		return Provider{}, err
	}
	if err := in.ModelListSettings.check(); err != nil {
		return Provider{}, err
	}
	if err := in.RoutingSettings.check(); err != nil {
		return Provider{}, err
	}
	aff := AffinityOn
	if in.Affinity != nil {
		aff = *in.Affinity
	}
	strict, discovery := false, DiscoveryProvider
	if in.Strict != nil {
		strict = *in.Strict
	}
	if in.Discovery != nil {
		discovery = *in.Discovery
	}
	brand, logo := "", ""
	if in.ModelsDevBrand != nil {
		brand = *in.ModelsDevBrand
	}
	if in.LogoDomain != nil {
		logo = *in.LogoDomain
	}
	id = ids.New("pr")
	if err := m.Track(Resource, id); err != nil {
		return Provider{}, err
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO providers (id, handle, name, enabled, created_at, max_attempts, first_byte_seconds, strict, discovery, models_dev_brand, logo_domain, affinity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, in.Handle, name, enabled, store.Millis(m.Now), zeroIfNil(in.MaxAttempts), zeroIfNil(in.FirstByteSeconds), strict, discovery, brand, logo, aff); err != nil {
		return Provider{}, err
	}
	return readProvider(m.Ctx, m.Tx, id)
}

func (h handlers) updateProvider(m *audit.Mutation, id string, in UpdateProvider) (Provider, error) {
	if err := m.Track(Resource, id); err != nil {
		return Provider{}, err
	}
	cur, err := readProvider(m.Ctx, m.Tx, id)
	if err != nil {
		return cur, err
	}
	if in.Handle != nil && *in.Handle != cur.Handle {
		return cur, api.Errorf(http.StatusBadRequest, "handle_immutable",
			"Keep the handle \""+cur.Handle+"\" (leave handle out of the body); to use another handle, create a new Provider with it.",
			"A Provider's handle never changes.")
	}
	if in.Name != nil {
		if err := checkDisplayName(*in.Name); err != nil {
			return cur, err
		}
	}
	if err := in.BudgetOverrides.check(); err != nil {
		return cur, err
	}
	if err := in.ModelListSettings.check(); err != nil {
		return cur, err
	}
	if err := in.RoutingSettings.check(); err != nil {
		return cur, err
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `UPDATE providers SET name = coalesce(?, name), enabled = coalesce(?, enabled), archived = coalesce(?, archived),
		max_attempts = coalesce(?, max_attempts), first_byte_seconds = coalesce(?, first_byte_seconds),
		strict = coalesce(?, strict), discovery = coalesce(?, discovery), models_dev_brand = coalesce(?, models_dev_brand), logo_domain = coalesce(?, logo_domain),
		affinity = coalesce(?, affinity) WHERE id = ?`,
		in.Name, in.Enabled, in.Archived, in.MaxAttempts, in.FirstByteSeconds, in.Strict, in.Discovery, in.ModelsDevBrand, in.LogoDomain, in.Affinity, id); err != nil {
		return cur, err
	}
	return readProvider(m.Ctx, m.Tx, id)
}

func zeroIfNil(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}
