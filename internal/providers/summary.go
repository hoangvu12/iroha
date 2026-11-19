package providers

import (
	"net/http"
	"slices"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/normalise"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
)

// ProviderSummary answers "what is wrong with this Provider" in one call.
type ProviderSummary struct {
	Provider       string             `json:"provider" doc:"Handle of the Provider."`
	Enabled        bool               `json:"enabled"`
	Archived       bool               `json:"archived"`
	Budget         Budget             `json:"budget"`
	Keys           KeyCounts          `json:"keys" doc:"How many Upstream Keys are in each Key State."`
	Cooling        []CoolingEntry     `json:"cooling" doc:"Every current cooling, of a whole key (model empty) or of a key for one model, soonest end first."`
	NextUsableAt   *time.Time         `json:"next_usable_at,omitempty" doc:"When no key is active: the earliest time one is usable again (absent when none will be without the Owner)."`
	ModelGaps      []GapEntry         `json:"model_gaps" doc:"Every live Model Gap: a key the Provider refused one model, soonest expiry first."`
	EndpointGaps   []EndpointGapEntry `json:"endpoint_gaps" doc:"Every Endpoint Gap: a key the Provider refused on one Endpoint after it worked on another, in key order."`
	RecentAttempts AttemptStats       `json:"recent_attempts" doc:"Attempts on this Provider in the last hour."`
	Normalisers    []Normaliser       `json:"normalisers" doc:"The built-in normalisers that rewrite this Provider's requests or answers, chosen by each Endpoint's Shape and host."`
}

// Normaliser is a built-in normaliser and the Endpoints it applies to.
type Normaliser struct {
	normalise.Normaliser
	Endpoints []string `json:"endpoints" doc:"Names of the Endpoints it applies to."`
}

// normalisers lists the normalisers applying to any of eps, in built-in order.
func normalisers(eps []Endpoint) []Normaliser {
	on := map[string][]string{}
	for _, e := range eps {
		for _, n := range normalise.Applying(e.URL, shape.Shape(e.Shape)) {
			on[n.Name] = append(on[n.Name], e.Name)
		}
	}
	out := []Normaliser{}
	for _, n := range normalise.Builtin {
		if eps := on[n.Name]; len(eps) > 0 {
			out = append(out, Normaliser{Normaliser: n, Endpoints: eps})
		}
	}
	return out
}

// KeyCounts counts Upstream Keys by Key State.
type KeyCounts struct {
	Total    int `json:"total"`
	Active   int `json:"active"`
	Disabled int `json:"disabled"`
	Invalid  int `json:"invalid"`
	Cooling  int `json:"cooling"`
	Keyless  int `json:"keyless" doc:"Keys with no secret (keyless keys, counted in their Key State too): they send no credential."`
}

// count adds k to the counts.
func (c *KeyCounts) count(k UpstreamKey) {
	c.Total++
	switch k.State.State {
	case keystate.Active:
		c.Active++
	case keystate.Disabled:
		c.Disabled++
	case keystate.Invalid:
		c.Invalid++
	case keystate.Cooling:
		c.Cooling++
	}
	if k.Secret == "" {
		c.Keyless++
	}
}

// CoolingEntry is one current cooling.
type CoolingEntry struct {
	UpstreamKey string    `json:"upstream_key" doc:"Name of the key."`
	Model       string    `json:"model,omitempty" doc:"Set when the key cools only for this model."`
	Until       time.Time `json:"until"`
	Reason      string    `json:"reason"`
}

// AttemptStats counts recent Attempts.
type AttemptStats struct {
	Since       time.Time `json:"since"`
	Attempts    int       `json:"attempts"`
	Failed      int       `json:"failed" doc:"Attempts without a 2xx answer."`
	FailureRate float64   `json:"failure_rate" doc:"failed / attempts, 0 when there were none."`
}

func (h handlers) summaryRoute() api.Route {
	return api.Route{
		Method: http.MethodGet, Path: "/api/providers/{provider}/summary", Tag: "Providers",
		Summary:     "Summarise a Provider's health: Key State counts, coolings, Model Gaps, Endpoint Gaps and recent failures",
		Description: "Read each key's reason with GET /api/providers/{provider}/keys and failed Attempts with GET /api/requests?provider=<handle>&status=5xx.",
		Response:    ProviderSummary{},
		Handle: func(c *api.Call) (any, error) {
			ctx := c.R.Context()
			id, err := Resource.Resolve(ctx, h.db, c.Path("provider"))
			if err != nil {
				return nil, err
			}
			p, err := readProvider(ctx, h.db, id)
			if err != nil {
				return nil, err
			}
			now := h.db.Clock().Now().UTC()
			keys, err := listKeys(ctx, h.db, id, now)
			if err != nil {
				return nil, err
			}
			out := ProviderSummary{Provider: p.Handle, Enabled: p.Enabled, Archived: p.Archived, Budget: p.Budget, Cooling: []CoolingEntry{}, ModelGaps: []GapEntry{}, EndpointGaps: []EndpointGapEntry{}}
			var next time.Time
			for _, k := range keys {
				out.Keys.count(k)
				if k.State.State == keystate.Cooling {
					out.Cooling = append(out.Cooling, CoolingEntry{UpstreamKey: k.Name, Until: *k.State.Until, Reason: k.State.Reason})
					if next.IsZero() || k.State.Until.Before(next) {
						next = *k.State.Until
					}
				}
				for _, m := range k.CoolingModels {
					out.Cooling = append(out.Cooling, CoolingEntry{UpstreamKey: k.Name, Model: m.Model, Until: m.Until, Reason: m.Reason})
				}
				out.ModelGaps = append(out.ModelGaps, gapEntries(k)...)
				out.EndpointGaps = append(out.EndpointGaps, endpointGapEntries(k)...)
			}
			slices.SortStableFunc(out.Cooling, func(a, b CoolingEntry) int { return a.Until.Compare(b.Until) })
			sortGaps(out.ModelGaps)
			if out.Keys.Active == 0 && !next.IsZero() {
				out.NextUsableAt = &next
			}
			since := now.Add(-time.Hour)
			out.RecentAttempts.Since = since
			if err := h.db.QueryRowContext(ctx, `SELECT count(*), coalesce(sum(status < 200 OR status >= 300), 0) FROM attempts
				WHERE provider_id = ? AND started_at >= ?`, id, store.Millis(since)).
				Scan(&out.RecentAttempts.Attempts, &out.RecentAttempts.Failed); err != nil {
				return nil, err
			}
			if out.RecentAttempts.Attempts > 0 {
				out.RecentAttempts.FailureRate = float64(out.RecentAttempts.Failed) / float64(out.RecentAttempts.Attempts)
			}
			eps, err := listEndpoints(ctx, h.db, id)
			if err != nil {
				return nil, err
			}
			out.Normalisers = normalisers(eps)
			return out, nil
		},
	}
}
