package logs

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/store"
)

// Event is one stored log event as the API returns it.
type Event struct {
	ID        int64          `json:"id"`
	Time      time.Time      `json:"time"`
	Level     string         `json:"level" enum:"debug,info,warn,error"`
	Kind      string         `json:"kind"`
	Message   string         `json:"message"`
	RequestID string         `json:"request_id,omitempty" doc:"The Request this event belongs to, when any."`
	Provider  string         `json:"provider,omitempty" doc:"Handle of the Provider this event concerns, when any."`
	Attrs     map[string]any `json:"attrs" doc:"Every other attribute of the event."`
}

// Page is a page of events, newest first.
type Page struct {
	Events     []Event `json:"events"`
	NextBefore int64   `json:"next_before,omitempty" doc:"Pass as before= to read the next older page; absent on the last page."`
}

// Filter selects events. Zero fields do not filter.
type Filter struct {
	Since, Until time.Time
	MinLevel     *slog.Level
	Kinds        []string // exact names, or prefixes ending in "*"
	RequestID    string
	Provider     string
	Before       int64 // only events with a smaller id
	Limit        int
}

// Query reads stored events, newest first, after flushing queued ones.
func (l *Log) Query(ctx context.Context, f Filter) ([]Event, error) {
	if err := l.Flush(ctx); err != nil {
		return nil, err
	}
	var where []string
	var args []any
	if !f.Since.IsZero() {
		where, args = append(where, "at >= ?"), append(args, store.Millis(f.Since))
	}
	if !f.Until.IsZero() {
		where, args = append(where, "at < ?"), append(args, store.Millis(f.Until))
	}
	if f.MinLevel != nil {
		where, args = append(where, "level >= ?"), append(args, int(*f.MinLevel))
	}
	if len(f.Kinds) > 0 {
		var ors []string
		for _, k := range f.Kinds {
			if prefix, ok := strings.CutSuffix(k, "*"); ok {
				ors, args = append(ors, "substr(kind, 1, ?) = ?"), append(args, len(prefix), prefix)
			} else {
				ors, args = append(ors, "kind = ?"), append(args, k)
			}
		}
		where = append(where, "("+strings.Join(ors, " OR ")+")")
	}
	if f.RequestID != "" {
		where, args = append(where, "request_id = ?"), append(args, f.RequestID)
	}
	if f.Provider != "" {
		where, args = append(where, "provider = ?"), append(args, f.Provider)
	}
	if f.Before > 0 {
		where, args = append(where, "id < ?"), append(args, f.Before)
	}
	q := "SELECT id, at, level, kind, message, request_id, provider, attrs FROM log_events"
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	limit := f.Limit
	if limit <= 0 {
		limit = 100
	}
	q += " ORDER BY id DESC LIMIT ?"
	args = append(args, limit)

	rows, err := l.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Event{}
	for rows.Next() {
		var e Event
		var at int64
		var level int
		var req, prov sql.NullString
		var attrs string
		if err := rows.Scan(&e.ID, &at, &level, &e.Kind, &e.Message, &req, &prov, &attrs); err != nil {
			return nil, err
		}
		e.Time = store.FromMillis(at)
		e.Level = LevelName(slog.Level(level))
		e.RequestID, e.Provider = req.String, prov.String
		if err := json.Unmarshal([]byte(attrs), &e.Attrs); err != nil || e.Attrs == nil {
			e.Attrs = map[string]any{}
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// LevelName is the API name of a level.
func LevelName(l slog.Level) string {
	switch {
	case l >= slog.LevelError:
		return "error"
	case l >= slog.LevelWarn:
		return "warn"
	case l >= slog.LevelInfo:
		return "info"
	default:
		return "debug"
	}
}

// ParseLevel accepts debug, info, warn (or warning) and error.
func ParseLevel(s string) (slog.Level, error) {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	}
	return 0, fmt.Errorf("unknown level %q (want debug, info, warn or error)", s)
}

const maxLimit = 1000

// Routes returns the logs API routes.
func Routes(l *Log) []api.Route {
	return []api.Route{{
		Method: http.MethodGet, Path: "/api/logs", Tag: "Logs",
		Summary:     "Read structured log events, newest first",
		Description: "Every event Iroha logs to its console is also stored here. Filters combine with AND.",
		Query: []api.Param{
			{Name: "since", Description: "Only events at or after this time: RFC 3339, or a duration back from now such as 15m or 24h."},
			{Name: "until", Description: "Only events before this time: RFC 3339, or a duration back from now."},
			{Name: "level", Description: "Minimum level.", Enum: []string{"debug", "info", "warn", "error"}},
			{Name: "kind", Description: "Comma-separated event kinds; a trailing * matches a prefix (http.*)."},
			{Name: "request_id", Description: "Only events of this Request."},
			{Name: "provider", Description: "Only events concerning this Provider handle."},
			{Name: "before", Type: "integer", Description: "Only events with a smaller id (paging; use next_before)."},
			{Name: "limit", Type: "integer", Description: "Page size, default 100, at most 1000."},
		},
		Response: Page{},
		Handle: func(c *api.Call) (any, error) {
			f, err := parseFilter(c, l)
			if err != nil {
				return nil, err
			}
			events, err := l.Query(c.R.Context(), f)
			if err != nil {
				return nil, err
			}
			p := Page{Events: events}
			if len(events) == f.Limit && len(events) > 0 {
				p.NextBefore = events[len(events)-1].ID
			}
			return p, nil
		},
	}}
}

func parseFilter(c *api.Call, l *Log) (Filter, error) {
	f := Filter{Limit: 100}
	q := c.R.URL.Query()
	var err error
	if f.Since, err = parseTime(q.Get("since"), l); err != nil {
		return f, api.BadRequest("Use an RFC 3339 time (2026-01-02T15:04:05Z) or a duration such as 15m.", "since: %v", err)
	}
	if f.Until, err = parseTime(q.Get("until"), l); err != nil {
		return f, api.BadRequest("Use an RFC 3339 time (2026-01-02T15:04:05Z) or a duration such as 15m.", "until: %v", err)
	}
	if s := q.Get("level"); s != "" {
		lvl, err := ParseLevel(s)
		if err != nil {
			return f, api.BadRequest("Use level=debug, info, warn or error.", "level: %v", err)
		}
		f.MinLevel = &lvl
	}
	if s := q.Get("kind"); s != "" {
		for _, k := range strings.Split(s, ",") {
			if k = strings.TrimSpace(k); k != "" {
				f.Kinds = append(f.Kinds, k)
			}
		}
	}
	f.RequestID = q.Get("request_id")
	f.Provider = q.Get("provider")
	if s := q.Get("before"); s != "" {
		if f.Before, err = strconv.ParseInt(s, 10, 64); err != nil || f.Before <= 0 {
			return f, api.BadRequest("Pass the next_before value of the previous page.", "before must be a positive integer.")
		}
	}
	if s := q.Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 1 || n > maxLimit {
			return f, api.BadRequest("Use a limit between 1 and 1000.", "limit must be between 1 and %d.", maxLimit)
		}
		f.Limit = n
	}
	return f, nil
}

func parseTime(s string, l *Log) (time.Time, error) {
	if s == "" {
		return time.Time{}, nil
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, nil
	}
	if d, err := time.ParseDuration(s); err == nil && d >= 0 {
		return l.clock.Now().Add(-d), nil
	}
	return time.Time{}, fmt.Errorf("%q is neither an RFC 3339 time nor a duration", s)
}
