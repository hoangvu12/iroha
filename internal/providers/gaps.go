package providers

import (
	"net/http"
	"slices"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/keystate"
)

type GapEntry struct {
	UpstreamKey string `json:"upstream_key" doc:"Name of the key."`
	keystate.ModelGap
}

type GapList struct {
	ModelGaps []GapEntry `json:"model_gaps"`
}

func gapEntries(k UpstreamKey) []GapEntry {
	out := make([]GapEntry, 0, len(k.ModelGaps))
	for _, g := range k.ModelGaps {
		out = append(out, GapEntry{UpstreamKey: k.Name, ModelGap: g})
	}
	return out
}

func sortGaps(gaps []GapEntry) {
	slices.SortStableFunc(gaps, func(a, b GapEntry) int {
		if c := a.ExpiresAt.Compare(b.ExpiresAt); c != 0 {
			return c
		}
		return strings.Compare(a.UpstreamKey+"\x00"+a.Model, b.UpstreamKey+"\x00"+b.Model)
	})
}

var gapModelParam = api.Param{Name: "model", Description: "Only the Model Gaps for this model (as sent upstream). Default: every model."}

const clearGapsDescription = "A cleared Model Gap lets the model reach the key again at once; if the Provider still refuses it, the next Request records the gap again (one Attempt). " +
	"Gaps also clear by themselves 24 hours after they were recorded, when a key test passes, and when the key's name, secret or Endpoint restriction is edited. Revertible through the Audit Entry."

func (h handlers) gapRoutes() []api.Route {
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/providers/{provider}/model-gaps", Tag: "Upstream Keys",
			Summary:     "List a Provider's live Model Gaps: which key was refused which model, and until when",
			Description: "Each key also lists its own gaps in model_gaps (GET /api/providers/{provider}/keys).",
			Query:       []api.Param{gapModelParam, {Name: "upstream_key", Description: "Only this key's gaps (name or ID)."}},
			Response:    GapList{},
			Handle: func(c *api.Call) (any, error) {
				ctx := c.R.Context()
				p, err := resolveProvider(ctx, h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				keyID := ""
				if ref := c.Query("upstream_key"); ref != "" {
					if keyID, err = resolveChild(ctx, h.db, "upstream_keys", "Upstream Key", "keys", p, ref); err != nil {
						return nil, err
					}
				}
				keys, err := listKeys(ctx, h.db, p.id, h.db.Clock().Now())
				if err != nil {
					return nil, err
				}
				out := GapList{ModelGaps: []GapEntry{}}
				model := c.Query("model")
				for _, k := range keys {
					if keyID != "" && k.ID != keyID {
						continue
					}
					for _, g := range gapEntries(k) {
						if model == "" || g.Model == model {
							out.ModelGaps = append(out.ModelGaps, g)
						}
					}
				}
				sortGaps(out.ModelGaps)
				return out, nil
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/{key}/clear-model-gaps", Tag: "Upstream Keys",
			Summary: "Clear an Upstream Key's Model Gaps", Description: clearGapsDescription,
			Query:    []api.Param{audit.DryRun, gapModelParam},
			Response: UpstreamKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				var out UpstreamKey
				var p ref
				var sl stateLogs
				res, err := h.tr.Mutate(c, "model_gap.clear", "Cleared", func(m *audit.Mutation) error {
					var err error
					if p, err = resolveProvider(m.Ctx, m.Tx, c.Path("provider")); err != nil {
						return err
					}
					id, err := resolveChild(m.Ctx, m.Tx, "upstream_keys", "Upstream Key", "keys", p, c.Path("key"))
					if err != nil {
						return err
					}
					out, err = h.clearKeyGaps(m, p, id, c.Query("model"), &sl)
					return err
				})
				if err == nil && !res.DryRun {
					sl.emit(h.log, p.handle)
				}
				return UpstreamKeyResult{Result: res, UpstreamKey: out}, err
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/bulk/clear-model-gaps", Tag: "Upstream Keys",
			Summary:     "Clear the Model Gaps of many Upstream Keys of a Provider, each by name or ID",
			Description: clearGapsDescription + ` Body {"items": ["key-1", "uk_..."]}; one Audit Entry covers them all.`,
			Query:       []api.Param{audit.DryRun, gapModelParam},
			Request:     audit.BulkRequest[string]{}, Response: audit.BulkResult[UpstreamKey]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[string]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				p, err := resolveProvider(c.R.Context(), h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				var sl stateLogs
				res, err := audit.Bulk(h.tr, c, "model_gap.clear", "Cleared", in.Items, func(m *audit.Mutation, s string) (UpstreamKey, error) {
					id, err := resolveChild(m.Ctx, m.Tx, "upstream_keys", "Upstream Key", "keys", p, s)
					if err != nil {
						return UpstreamKey{}, err
					}
					return h.clearKeyGaps(m, p, id, c.Query("model"), &sl)
				})
				if err == nil && !res.DryRun {
					sl.emit(h.log, p.handle)
				}
				return res, err
			},
		},
	}
}

func (h handlers) clearKeyGaps(m *audit.Mutation, p ref, id, model string, sl *stateLogs) (UpstreamKey, error) {
	k, err := readKey(m.Ctx, m.Tx, id, m.Now)
	if err != nil {
		return k, err
	}
	if err := clearGaps(m, p, k.ID, k.Name, model, "Cleared by "+m.Actor.Name+".", sl); err != nil {
		return k, err
	}
	return readKey(m.Ctx, m.Tx, id, m.Now)
}

func clearGaps(m *audit.Mutation, p ref, id, name, model, why string, sl *stateLogs) error {
	evs, err := keystate.ClearGaps(m.Ctx, m.Tx, keystate.Key{ID: id, Name: name, Provider: p.handle}, model, why, m.Now,
		func(gid string) error { return m.Track(keystate.GapResource, gid) })
	if err == nil && sl != nil {
		sl.gaps = append(sl.gaps, evs...)
	}
	return err
}
