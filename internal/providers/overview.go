package providers

import (
	"context"
	"database/sql"
	"net/http"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/store"
)

// Overview is every Provider and Model Pool at a glance (the UI's Providers
// page): keys by Key State, models, and traffic since a time.
type Overview struct {
	Since     time.Time          `json:"since" doc:"Start of the window traffic is counted over."`
	Providers []ProviderOverview `json:"providers" doc:"Every Provider, by handle."`
	Pools     []PoolOverview     `json:"pools" doc:"Every Model Pool, by name."`
}

// Traffic counts Requests in the window.
type Traffic struct {
	Requests      int        `json:"requests" doc:"Requests in the window, in progress included."`
	Succeeded     int        `json:"succeeded" doc:"Finished with a status below 400."`
	Failed        int        `json:"failed" doc:"Finished with a status from 400, or interrupted. The success rate is succeeded / (succeeded + failed)."`
	LastRequestAt *time.Time `json:"last_request_at,omitempty" doc:"Start of the latest Request in the window."`
}

// ProviderOverview is one Provider at a glance.
type ProviderOverview struct {
	Provider string    `json:"provider" doc:"Handle."`
	Keys     KeyCounts `json:"keys" doc:"Upstream Keys in each Key State."`
	Models   int       `json:"models" doc:"Models listed to Callers (discovered or added, not hidden)."`
	Traffic
}

// PoolOverview is one Model Pool at a glance.
type PoolOverview struct {
	Pool string `json:"pool" doc:"Name."`
	Traffic
	ServedBy []ServedBy `json:"served_by" doc:"Requests for the Pool by the Provider that served them (the last one tried), most first."`
}

// ServedBy counts a Pool's Requests one Provider served.
type ServedBy struct {
	Provider  string `json:"provider" doc:"Handle; empty for Requests no Provider was tried for."`
	Requests  int    `json:"requests"`
	Succeeded int    `json:"succeeded"`
}

const succeeded = "state = 'completed' AND status >= 100 AND status < 400"
const failed = "state != 'in_progress' AND (status >= 400 OR status < 100)"

// OverviewRoutes serves GET /api/overview.
func OverviewRoutes(db *store.DB) []api.Route {
	return []api.Route{{
		Method: http.MethodGet, Path: "/api/overview", Tag: "Providers",
		Summary: "Show every Provider and Model Pool at a glance: keys by Key State, models and recent traffic",
		Description: "One call for a list of Providers and Pools. For one Provider's details read GET /api/providers/{provider}/summary; " +
			"for traffic by any other cut, GET /api/requests/stats.",
		Query: []api.Param{
			{Name: "since", Description: "Count traffic from this time: RFC 3339, or a duration back from now such as 24h. Default 24h."},
		},
		Response: Overview{},
		Handle: func(c *api.Call) (any, error) {
			now := db.Clock().Now()
			since := now.Add(-24 * time.Hour)
			if s := strings.TrimSpace(c.Query("since")); s != "" {
				if t, err := time.Parse(time.RFC3339, s); err == nil {
					since = t
				} else if d, err := time.ParseDuration(s); err == nil && d > 0 {
					since = now.Add(-d)
				} else {
					return nil, api.BadRequest("Use an RFC 3339 time such as 2026-11-19T00:00:00Z, or a duration such as 24h.", "since %q is not a time or a duration.", s)
				}
			}
			return overview(c.R.Context(), db, since, now)
		},
	}}
}

func overview(ctx context.Context, db *store.DB, since, now time.Time) (Overview, error) {
	out := Overview{Since: since, Providers: []ProviderOverview{}, Pools: []PoolOverview{}}
	from := store.Millis(since)

	traffic := func(col string) (map[string]Traffic, error) {
		rows, err := db.QueryContext(ctx, `SELECT `+col+`, count(*), coalesce(sum(`+succeeded+`), 0), coalesce(sum(`+failed+`), 0), max(started_at)
			FROM requests WHERE started_at >= ? AND `+col+` != '' GROUP BY `+col, from)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		m := map[string]Traffic{}
		for rows.Next() {
			var k string
			var t Traffic
			var last sql.NullInt64
			if err := rows.Scan(&k, &t.Requests, &t.Succeeded, &t.Failed, &last); err != nil {
				return nil, err
			}
			if last.Valid {
				at := store.FromMillis(last.Int64)
				t.LastRequestAt = &at
			}
			m[k] = t
		}
		return m, rows.Err()
	}
	byProvider, err := traffic("provider_handle")
	if err != nil {
		return out, err
	}
	byPool, err := traffic("pool")
	if err != nil {
		return out, err
	}

	rows, err := db.QueryContext(ctx, `SELECT p.id, p.handle, (SELECT count(*) FROM provider_models m WHERE m.provider_id = p.id AND m.hidden = 0
		AND (m.added = 1 OR EXISTS (SELECT 1 FROM provider_model_sources s WHERE s.provider_id = m.provider_id AND s.model = m.model)))
		FROM providers p ORDER BY p.handle`)
	if err != nil {
		return out, err
	}
	type prov struct {
		id string
		o  ProviderOverview
	}
	var list []prov
	for rows.Next() {
		var p prov
		if err := rows.Scan(&p.id, &p.o.Provider, &p.o.Models); err != nil {
			rows.Close()
			return out, err
		}
		list = append(list, p)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, p := range list {
		keys, err := listKeys(ctx, db, p.id, now)
		if err != nil {
			return out, err
		}
		for _, k := range keys {
			p.o.Keys.Total++
			switch k.State.State {
			case keystate.Active:
				p.o.Keys.Active++
			case keystate.Disabled:
				p.o.Keys.Disabled++
			case keystate.Invalid:
				p.o.Keys.Invalid++
			case keystate.Cooling:
				p.o.Keys.Cooling++
			}
		}
		p.o.Traffic = byProvider[p.o.Provider]
		out.Providers = append(out.Providers, p.o)
	}

	served := map[string][]ServedBy{}
	srows, err := db.QueryContext(ctx, `SELECT pool, provider_handle, count(*), coalesce(sum(`+succeeded+`), 0) FROM requests
		WHERE started_at >= ? AND pool != '' GROUP BY pool, provider_handle ORDER BY count(*) DESC, provider_handle`, from)
	if err != nil {
		return out, err
	}
	for srows.Next() {
		var pool string
		var s ServedBy
		if err := srows.Scan(&pool, &s.Provider, &s.Requests, &s.Succeeded); err != nil {
			srows.Close()
			return out, err
		}
		served[pool] = append(served[pool], s)
	}
	srows.Close()
	if err := srows.Err(); err != nil {
		return out, err
	}
	prows, err := db.QueryContext(ctx, `SELECT name FROM pools ORDER BY name, id`)
	if err != nil {
		return out, err
	}
	defer prows.Close()
	for prows.Next() {
		var name string
		if err := prows.Scan(&name); err != nil {
			return out, err
		}
		o := PoolOverview{Pool: name, Traffic: byPool[name], ServedBy: served[name]}
		if o.ServedBy == nil {
			o.ServedBy = []ServedBy{}
		}
		out.Pools = append(out.Pools, o)
	}
	return out, prows.Err()
}
