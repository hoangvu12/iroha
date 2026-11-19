package requests

import (
	"context"
	"slices"

	"github.com/hoangvu12/iroha/internal/store"
)

// Stats summarises the Requests matching a filter (the stats row above the
// Requests feed).
type Stats struct {
	Requests          int    `json:"requests" doc:"Requests matching the filters, in progress included."`
	InProgress        int    `json:"in_progress"`
	Succeeded         int    `json:"succeeded" doc:"Finished with a status below 400."`
	Failed            int    `json:"failed" doc:"Finished with a status from 400, or interrupted. The success rate is succeeded / (succeeded + failed)."`
	Retried           int    `json:"retried" doc:"Requests that needed more than one Attempt, whatever their outcome."`
	MedianDurationMs  *int64 `json:"median_duration_ms,omitempty" doc:"Median time from arrival to the end of the answer, over succeeded Requests."`
	MedianFirstByteMs *int64 `json:"median_first_byte_ms,omitempty" doc:"Median time to the first byte of the answer (first token, for streams), over succeeded Requests."`
	Tokens            Tokens `json:"tokens"`
}

// Tokens are summed token counts.
type Tokens struct {
	Input     int64 `json:"input"`
	Output    int64 `json:"output"`
	CacheRead int64 `json:"cache_read" doc:"Part of input read from the Provider's prompt cache."`
	Reasoning int64 `json:"reasoning" doc:"Part of output spent on reasoning."`
	Total     int64 `json:"total" doc:"input + output."`
}

const succeededCond = "state = '" + StateCompleted + "' AND status >= 100 AND status < 400"

func stats(ctx context.Context, db *store.DB, f filter) (Stats, error) {
	var s Stats
	err := db.QueryRowContext(ctx, `SELECT count(*),
		coalesce(sum(state = '`+StateInProgress+`'), 0),
		coalesce(sum(`+succeededCond+`), 0),
		coalesce(sum(attempt_count > 1), 0),
		coalesce(sum(input_tokens), 0), coalesce(sum(output_tokens), 0),
		coalesce(sum(cache_read_tokens), 0), coalesce(sum(reasoning_tokens), 0)
		FROM requests`+f.clause(), f.args...).
		Scan(&s.Requests, &s.InProgress, &s.Succeeded, &s.Retried, &s.Tokens.Input, &s.Tokens.Output, &s.Tokens.CacheRead, &s.Tokens.Reasoning)
	if err != nil {
		return s, err
	}
	s.Failed = s.Requests - s.InProgress - s.Succeeded
	s.Tokens.Total = s.Tokens.Input + s.Tokens.Output
	ok := f.and(succeededCond)
	if s.MedianDurationMs, err = median(ctx, db, ok, "duration_ms"); err != nil {
		return s, err
	}
	s.MedianFirstByteMs, err = median(ctx, db, ok, "first_byte_ms")
	return s, err
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
