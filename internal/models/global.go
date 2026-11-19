package models

import (
	"context"
	"net/http"
	"sort"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/store"
)

// The global model list (ticket 12): every <handle>/<model> a Gateway Key
// may use, with metadata, from one query over every Provider. Ticket 18 adds
// the Pools the key may use to the same list.

func (s *Store) globalRoute() api.Route {
	return api.Route{
		Method: http.MethodGet, Path: "/v1/models", Tag: "Gateway", Auth: api.AuthCaller,
		Summary: "List every model a Gateway Key may use, as <provider>/<model> (OpenAI list shape)",
		Description: "The IDs to send to the global routes (/v1/chat/completions, /v1/messages, ...): for each enabled Provider in the key's scope, " +
			"its visible models (discovered or added by the Owner, not hidden) qualified with its handle, e.g. acme/gpt-4o; " +
			"for a Provider the key is narrowed to some models, exactly those models minus hidden ones. Sorted by Provider handle, then model. " +
			"Entries carry the same fields as GET /providers/{handle}/v1/models (context_length, max_input_tokens, max_output_tokens, " +
			"architecture.input_modalities/output_modalities, reasoning, reasoning_levels; absent when unknown; chat ok unless known not to chat), owned_by the Provider's handle.",
		Response: CallerModelList{},
		Handle:   s.globalList,
	}
}

func (s *Store) globalList(c *api.Call) (any, error) {
	caller, aerr := s.keys.Authenticate(c.R)
	if aerr != nil {
		return nil, aerr
	}
	data, err := s.CallerModels(c.R.Context(), caller)
	if err != nil {
		return nil, err
	}
	return CallerModelList{Object: "list", Data: data}, nil
}

// globalProvider is one Provider of the global list being built.
type globalProvider struct {
	handle  string
	created int64
	brand   string
	entries map[string]entryRow // by model
	visible []string            // in model order
}

type entryRow struct {
	hidden                                      bool
	reported, overrides, external, externalBrand string
}

// CallerModels lists what caller may use on the global routes, qualified
// as <handle>/<model>, sorted, with metadata. One query reads every
// Provider's entries.
func (s *Store) CallerModels(ctx context.Context, caller gatewaykeys.Caller) ([]CallerModel, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT p.id, p.handle, p.created_at, p.models_dev_brand,
			m.model, m.added, m.hidden, m.reported, m.overrides, m.external, m.external_brand,
			m.model IS NOT NULL AND EXISTS (SELECT 1 FROM provider_model_sources src WHERE src.provider_id = p.id AND src.model = m.model)
		FROM providers p LEFT JOIN provider_models m ON m.provider_id = p.id
		WHERE p.enabled = 1 AND p.archived = 0
		ORDER BY p.handle, m.model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var order []string
	byID := map[string]*globalProvider{}
	for rows.Next() {
		var id, handle, brand string
		var created int64
		var model, reported, overrides, external, externalBrand *string
		var added, hidden *bool
		var discovered bool
		if err := rows.Scan(&id, &handle, &created, &brand, &model, &added, &hidden, &reported, &overrides, &external, &externalBrand, &discovered); err != nil {
			return nil, err
		}
		if !caller.AllowsProvider(id) {
			continue
		}
		p := byID[id]
		if p == nil {
			p = &globalProvider{handle: handle, created: created, brand: brand, entries: map[string]entryRow{}}
			byID[id] = p
			order = append(order, id)
		}
		if model == nil {
			continue // a Provider with an empty list
		}
		p.entries[*model] = entryRow{hidden: *hidden, reported: *reported, overrides: *overrides, external: *external, externalBrand: *externalBrand}
		if (*added || discovered) && !*hidden {
			p.visible = append(p.visible, *model)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []CallerModel{}
	for _, id := range order {
		p := byID[id]
		names := caller.ScopeModels(id)
		if names == nil {
			names = p.visible
		} else {
			kept := names[:0]
			for _, n := range names {
				if !p.entries[n].hidden {
					kept = append(kept, n)
				}
			}
			names = kept
			sort.Strings(names)
		}
		at := store.FromMillis(p.created).Unix()
		for _, n := range names {
			facts := Metadata{}.Of(n)
			if e, ok := p.entries[n]; ok {
				facts = entryLayers(p.brand, e.reported, e.overrides, e.external, e.externalBrand).served()
			}
			out = append(out, CallerModel{ID: p.handle + "/" + n, Object: "model", Created: at, OwnedBy: p.handle, Facts: facts})
		}
	}
	return out, nil
}
