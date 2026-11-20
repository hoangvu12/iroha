package requests

import (
	"context"
	"slices"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/store"
)

// Stats summarises the Requests matching a filter (the stats row above the
// Requests feed).
type Stats struct {
	Requests          int          `json:"requests" doc:"Requests matching the filters, in progress included."`
	InProgress        int          `json:"in_progress"`
	Succeeded         int          `json:"succeeded" doc:"Finished with a status below 400."`
	Failed            int          `json:"failed" doc:"Finished with a status from 400, or interrupted. The success rate is succeeded / (succeeded + failed)."`
	Retried           int          `json:"retried" doc:"Requests that needed more than one Attempt, whatever their outcome."`
	MedianDurationMs  *int64       `json:"median_duration_ms,omitempty" doc:"Median time from arrival to the end of the answer, over succeeded Requests."`
	MedianFirstByteMs *int64       `json:"median_first_byte_ms,omitempty" doc:"Median time to the first byte of the answer (first token, for streams), over succeeded Requests."`
	CacheHits         int          `json:"cache_hits" doc:"Requests whose answer read any prompt tokens from the Provider's cache (warm turns)."`
	Tokens            Tokens       `json:"tokens"`
	Groups            []StatsGroup `json:"groups,omitempty" doc:"With group_by: one row per group, most Requests first (at most 500)."`
}

// Tokens are summed token counts.
type Tokens struct {
	Input          int64 `json:"input" doc:"Every prompt token, cache reads and writes included."`
	Output         int64 `json:"output"`
	CacheRead      int64 `json:"cache_read" doc:"Part of input read from the Provider's prompt cache. The cached share is cache_read / input."`
	CacheWrite     int64 `json:"cache_write" doc:"Part of input written to the Provider's prompt cache."`
	CacheWriteLong int64 `json:"cache_write_long" doc:"Part of cache_write kept for the Provider's longer lifetime (Anthropic's 1 h, OpenAI's 12 h)."`
	Reasoning      int64 `json:"reasoning" doc:"Part of output spent on reasoning."`
	Total          int64 `json:"total" doc:"input + output."`
}

// StatsGroup is one group of GET /api/requests/stats?group_by=. Only the
// fields of the dimensions grouped by are set; one a Request has no value
// for (no key served it, say) is left out.
type StatsGroup struct {
	Provider      string  `json:"provider,omitempty" doc:"group_by=provider or upstream_key: the Provider's handle."`
	UpstreamKeyID string  `json:"upstream_key_id,omitempty" doc:"group_by=upstream_key: the key that served the Requests."`
	UpstreamKey   string  `json:"upstream_key,omitempty" doc:"group_by=upstream_key: the key's name on the group's latest Request."`
	Model         string  `json:"model,omitempty" doc:"group_by=model: the model as the Caller named it."`
	Caller        *Caller `json:"caller,omitempty" doc:"group_by=caller."`
	Requests      int     `json:"requests"`
	CacheHits     int     `json:"cache_hits" doc:"Requests whose answer read any prompt tokens from the cache."`
	Tokens        Tokens  `json:"tokens"`
}

// groupBy are the group_by values and the columns each groups by.
var groupBy = map[string][]string{
	"provider":     {"provider_handle"},
	"upstream_key": {"upstream_key_id"},
	"model":        {"model"},
	"caller":       {"caller_kind", "caller_name"},
}

const maxGroups = 500

// parseGroupBy reads the repeatable group_by parameter, in the order given.
func parseGroupBy(vals []string) ([]string, error) {
	var out []string
	for _, v := range vals {
		if _, ok := groupBy[v]; !ok {
			return nil, api.BadRequest("Use group_by=provider, upstream_key, model or caller; repeat it to combine them.", "group_by %q is not something Requests are grouped by.", v)
		}
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out, nil
}

// tokenSums are the sums of a Stats or StatsGroup, scanned by Tokens.dest.
const tokenSums = `coalesce(sum(cache_read_tokens > 0), 0), coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),
	coalesce(sum(cache_read_tokens), 0), coalesce(sum(cache_write_tokens), 0), coalesce(sum(cache_write_long_tokens), 0), coalesce(sum(reasoning_tokens), 0)`

func (t *Tokens) dest(hits *int) []any {
	return []any{hits, &t.Input, &t.Output, &t.CacheRead, &t.CacheWrite, &t.CacheWriteLong, &t.Reasoning}
}

const succeededCond = "state = '" + StateCompleted + "' AND status >= 100 AND status < 400"

func stats(ctx context.Context, db *store.DB, f filter, dims []string) (Stats, error) {
	var s Stats
	err := db.QueryRowContext(ctx, `SELECT count(*),
		coalesce(sum(state = '`+StateInProgress+`'), 0),
		coalesce(sum(`+succeededCond+`), 0),
		coalesce(sum(attempt_count > 1), 0), `+tokenSums+`
		FROM requests`+f.clause(), f.args...).
		Scan(append([]any{&s.Requests, &s.InProgress, &s.Succeeded, &s.Retried}, s.Tokens.dest(&s.CacheHits)...)...)
	if err != nil {
		return s, err
	}
	s.Failed = s.Requests - s.InProgress - s.Succeeded
	s.Tokens.Total = s.Tokens.Input + s.Tokens.Output
	ok := f.and(succeededCond)
	if s.MedianDurationMs, err = median(ctx, db, ok, "duration_ms"); err != nil {
		return s, err
	}
	if s.MedianFirstByteMs, err = median(ctx, db, ok, "first_byte_ms"); err != nil {
		return s, err
	}
	if len(dims) > 0 {
		s.Groups, err = groups(ctx, db, f, dims)
	}
	return s, err
}

// groups sums the Requests of f per group of dims. The names beside the
// grouped IDs (a key's name and Provider, a Caller's Gateway Key) are the
// group's latest Request's: SQLite takes bare columns from the row that the
// query's one max() picked.
func groups(ctx context.Context, db *store.DB, f filter, dims []string) ([]StatsGroup, error) {
	var cols []string
	for _, d := range dims {
		cols = append(cols, groupBy[d]...)
	}
	list := strings.Join(cols, ", ")
	rows, err := db.QueryContext(ctx, `SELECT `+list+`, max(rowid), provider_handle, upstream_key_name, gateway_key_id, count(*), `+tokenSums+`
		FROM requests`+f.clause()+` GROUP BY `+list+` ORDER BY count(*) DESC, `+list+` LIMIT ?`, slices.Concat(f.args, []any{maxGroups})...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []StatsGroup{}
	for rows.Next() {
		var g StatsGroup
		vals := make([]string, len(cols))
		var latest int64
		var provider, keyName, gatewayKey string
		dest := make([]any, 0, len(cols)+12)
		for i := range vals {
			dest = append(dest, &vals[i])
		}
		dest = append(dest, &latest, &provider, &keyName, &gatewayKey, &g.Requests)
		if err := rows.Scan(append(dest, g.Tokens.dest(&g.CacheHits)...)...); err != nil {
			return nil, err
		}
		g.Tokens.Total = g.Tokens.Input + g.Tokens.Output
		at := 0
		for _, d := range dims {
			switch d {
			case "provider":
				g.Provider = vals[at]
			case "upstream_key":
				if g.UpstreamKeyID = vals[at]; g.UpstreamKeyID != "" {
					g.Provider, g.UpstreamKey = provider, keyName
				}
			case "model":
				g.Model = vals[at]
			case "caller":
				g.Caller = &Caller{Kind: vals[at], Name: vals[at+1]}
				if g.Caller.Kind == CallerGatewayKey {
					g.Caller.GatewayKeyID = gatewayKey
				}
			}
			at += len(groupBy[d])
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// median of col over the rows of f that have it; nil when none do. An even
// count averages the two middle values.
func median(ctx context.Context, db *store.DB, f filter, col string) (*int64, error) {
	f = f.and(col + " IS NOT NULL")
	var n int64
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM requests`+f.clause(), f.args...).Scan(&n); err != nil || n == 0 {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT `+col+` FROM requests`+f.clause()+` ORDER BY `+col+` LIMIT ? OFFSET ?`,
		slices.Concat(f.args, []any{2 - n%2, (n - 1) / 2})...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var sum, k int64
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			return nil, err
		}
		sum, k = sum+v, k+1
	}
	if err := rows.Err(); err != nil || k == 0 {
		return nil, err
	}
	m := sum / k
	return &m, nil
}

// FilterOptions lists the values the Request filters can take in a time
// window, most used first, so a filter menu offers only what exists.
type FilterOptions struct {
	Callers   []CallerOption `json:"callers"`
	Providers []Option       `json:"providers"`
	Pools     []Option       `json:"pools"`
	Models    []Option       `json:"models"`
}

// CallerOption is one Caller seen in the window.
type CallerOption struct {
	Name         string `json:"name" doc:"Pass as caller=."`
	Kind         string `json:"kind" enum:"gateway_key,test"`
	GatewayKeyID string `json:"gateway_key_id,omitempty"`
	Requests     int    `json:"requests"`
}

// Option is one filter value and how many Requests have it.
type Option struct {
	Name     string `json:"name"`
	Requests int    `json:"requests"`
}

const maxOptions = 200

func filterOptions(ctx context.Context, db *store.DB, f filter) (FilterOptions, error) {
	out := FilterOptions{Callers: []CallerOption{}, Providers: []Option{}, Pools: []Option{}, Models: []Option{}}
	rows, err := db.QueryContext(ctx, `SELECT caller_kind, caller_name, max(CASE WHEN caller_kind = '`+CallerGatewayKey+`' THEN gateway_key_id ELSE '' END), count(*)
		FROM requests`+f.clause()+` GROUP BY caller_kind, caller_name ORDER BY count(*) DESC, caller_name LIMIT ?`, slices.Concat(f.args, []any{maxOptions})...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var o CallerOption
		if err := rows.Scan(&o.Kind, &o.Name, &o.GatewayKeyID, &o.Requests); err != nil {
			rows.Close()
			return out, err
		}
		out.Callers = append(out.Callers, o)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return out, err
	}
	for _, g := range []struct {
		col string
		to  *[]Option
	}{{"provider_handle", &out.Providers}, {"pool", &out.Pools}, {"model", &out.Models}} {
		ff := f.and(g.col + " != ''")
		rows, err := db.QueryContext(ctx, `SELECT `+g.col+`, count(*) FROM requests`+ff.clause()+` GROUP BY `+g.col+` ORDER BY count(*) DESC, `+g.col+` LIMIT ?`,
			slices.Concat(ff.args, []any{maxOptions})...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var o Option
			if err := rows.Scan(&o.Name, &o.Requests); err != nil {
				rows.Close()
				return out, err
			}
			*g.to = append(*g.to, o)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return out, err
		}
	}
	return out, nil
}
