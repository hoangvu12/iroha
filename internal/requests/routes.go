package requests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
)

// RequestPage is a page of Requests, newest first.
type RequestPage struct {
	Requests   []Request `json:"requests"`
	NextBefore string    `json:"next_before,omitempty" doc:"Pass as before= to read the next older page; absent on the last page."`
	Cursor     int64     `json:"cursor" doc:"Pass as changed_after= to get only the Requests that started or changed after this page was read."`
}

const requestColumns = `id, started_at, finished_at, state, status, error_code, error_message, caller_kind, gateway_key_id, caller_name,
	route, shape_in, shape_out, model, stream, provider_id, provider_handle, endpoint_id, endpoint_name, upstream_key_id, upstream_key_name,
	wire_model, first_byte_ms, duration_ms, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, attempt_count, summary,
	pool, rev,
	EXISTS (SELECT 1 FROM captures c WHERE c.request_id = requests.id)`

func scanRequest(row interface{ Scan(...any) error }) (Request, error) {
	var r Request
	var started int64
	var finished, firstByte, duration, in, out, cache, reasoning sql.NullInt64
	var code, msg, shapeIn, shapeOut string
	err := row.Scan(&r.ID, &started, &finished, &r.State, &r.Status, &code, &msg, &r.Caller.Kind, &r.Caller.GatewayKeyID, &r.Caller.Name,
		&r.Route, &shapeIn, &shapeOut, &r.Model, &r.Stream, &r.ProviderID, &r.Provider, &r.EndpointID, &r.Endpoint, &r.UpstreamKeyID, &r.UpstreamKey,
		&r.WireModel, &firstByte, &duration, &in, &out, &cache, &reasoning, &r.AttemptCount, &r.Summary,
		&r.Pool, &r.rev,
		&r.Captured)
	if err != nil {
		return r, err
	}
	r.StartedAt = store.FromMillis(started)
	if finished.Valid {
		at := store.FromMillis(finished.Int64)
		r.FinishedAt = &at
	}
	if code != "" {
		r.Error = &Failure{Code: code, Message: msg}
	}
	r.ShapeIn, r.ShapeOut = shape.Shape(shapeIn), shape.Shape(shapeOut)
	r.FirstByteMs, r.DurationMs = msPtr(firstByte), msPtr(duration)
	r.Usage = usageOf(in, out, cache, reasoning)
	return r, nil
}

func attempts(ctx context.Context, db *store.DB, id string) ([]Attempt, error) {
	rows, err := db.QueryContext(ctx, `SELECT seq, started_at, provider_id, provider_handle, endpoint_id, endpoint_name, endpoint_url,
		upstream_key_id, upstream_key_name, wire_model, shape, status, error, first_byte_ms, duration_ms,
		input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, rule, outcome, reason, action, failure_headers, failure_body
		FROM attempts WHERE request_id = ? ORDER BY seq`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Attempt{}
	for rows.Next() {
		var a Attempt
		var started int64
		var sh string
		var firstByte, duration, in, outT, cache, reasoning sql.NullInt64
		var headers string
		if err := rows.Scan(&a.Seq, &started, &a.ProviderID, &a.Provider, &a.EndpointID, &a.Endpoint, &a.EndpointURL,
			&a.UpstreamKeyID, &a.UpstreamKey, &a.WireModel, &sh, &a.Status, &a.Error, &firstByte, &duration,
			&in, &outT, &cache, &reasoning, &a.Rule, &a.Outcome, &a.Reason, &a.Action, &headers, &a.FailureBody); err != nil {
			return nil, err
		}
		if headers != "" {
			_ = json.Unmarshal([]byte(headers), &a.FailureHeaders)
		}
		a.StartedAt, a.Shape = store.FromMillis(started), shape.Shape(sh)
		a.FirstByteMs, a.DurationMs = msPtr(firstByte), msPtr(duration)
		a.Usage = usageOf(in, outT, cache, reasoning)
		out = append(out, a)
	}
	return out, rows.Err()
}

const maxLimit = 1000

// Routes returns the Request history routes.
func Routes(db *store.DB) []api.Route {
	c := db.Clock()
	const tag = "Requests"
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/requests", Tag: tag,
			Summary: "List Requests, newest first, or follow new ones",
			Description: "Every Request a Caller with a valid Gateway Key made, refusals included, and test Requests from the chat. Filters combine with AND; " +
				"a repeated filter matches any of its values. Read one Request for its Attempts.\n\n" +
				"To follow the feed live, keep the `cursor` of a page and poll with `changed_after=<cursor>` (same filters) every few seconds: " +
				"you get only the Requests that started or changed since (an in-progress Request appears again when it finishes), oldest change first, " +
				"and a new `cursor`. When the page is full, ask again at once.",
			Query: append(slices.Clone(filterParams),
				api.Param{Name: "before", Description: "Only Requests older than this Request ID (paging; use next_before)."},
				api.Param{Name: "changed_after", Type: "integer", Description: "Only Requests that started or changed after this cursor (from a page's cursor), oldest change first. Not with before."},
				api.Param{Name: "limit", Type: "integer", Description: "Page size, default 100, at most 1000."},
			),
			Response: RequestPage{},
			Handle:   func(call *api.Call) (any, error) { return list(call, db, c) },
		},
		{
			Method: http.MethodGet, Path: "/api/requests/stats", Tag: tag,
			Summary:     "Summarise the Requests matching filters",
			Description: "Takes the same filters as GET /api/requests and counts the Requests they match: how many succeeded, failed and were retried, median duration and time to first token of succeeded Requests, and tokens.",
			Query:       filterParams,
			Response:    Stats{},
			Handle: func(call *api.Call) (any, error) {
				f, err := parseFilter(call.R.URL.Query(), c, false)
				if err != nil {
					return nil, err
				}
				return stats(call.R.Context(), db, f)
			},
		},
		{
			Method: http.MethodGet, Path: "/api/requests/filters", Tag: tag,
			Summary:     "List the Callers, Providers, Pools and models seen in Requests",
			Description: "The values GET /api/requests can be filtered by within a time window, each with its number of Requests, most used first (at most 200 each). Test callers are listed with kind test.",
			Query:       timeParams,
			Response:    FilterOptions{},
			Handle: func(call *api.Call) (any, error) {
				f, err := parseFilter(call.R.URL.Query(), c, true)
				if err != nil {
					return nil, err
				}
				return filterOptions(call.R.Context(), db, f)
			},
		},
		{
			Method: http.MethodGet, Path: "/api/requests/{request}", Tag: tag,
			Summary:  "Read one Request with its Attempts: each one's Failure Rule, outcome, action and the failure body and headers",
			Response: Request{},
			Handle: func(call *api.Call) (any, error) {
				ctx := call.R.Context()
				id := call.Path("request")
				r, err := scanRequest(db.QueryRowContext(ctx, `SELECT `+requestColumns+` FROM requests WHERE id = ?`, id))
				if errors.Is(err, sql.ErrNoRows) {
					return nil, requestNotFound(id)
				}
				if err != nil {
					return nil, err
				}
				r.Attempts, err = attempts(ctx, db, id)
				return r, err
			},
		},
		{
			Method: http.MethodGet, Path: "/api/requests/{request}/capture", Tag: tag,
			Summary:     "Read the captured prompt and response of a Request",
			Description: "Only Requests made with a Gateway Key that has capture on are captured, and captures are kept for retention.captures_days. A streamed answer is given both as sent and reassembled into one answer.",
			Response:    CaptureView{},
			Handle: func(call *api.Call) (any, error) {
				return readCapture(call.R.Context(), db, call.Path("request"))
			},
		},
	}
}

func list(call *api.Call, db *store.DB, c clock.Clock) (any, error) {
	ctx := call.R.Context()
	q := call.R.URL.Query()
	f, err := parseFilter(q, c, false)
	if err != nil {
		return nil, err
	}
	var cursor int64
	follow := q.Get("changed_after") != ""
	if follow {
		if q.Get("before") != "" {
			return nil, api.BadRequest("Use before= to page back through history, or changed_after= to follow new Requests, not both.", "before and changed_after cannot be combined.")
		}
		cursor, err = strconv.ParseInt(q.Get("changed_after"), 10, 64)
		if err != nil || cursor < 0 {
			return nil, api.BadRequest("Pass the cursor of a page you read from GET /api/requests.", "changed_after %q is not a cursor.", q.Get("changed_after"))
		}
	} else if s := q.Get("before"); s != "" {
		f.add("rowid < coalesce((SELECT rowid FROM requests WHERE id = ?), 0)", s)
	}
	// Read the newest change before the page: a change committed in between
	// then shows up on the next poll instead of never.
	var head int64
	if err := db.QueryRowContext(ctx, `SELECT coalesce(max(rev), 0) FROM requests`).Scan(&head); err != nil {
		return nil, err
	}
	if follow {
		f.add("rev > ? AND rev <= ?", cursor, head)
	}
	limit := 100
	if s := q.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxLimit {
			return nil, api.BadRequest("Use a limit between 1 and 1000.", "limit must be between 1 and %d.", maxLimit)
		}
		limit = n
	}
	order := " ORDER BY rowid DESC LIMIT ?"
	if follow {
		order = " ORDER BY rev LIMIT ?"
	}
	rows, err := db.QueryContext(ctx, `SELECT `+requestColumns+` FROM requests`+f.clause()+order, slices.Concat(f.args, []any{limit})...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	p := RequestPage{Requests: []Request{}, Cursor: head}
	for rows.Next() {
		r, err := scanRequest(rows)
		if err != nil {
			return nil, err
		}
		p.Requests = append(p.Requests, r)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(p.Requests) == limit {
		last := p.Requests[len(p.Requests)-1]
		if follow {
			p.Cursor = last.rev // more changes wait; the next call continues from here
		} else {
			p.NextBefore = last.ID
		}
	}
	return p, nil
}

func parseTime(s string, c clock.Clock) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	if d, err := time.ParseDuration(s); err == nil && d >= 0 {
		return c.Now().Add(-d), nil
	}
	return time.Time{}, fmt.Errorf("%q is neither an RFC 3339 time nor a duration", s)
}
