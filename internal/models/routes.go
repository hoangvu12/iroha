package models

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/store"
)

// snapshot is what an Audit Entry records of a model list entry: only the
// Owner's flags. An entry neither added nor hidden does not exist for the
// audit machinery, so adding a discovered model is a create and reverting
// it clears the flag without touching what discovery found.
type snapshot struct {
	ID         string `json:"id"`
	ProviderID string `json:"provider_id"`
	Provider   string `json:"provider"`
	Model      string `json:"model"`
	Added      bool   `json:"added"`
	Hidden     bool   `json:"hidden"`
}

// Resource is the model list entry resource of the audit machinery.
var Resource = audit.Register(&audit.Resource[snapshot]{
	Name: "model", Label: "Model", Plural: "Models", Path: "/api/providers/{provider}/models",
	Table: "provider_models", NameColumn: "model",
	NameOf: func(s snapshot) string { return s.Provider + "/" + s.Model },
	Load: func(ctx context.Context, q audit.Querier, id string) (*snapshot, error) {
		var s snapshot
		err := q.QueryRowContext(ctx, `SELECT m.id, m.provider_id, p.handle, m.model, m.added, m.hidden
			FROM provider_models m JOIN providers p ON p.id = m.provider_id WHERE m.id = ?`, id).
			Scan(&s.ID, &s.ProviderID, &s.Provider, &s.Model, &s.Added, &s.Hidden)
		if errors.Is(err, sql.ErrNoRows) || err == nil && !s.Added && !s.Hidden {
			return nil, nil
		}
		return &s, err
	},
	Restore: func(ctx context.Context, tx *sql.Tx, id string, s *snapshot) error {
		if s == nil {
			var providerID string
			err := tx.QueryRowContext(ctx, `UPDATE provider_models SET added = 0, hidden = 0 WHERE id = ? RETURNING provider_id`, id).Scan(&providerID)
			if errors.Is(err, sql.ErrNoRows) {
				return nil
			}
			if err != nil {
				return err
			}
			return pruneEntries(ctx, tx, providerID)
		}
		var x int
		err := tx.QueryRowContext(ctx, `SELECT 1 FROM providers WHERE id = ?`, s.ProviderID).Scan(&x)
		if errors.Is(err, sql.ErrNoRows) {
			return api.Conflict("provider_gone", "Restore the Provider first, then retry.", "Provider %s no longer exists, so its model %s cannot come back.", s.Provider, s.Model)
		}
		if err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO provider_models (id, provider_id, model, added, hidden) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (id) DO UPDATE SET added = excluded.added, hidden = excluded.hidden`, id, s.ProviderID, s.Model, s.Added, s.Hidden)
		return err
	},
})

// ModelChange is the body of POST /api/providers/{provider}/models and each
// item of its bulk.
type ModelChange struct {
	Model  string `json:"model" doc:"The model ID exactly as the Provider names it (case-sensitive; may contain /)."`
	Added  *bool  `json:"added,omitempty" doc:"true: the model is on the list whatever discovery finds; false: take it off unless discovered. Default true when hidden is not sent either."`
	Hidden *bool  `json:"hidden,omitempty" doc:"true: Callers never see it and asking for it is refused (404 model_not_found), even if it was never discovered; false: show it again."`
}

// ModelResult is the response of a single model change.
type ModelResult struct {
	audit.Result
	Model Model `json:"model" doc:"The entry after the change; all flags false when it left the list."`
}

// ModelCounts counts a Provider's entries per filter.
type ModelCounts struct {
	All        int `json:"all"`
	Visible    int `json:"visible"`
	Discovered int `json:"discovered"`
	Added      int `json:"added"`
	Hidden     int `json:"hidden"`
	Gaps       int `json:"gaps" doc:"Entries some key has a live Model Gap for."`
}

// ModelList is the response of GET /api/providers/{provider}/models.
type ModelList struct {
	Provider    string       `json:"provider"`
	Strict      bool         `json:"strict" doc:"The Provider refuses models missing from this list."`
	Discovery   string       `json:"discovery" enum:"none,provider,key"`
	LastRefresh *LastRefresh `json:"last_refresh,omitempty" doc:"The latest refresh; absent when the list was never refreshed (or was reset)."`
	Counts      ModelCounts  `json:"counts" doc:"Entries per filter, before q and paging."`
	Total       int          `json:"total" doc:"Entries matching filter and q."`
	Offset      int          `json:"offset"`
	Limit       int          `json:"limit"`
	Models      []Model      `json:"models" doc:"The page of matching entries, sorted by model."`
}

// Filters of the model list.
var filters = []string{"all", "visible", "discovered", "added", "hidden", "gaps"}

const (
	defaultLimit = 100
	maxLimit     = 1000
)

// Routes returns the admin routes of model lists and the Caller route
// GET /providers/{handle}/v1/models.
func Routes(tr *audit.Trail, s *Store) []api.Route {
	h := handlers{tr: tr, s: s}
	const tag = "Models"
	const base = "/api/providers/{provider}/models"
	return []api.Route{
		{
			Method: http.MethodGet, Path: base, Tag: tag,
			Summary: "List a Provider's model list: search, filter and page it",
			Description: "Every entry with its flags (discovered, added, hidden), the Endpoints and keys whose lists name it, and the keys with a Model Gap for it. " +
				"Callers see the visible entries at GET /providers/{handle}/v1/models.",
			Query: []api.Param{
				{Name: "q", Description: "Only models whose ID contains this text (case-insensitive)."},
				{Name: "filter", Enum: filters, Description: "all (default), visible, discovered, added, hidden, or gaps (some key has a live Model Gap for it)."},
				{Name: "offset", Type: "integer", Description: "Skip this many matching entries. Default 0."},
				{Name: "limit", Type: "integer", Description: "Entries per page, 1 to 1000. Default 100."},
			},
			Response: ModelList{},
			Handle:   h.list,
		},
		{
			Method: http.MethodPost, Path: base, Tag: tag,
			Summary: "Add, hide or show one model of a Provider, by model ID",
			Description: "`{\"model\": \"x\"}` adds a model discovery does not find; refreshes never remove it. `{\"model\": \"x\", \"hidden\": true}` hides any model, even one never discovered: " +
				"Callers no longer see it and asking for it is refused before any Attempt. `\"added\": false` / `\"hidden\": false` undo them. Revertible through the Audit Entry.",
			Query:   []api.Param{audit.DryRun},
			Request: ModelChange{}, Response: ModelResult{},
			Handle: func(c *api.Call) (any, error) {
				var in ModelChange
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				var out Model
				res, err := h.tr.Mutate(c, "model.change", "Changed", func(m *audit.Mutation) error {
					p, err := resolve(m.Ctx, m.Tx, c.Path("provider"))
					if err != nil {
						return err
					}
					out, err = h.change(m, p, in)
					return err
				})
				return ModelResult{Result: res, Model: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: base + "/bulk", Tag: tag,
			Summary:     "Add, hide or show many models of a Provider",
			Description: "Each item is a body of POST /api/providers/{provider}/models, applied or refused on its own. One Audit Entry covers them all.",
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[ModelChange]{}, Response: audit.BulkResult[Model]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[ModelChange]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				p, err := resolve(c.R.Context(), h.s.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "model.change", "Changed", in.Items, func(m *audit.Mutation, in ModelChange) (Model, error) {
					return h.change(m, p, in)
				})
			},
		},
		{
			Method: http.MethodPost, Path: base + "/refresh", Tag: tag,
			Summary: "Discover a Provider's models now",
			Description: "Reads each Endpoint's model list (GET <url>/models, or its discovery_url), with one key per Endpoint, or with every key under discovery key. " +
				"Answers with data or models arrays are understood. A list that fails keeps the models it named before; " +
				"models the Owner added are never removed. Under discovery key, a key whose list names a model it has a Model Gap for gets the gap cleared. " +
				"Each list is logged as a discovery event (GET /api/logs?kind=discovery). With dry_run=true nothing is sent: lists says what would be read.",
			Query:    []api.Param{audit.DryRun},
			Response: RefreshResult{},
			Handle: func(c *api.Call) (any, error) {
				dry, err := audit.IsDryRun(c)
				if err != nil {
					return nil, err
				}
				return h.s.Refresh(c.R.Context(), c.Path("provider"), dry)
			},
		},
		{
			Method: http.MethodPost, Path: base + "/reset", Tag: tag,
			Summary: "Forget a Provider's discovered models",
			Description: "Deletes every discovered list of the Provider, for a list polluted by a misconfigured Endpoint. Models the Owner added or hid stay, and the Provider, " +
				"its keys and every Gateway Key scope naming it are untouched. Run POST .../models/refresh afterwards to discover afresh.",
			Query:    []api.Param{audit.DryRun},
			Response: ResetResult{},
			Handle: func(c *api.Call) (any, error) {
				dry, err := audit.IsDryRun(c)
				if err != nil {
					return nil, err
				}
				return h.s.Reset(c.R.Context(), c.Path("provider"), dry)
			},
		},
		{
			Method: http.MethodGet, Path: "/providers/{handle}/v1/models", Tag: "Gateway", Auth: api.AuthCaller,
			Summary: "List the models of one Provider a Gateway Key may use (OpenAI list shape)",
			Description: "The Provider's visible models (discovered or added by the Owner, not hidden), sorted. A Gateway Key narrowed to some models of the Provider lists exactly those, " +
				"even ones the list lacks, minus hidden ones. A Provider that does not exist, is disabled or archived, or is outside the key's scope gets 403 provider_not_allowed.",
			Response: CallerModelList{},
			Handle:   s.callerList,
		},
	}
}

type handlers struct {
	tr *audit.Trail
	s  *Store
}

// provRef is a resolved Provider.
type provRef struct{ id, handle string }

func resolve(ctx context.Context, q audit.Querier, ref string) (provRef, error) {
	id, err := providers.ResolveID(ctx, q, ref)
	if err != nil {
		return provRef{}, err
	}
	var h string
	err = q.QueryRowContext(ctx, `SELECT handle FROM providers WHERE id = ?`, id).Scan(&h)
	return provRef{id: id, handle: h}, err
}

func (h handlers) list(c *api.Call) (any, error) {
	ctx := c.R.Context()
	p, err := resolve(ctx, h.s.db, c.Path("provider"))
	if err != nil {
		return nil, err
	}
	filter := c.Query("filter")
	if filter == "" {
		filter = "all"
	}
	if !contains(filters, filter) {
		return nil, api.BadRequest("Use filter "+strings.Join(filters, ", ")+".", "filter %q is not known.", filter)
	}
	offset, err := intParam(c, "offset", 0, 0, 1<<30)
	if err != nil {
		return nil, err
	}
	limit, err := intParam(c, "limit", defaultLimit, 1, maxLimit)
	if err != nil {
		return nil, err
	}
	out := ModelList{Provider: p.handle, Offset: offset, Limit: limit, Models: []Model{}}
	if err := h.s.db.QueryRowContext(ctx, `SELECT strict, discovery FROM providers WHERE id = ?`, p.id).Scan(&out.Strict, &out.Discovery); err != nil {
		return nil, err
	}
	if out.LastRefresh, err = lastRefresh(ctx, h.s.db, p.id); err != nil {
		return nil, err
	}
	all, err := readEntries(ctx, h.s.db, p.id, h.s.clock.Now())
	if err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(c.Query("q")))
	var match []Model
	for _, m := range all {
		in := map[string]bool{"all": true, "visible": m.Visible, "discovered": m.Discovered, "added": m.Added, "hidden": m.Hidden, "gaps": len(m.ModelGaps) > 0}
		out.Counts.All++
		for f, n := range map[string]*int{"visible": &out.Counts.Visible, "discovered": &out.Counts.Discovered, "added": &out.Counts.Added,
			"hidden": &out.Counts.Hidden, "gaps": &out.Counts.Gaps} {
			if in[f] {
				*n++
			}
		}
		if in[filter] && (q == "" || strings.Contains(strings.ToLower(m.Model), q)) {
			match = append(match, m)
		}
	}
	out.Total = len(match)
	if offset < len(match) {
		out.Models = match[offset:min(offset+limit, len(match))]
	}
	return out, nil
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

func intParam(c *api.Call, name string, def, lo, hi int) (int, error) {
	s := c.Query(name)
	if s == "" {
		return def, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < lo || n > hi {
		return 0, api.BadRequest(fmt.Sprintf("Send %s as a whole number from %d to %d.", name, lo, hi), "%s %q is out of range.", name, s)
	}
	return n, nil
}

const modelHint = "Send the model ID exactly as the Provider names it: 1 to 256 characters without surrounding spaces or control characters, e.g. \"glm-4.6\" or \"meta-llama/llama-3.3-70b\"."

// change applies one ModelChange to Provider p.
func (h handlers) change(m *audit.Mutation, p provRef, in ModelChange) (Model, error) {
	model := in.Model
	if model == "" || len(model) > maxModelLen || strings.TrimSpace(model) != model || strings.ContainsFunc(model, unicode.IsControl) {
		return Model{}, api.BadRequest(modelHint, "model %q is not a model ID.", model)
	}
	added, hidden := in.Added, in.Hidden
	if added == nil && hidden == nil {
		t := true
		added = &t
	}
	id := entryID(p.id, model)
	if err := m.Track(Resource, id); err != nil {
		return Model{}, err
	}
	if _, err := m.Tx.ExecContext(m.Ctx, `INSERT INTO provider_models (id, provider_id, model, added, hidden) VALUES (?, ?, ?, coalesce(?, 0), coalesce(?, 0))
		ON CONFLICT (id) DO UPDATE SET added = coalesce(?, added), hidden = coalesce(?, hidden)`,
		id, p.id, model, added, hidden, added, hidden); err != nil {
		return Model{}, err
	}
	if err := pruneEntries(m.Ctx, m.Tx, p.id); err != nil {
		return Model{}, err
	}
	out, _, err := readEntry(m.Ctx, m.Tx, p.id, model, m.Now)
	return out, err
}

// CallerModel is one model of the Caller-facing list.
type CallerModel struct {
	ID      string `json:"id"`
	Object  string `json:"object" enum:"model"`
	Created int64  `json:"created" doc:"Unix seconds: when the Provider was added to Iroha."`
	OwnedBy string `json:"owned_by" doc:"The Provider's handle."`
}

// CallerModelList is the answer of GET /providers/{handle}/v1/models.
type CallerModelList struct {
	Object string        `json:"object" enum:"list"`
	Data   []CallerModel `json:"data"`
}

func (s *Store) callerList(c *api.Call) (any, error) {
	ctx := c.R.Context()
	caller, aerr := s.keys.Authenticate(c.R)
	if aerr != nil {
		return nil, aerr
	}
	handle := c.Path("handle")
	rt, ok, err := s.providers.Routing(ctx, handle)
	if err != nil {
		return nil, err
	}
	if !ok || !rt.Enabled || rt.Archived || !caller.AllowsProvider(rt.ID) {
		return nil, api.Errorf(http.StatusForbidden, "provider_not_allowed",
			"Check the handle in the URL; ask the Owner to add this Provider to your Gateway Key if you need it.",
			"This Gateway Key may not use a Provider named %q, or there is none.", handle)
	}
	var created int64
	if err := s.db.QueryRowContext(ctx, `SELECT created_at FROM providers WHERE id = ?`, rt.ID).Scan(&created); err != nil {
		return nil, err
	}
	names := caller.ScopeModels(rt.ID)
	if names == nil {
		if names, err = s.Visible(ctx, rt.ID); err != nil {
			return nil, err
		}
	} else {
		hidden, err := s.hiddenSet(ctx, rt.ID)
		if err != nil {
			return nil, err
		}
		kept := names[:0]
		for _, n := range names {
			if !hidden[n] {
				kept = append(kept, n)
			}
		}
		names = kept
		sort.Strings(names)
	}
	out := CallerModelList{Object: "list", Data: make([]CallerModel, 0, len(names))}
	at := store.FromMillis(created).Unix()
	for _, n := range names {
		out.Data = append(out.Data, CallerModel{ID: n, Object: "model", Created: at, OwnedBy: rt.Handle})
	}
	return out, nil
}
