package providers

import (
	"fmt"
	"net/http"
	"slices"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/keystate"
)

type EndpointGapEntry struct {
	UpstreamKey string `json:"upstream_key" doc:"Name of the key."`
	keystate.EndpointGap
}

type EndpointGapList struct {
	EndpointGaps []EndpointGapEntry `json:"endpoint_gaps"`
}

func endpointGapEntries(k UpstreamKey) []EndpointGapEntry {
	out := make([]EndpointGapEntry, 0, len(k.EndpointGaps))
	for _, g := range k.EndpointGaps {
		out = append(out, EndpointGapEntry{UpstreamKey: k.Name, EndpointGap: g})
	}
	return out
}

var gapEndpointParam = api.Param{Name: "endpoint", Description: "Only the Endpoint Gaps on this Endpoint (name or ID). Default: every Endpoint."}

const clearEndpointGapsDescription = "A cleared Endpoint Gap lets the key reach that Endpoint again at once; if the Provider still refuses it there, the next Request records the gap again (one Attempt). " +
	"Gaps never expire; they also clear when a key test passes on that Endpoint, an Attempt there succeeds, the key's secret or Endpoint restriction is edited, or the key becomes invalid. Revertible through the Audit Entry."

const restrictDescription = "Sets the key's Endpoint restriction to the Endpoints it may use now minus those it has an Endpoint Gap on, which clears its gaps (they are on Endpoints it no longer goes to). " +
	"unchanged when the key has no Endpoint Gap; 409 no_working_endpoint when it has one on every Endpoint it may use. One Audit Entry; reverting it restores the restriction and the gaps."

func (h handlers) endpointGapRoutes() []api.Route {
	const tag = "Upstream Keys"
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/providers/{provider}/endpoint-gaps", Tag: tag,
			Summary:     "List a Provider's Endpoint Gaps: which key was refused on which Endpoint after it worked on another",
			Description: "Each key also lists its own gaps in endpoint_gaps, and where it has worked in worked_on (GET /api/providers/{provider}/keys).",
			Query:       []api.Param{gapEndpointParam, {Name: "upstream_key", Description: "Only this key's gaps (name or ID)."}},
			Response:    EndpointGapList{},
			Handle: func(c *api.Call) (any, error) {
				ctx := c.R.Context()
				p, err := resolveProvider(ctx, h.db, c.Path("provider"))
				if err != nil {
					return nil, err
				}
				keyID, epID := "", ""
				if ref := c.Query("upstream_key"); ref != "" {
					if keyID, err = resolveChild(ctx, h.db, "upstream_keys", "Upstream Key", "keys", p, ref); err != nil {
						return nil, err
					}
				}
				if ref := c.Query("endpoint"); ref != "" {
					if epID, err = resolveChild(ctx, h.db, "endpoints", "Endpoint", "endpoints", p, ref); err != nil {
						return nil, err
					}
				}
				keys, err := listKeys(ctx, h.db, p.id, h.db.Clock().Now())
				if err != nil {
					return nil, err
				}
				out := EndpointGapList{EndpointGaps: []EndpointGapEntry{}}
				for _, k := range keys {
					if keyID != "" && k.ID != keyID {
						continue
					}
					for _, g := range endpointGapEntries(k) {
						if epID == "" || g.EndpointID == epID {
							out.EndpointGaps = append(out.EndpointGaps, g)
						}
					}
				}
				return out, nil
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/{key}/clear-endpoint-gaps", Tag: tag,
			Summary: "Clear an Upstream Key's Endpoint Gaps", Description: clearEndpointGapsDescription,
			Query:    []api.Param{audit.DryRun, gapEndpointParam},
			Response: UpstreamKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				return h.oneKey(c, "endpoint_gap.clear", "Cleared", func(m *audit.Mutation, p ref, id string, sl *stateLogs) (UpstreamKey, error) {
					return h.clearKeyEndpointGaps(m, p, id, c.Query("endpoint"), sl)
				})
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/bulk/clear-endpoint-gaps", Tag: tag,
			Summary:     "Clear the Endpoint Gaps of many Upstream Keys of a Provider, each by name or ID",
			Description: clearEndpointGapsDescription + ` Body {"items": ["key-1", "uk_..."]}; one Audit Entry covers them all.`,
			Query:       []api.Param{audit.DryRun, gapEndpointParam},
			Request:     audit.BulkRequest[string]{}, Response: audit.BulkResult[UpstreamKey]{},
			Handle: func(c *api.Call) (any, error) {
				return h.manyKeys(c, "endpoint_gap.clear", "Cleared", func(m *audit.Mutation, p ref, id string, sl *stateLogs) (UpstreamKey, error) {
					return h.clearKeyEndpointGaps(m, p, id, c.Query("endpoint"), sl)
				})
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/{key}/restrict-to-working-endpoints", Tag: tag,
			Summary: "Restrict an Upstream Key to the Endpoints it has no Endpoint Gap on", Description: restrictDescription,
			Query:    []api.Param{audit.DryRun},
			Response: UpstreamKeyResult{},
			Handle: func(c *api.Call) (any, error) {
				return h.oneKey(c, "upstream_key.restrict_to_working", "Restricted", h.restrictToWorking)
			},
		},
		{
			Method: http.MethodPost, Path: "/api/providers/{provider}/keys/bulk/restrict-to-working-endpoints", Tag: tag,
			Summary:     "Restrict many Upstream Keys of a Provider to the Endpoints each has no Endpoint Gap on",
			Description: restrictDescription + ` Body {"items": ["key-1", "uk_..."]}; each item is applied or refused on its own, one Audit Entry covers them all.`,
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[string]{}, Response: audit.BulkResult[UpstreamKey]{},
			Handle: func(c *api.Call) (any, error) {
				return h.manyKeys(c, "upstream_key.restrict_to_working", "Restricted", h.restrictToWorking)
			},
		},
	}
}

type keyChange func(m *audit.Mutation, p ref, id string, sl *stateLogs) (UpstreamKey, error)

func (h handlers) oneKey(c *api.Call, action, verb string, fn keyChange) (UpstreamKeyResult, error) {
	var out UpstreamKey
	var p ref
	var sl stateLogs
	res, err := h.tr.Mutate(c, action, verb, func(m *audit.Mutation) error {
		var err error
		if p, err = resolveProvider(m.Ctx, m.Tx, c.Path("provider")); err != nil {
			return err
		}
		id, err := resolveChild(m.Ctx, m.Tx, "upstream_keys", "Upstream Key", "keys", p, c.Path("key"))
		if err != nil {
			return err
		}
		out, err = fn(m, p, id, &sl)
		return err
	})
	if err == nil && !res.DryRun {
		sl.emit(h.log, p.handle)
	}
	return UpstreamKeyResult{Result: res, UpstreamKey: out}, err
}

func (h handlers) manyKeys(c *api.Call, action, verb string, fn keyChange) (audit.BulkResult[UpstreamKey], error) {
	var in audit.BulkRequest[string]
	if err := c.Decode(&in); err != nil {
		return audit.BulkResult[UpstreamKey]{}, err
	}
	p, err := resolveProvider(c.R.Context(), h.db, c.Path("provider"))
	if err != nil {
		return audit.BulkResult[UpstreamKey]{}, err
	}
	var sl stateLogs
	res, err := audit.Bulk(h.tr, c, action, verb, in.Items, func(m *audit.Mutation, s string) (UpstreamKey, error) {
		id, err := resolveChild(m.Ctx, m.Tx, "upstream_keys", "Upstream Key", "keys", p, s)
		if err != nil {
			return UpstreamKey{}, err
		}
		return fn(m, p, id, &sl)
	})
	if err == nil && !res.DryRun {
		sl.emit(h.log, p.handle)
	}
	return res, err
}

func (h handlers) clearKeyEndpointGaps(m *audit.Mutation, p ref, id, endpoint string, sl *stateLogs) (UpstreamKey, error) {
	epID := ""
	if endpoint != "" {
		var err error
		if epID, err = resolveChild(m.Ctx, m.Tx, "endpoints", "Endpoint", "endpoints", p, endpoint); err != nil {
			return UpstreamKey{}, err
		}
	}
	k, err := readKey(m.Ctx, m.Tx, id, m.Now)
	if err != nil {
		return k, err
	}
	if err := clearEndpointGaps(m, p, k.ID, k.Name, epID, "Cleared by "+m.Actor.Name+".", sl); err != nil {
		return k, err
	}
	return readKey(m.Ctx, m.Tx, id, m.Now)
}

func (h handlers) restrictToWorking(m *audit.Mutation, p ref, id string, sl *stateLogs) (UpstreamKey, error) {
	k, err := readKey(m.Ctx, m.Tx, id, m.Now)
	if err != nil {
		return k, err
	}
	if len(k.EndpointGaps) == 0 {
		return k, nil
	}
	eps, err := listEndpoints(m.Ctx, m.Tx, p.id)
	if err != nil {
		return k, err
	}
	gapped := map[string]bool{}
	for _, g := range k.EndpointGaps {
		gapped[g.EndpointID] = true
	}
	working := []string{}
	for _, e := range eps {
		if (len(k.Endpoints) == 0 || slices.Contains(k.Endpoints, e.Name)) && !gapped[e.ID] {
			working = append(working, e.ID)
		}
	}
	if len(working) == 0 {
		names := make([]string, 0, len(k.EndpointGaps))
		for _, g := range k.EndpointGaps {
			names = append(names, g.Endpoint)
		}
		return k, api.Conflict("no_working_endpoint",
			fmt.Sprintf("Test the key (POST /api/providers/%s/keys/%s/test?endpoint=<name>), clear its gaps (.../clear-endpoint-gaps), or replace its secret.", p.handle, k.Name),
			"Upstream Key %s has an Endpoint Gap on every Endpoint it may use (%s), so restricting it would leave it nowhere to go.", k.Name, strings.Join(names, ", "))
	}
	return h.updateKey(m, p, id, UpdateUpstreamKey{Endpoints: &working}, sl)
}

func clearEndpointGaps(m *audit.Mutation, p ref, id, name, endpointID, why string, sl *stateLogs) error {
	evs, err := keystate.ClearEndpointGaps(m.Ctx, m.Tx, keystate.Key{ID: id, Name: name, Provider: p.handle}, endpointID, why,
		func(gid string) error { return m.Track(keystate.EndpointGapResource, gid) })
	if err == nil && sl != nil {
		sl.egaps = append(sl.egaps, evs...)
	}
	return err
}
