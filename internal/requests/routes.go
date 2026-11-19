package requests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
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
}

const requestColumns = `id, started_at, finished_at, state, status, error_code, error_message, caller_kind, gateway_key_id, caller_name,
	route, shape_in, shape_out, model, stream, provider_id, provider_handle, endpoint_id, endpoint_name, upstream_key_id, upstream_key_name,
	wire_model, first_byte_ms, duration_ms, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, attempt_count, summary`

func scanRequest(row interface{ Scan(...any) error }) (Request, error) {
	var r Request
	var started int64
	var finished, firstByte, duration, in, out, cache, reasoning sql.NullInt64
	var code, msg, shapeIn, shapeOut string
	err := row.Scan(&r.ID, &started, &finished, &r.State, &r.Status, &code, &msg, &r.Caller.Kind, &r.Caller.GatewayKeyID, &r.Caller.Name,
		&r.Route, &shapeIn, &shapeOut, &r.Model, &r.Stream, &r.ProviderID, &r.Provider, &r.EndpointID, &r.Endpoint, &r.UpstreamKeyID, &r.UpstreamKey,
		&r.WireModel, &firstByte, &duration, &in, &out, &cache, &reasoning, &r.AttemptCount, &r.Summary)
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
			Summary:     "List Requests, newest first",
			Description: "Every Request a Caller with a valid Gateway Key made, refusals included. Filters combine with AND. Read one Request for its Attempts.",
			Query: []api.Param{
				{Name: "caller", Description: "Gateway Key name (at the time of the Request) or ID."},
				{Name: "provider", Description: "Provider handle that served (or was named by) the Request."},
				{Name: "model", Description: "Model exactly as the Caller named it."},
				{Name: "status", Description: "HTTP status the Caller received: exact (429) or a class (2xx, 4xx, 5xx)."},
				{Name: "since", Description: "Only Requests that started at or after this time: RFC 3339, or a duration back from now such as 1h."},
				{Name: "until", Description: "Only Requests that started before this time: RFC 3339, or a duration back from now."},
				{Name: "before", Description: "Only Requests older than this Request ID (paging; use next_before)."},
				{Name: "limit", Type: "integer", Description: "RequestPage size, default 100, at most 1000."},
			},
			Response: RequestPage{},
			Handle:   func(call *api.Call) (any, error) { return list(call, db, c) },
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
					return nil, api.NotFound("List Requests with GET /api/requests; the ID is the x-request-id header the Caller received.", "No Request has the ID %q.", id)
				}
				if err != nil {
					return nil, err
				}
				r.Attempts, err = attempts(ctx, db, id)
				return r, err
			},
		},
	}
}

func list(call *api.Call, db *store.DB, c clock.Clock) (any, error) {
	q := call.R.URL.Query()
	var where []string
	var args []any
	add := func(cond string, a ...any) { where, args = append(where, cond), append(args, a...) }
	if s := q.Get("caller"); s != "" {
		add("(gateway_key_id = ? OR caller_name = ?)", s, s)
	}
	if s := q.Get("provider"); s != "" {
		add("provider_handle = ?", s)
	}
	if s := q.Get("model"); s != "" {
		add("model = ?", s)
	}
	if s := q.Get("status"); s != "" {
		if len(s) == 3 && strings.HasSuffix(s, "xx") && s[0] >= '1' && s[0] <= '5' {
			lo := int(s[0]-'0') * 100
			add("status >= ? AND status < ?", lo, lo+100)
		} else if n, err := strconv.Atoi(s); err == nil && n >= 100 && n <= 599 {
			add("status = ?", n)
		} else {
			return nil, api.BadRequest("Use an HTTP status such as 429 or a class such as 5xx.", "status %q is not a status or class.", s)
		}
	}
	timeHint := "Use an RFC 3339 time (2026-01-02T15:04:05Z) or a duration such as 1h."
	for _, p := range []struct{ name, op string }{{"since", ">="}, {"until", "<"}} {
		if s := q.Get(p.name); s != "" {
			t, err := parseTime(s, c)
			if err != nil {
				return nil, api.BadRequest(timeHint, "%s: %v", p.name, err)
			}
			add("started_at "+p.op+" ?", store.Millis(t))
		}
	}
	if s := q.Get("before"); s != "" {
		add("rowid < coalesce((SELECT rowid FROM requests WHERE id = ?), 0)", s)
	}
	limit := 100
	if s := q.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxLimit {
			return nil, api.BadRequest("Use a limit between 1 and 1000.", "limit must be between 1 and %d.", maxLimit)
		}
		limit = n
	}
	sqlq := `SELECT ` + requestColumns + ` FROM requests`
	if len(where) > 0 {
		sqlq += " WHERE " + strings.Join(where, " AND ")
	}
	sqlq += " ORDER BY rowid DESC LIMIT ?"
	args = append(args, limit)
	rows, err := db.QueryContext(call.R.Context(), sqlq, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	p := RequestPage{Requests: []Request{}}
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
		p.NextBefore = p.Requests[len(p.Requests)-1].ID
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
