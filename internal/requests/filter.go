package requests

import (
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/store"
)

// filter is the WHERE clause that GET /api/requests, /api/requests/stats
// and /api/requests/filters share, so the stats row always describes the
// list beside it.
type filter struct {
	where []string
	args  []any
}

func (f *filter) add(cond string, a ...any) {
	f.where, f.args = append(f.where, cond), append(f.args, a...)
}

func (f filter) clause() string {
	if len(f.where) == 0 {
		return ""
	}
	return " WHERE " + strings.Join(f.where, " AND ")
}

// and returns f with one more condition, leaving f as it was.
func (f filter) and(cond string, a ...any) filter {
	return filter{where: append(append([]string{}, f.where...), cond), args: append(append([]any{}, f.args...), a...)}
}

var timeParams = []api.Param{
	{Name: "since", Description: "Only Requests that started at or after this time: RFC 3339, or a duration back from now such as 1h."},
	{Name: "until", Description: "Only Requests that started before this time: RFC 3339, or a duration back from now."},
}

// filterParams documents every filter; repeat a parameter to match any of
// its values (caller=a&caller=b).
var filterParams = append([]api.Param{
	{Name: "caller", Description: "Caller name at the time of the Request (a Gateway Key name, or a Test caller such as `Test` or `Test (as zeron-fleet)`), or a Gateway Key ID. Repeat for any of several."},
	{Name: "caller_kind", Enum: []string{CallerGatewayKey, CallerTest}, Description: "Only Requests from Gateway Keys, or only test Requests sent from the chat."},
	{Name: "provider", Description: "Provider handle that served (or was named by) the Request. Repeat for any of several."},
	{Name: "pool", Description: "Model Pool the Caller asked for. Repeat for any of several."},
	{Name: "model", Description: "Model exactly as the Caller named it. Repeat for any of several."},
	{Name: "upstream_key", Description: "Upstream Key that served the Request (its last Attempt's), by name or ID. Names are unique within a Provider only: add provider= to be sure. Repeat for any of several."},
	{Name: "endpoint", Description: "Endpoint of the Request's last Attempt, by name or ID. Repeat for any of several."},
	{Name: "status", Description: "HTTP status the Caller received: exact (429) or a class (2xx, 4xx, 5xx); `failed` is any status from 400 and interrupted Requests. Repeat for any of several."},
	{Name: "affinity", Enum: AffinityModes, Description: "How the conversation chose its Upstream Key: on (ranked for the conversation), off (the Provider has affinity off), control (the round-robin half of affinity.experiment), none (no conversation). Compare on and control to measure the experiment. Repeat for any of several."},
	{Name: "affinity_source", Enum: affinitySources, Description: "Where the conversation was found (see the Request's affinity.source). Repeat for any of several."},
	{Name: "retried", Type: "boolean", Description: "true: only Requests with more than one Attempt; false: only those with at most one."},
	{Name: "q", Description: "Text search: part of the Request ID, model, Caller name or Provider handle."},
}, timeParams...)

var affinitySources = []string{"header", "claude_code", "codex", "session_id", "opencode", "prompt_cache_key", "prefix", "none"}

const timeHint = "Use an RFC 3339 time (2026-01-02T15:04:05Z) or a duration such as 1h."

// parseFilter reads the filters of q; with timeOnly, only since and until.
func parseFilter(q url.Values, c clock.Clock, timeOnly bool) (filter, error) {
	var f filter
	in := func(col string, vals []string) {
		ph := strings.TrimSuffix(strings.Repeat("?, ", len(vals)), ", ")
		args := make([]any, len(vals))
		for i, v := range vals {
			args[i] = v
		}
		f.add(col+" IN ("+ph+")", args...)
	}
	if !timeOnly {
		if v := values(q, "caller"); len(v) > 0 {
			ph := strings.TrimSuffix(strings.Repeat("?, ", len(v)), ", ")
			args := make([]any, 0, 2*len(v))
			for _, s := range v {
				args = append(args, s)
			}
			for _, s := range v {
				args = append(args, s)
			}
			// A Gateway Key ID matches only that key's own traffic, never tests sent as it.
			f.add("(caller_name IN ("+ph+") OR (caller_kind = '"+CallerGatewayKey+"' AND gateway_key_id IN ("+ph+")))", args...)
		}
		if s := q.Get("caller_kind"); s != "" {
			if s != CallerGatewayKey && s != CallerTest {
				return f, api.BadRequest("Use caller_kind=gateway_key or caller_kind=test.", "caller_kind %q is not a Caller kind.", s)
			}
			f.add("caller_kind = ?", s)
		}
		for _, p := range []struct{ param, col string }{{"provider", "provider_handle"}, {"pool", "pool"}, {"model", "model"}} {
			if v := values(q, p.param); len(v) > 0 {
				in(p.col, v)
			}
		}
		for _, p := range []struct{ param, name, id string }{{"upstream_key", "upstream_key_name", "upstream_key_id"}, {"endpoint", "endpoint_name", "endpoint_id"}} {
			if v := values(q, p.param); len(v) > 0 {
				ph := strings.TrimSuffix(strings.Repeat("?, ", len(v)), ", ")
				args := make([]any, 0, 2*len(v))
				for range 2 {
					for _, s := range v {
						args = append(args, s)
					}
				}
				f.add("("+p.name+" IN ("+ph+") OR "+p.id+" IN ("+ph+"))", args...)
			}
		}
		for _, p := range []struct {
			param, col string
			allowed    []string
		}{{"affinity", "affinity", AffinityModes}, {"affinity_source", "affinity_source", affinitySources}} {
			v := values(q, p.param)
			for _, s := range v {
				if !slices.Contains(p.allowed, s) {
					return f, api.BadRequest("Use "+p.param+"="+strings.Join(p.allowed, ", or ")+".", "%s %q is not one of them.", p.param, s)
				}
			}
			if len(v) > 0 {
				in(p.col, v)
			}
		}
		if v := values(q, "status"); len(v) > 0 {
			var or []string
			var args []any
			for _, s := range v {
				switch {
				case s == "failed":
					or = append(or, "(state != ? AND (status >= 400 OR status < 100))")
					args = append(args, StateInProgress)
				case len(s) == 3 && strings.HasSuffix(s, "xx") && s[0] >= '1' && s[0] <= '5':
					lo := int(s[0]-'0') * 100
					or = append(or, "(status >= ? AND status < ?)")
					args = append(args, lo, lo+100)
				default:
					n, err := strconv.Atoi(s)
					if err != nil || n < 100 || n > 599 {
						return f, api.BadRequest("Use an HTTP status such as 429, a class such as 5xx, or failed.", "status %q is not a status or class.", s)
					}
					or = append(or, "status = ?")
					args = append(args, n)
				}
			}
			f.add("("+strings.Join(or, " OR ")+")", args...)
		}
		if s := q.Get("retried"); s != "" {
			b, err := strconv.ParseBool(s)
			if err != nil {
				return f, api.BadRequest("Use retried=true or retried=false.", "retried %q is not true or false.", s)
			}
			if b {
				f.add("attempt_count > 1")
			} else {
				f.add("attempt_count <= 1")
			}
		}
		if s := strings.TrimSpace(q.Get("q")); s != "" {
			like := "%" + strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(s) + "%"
			f.add(`(id LIKE ? ESCAPE '\' OR model LIKE ? ESCAPE '\' OR caller_name LIKE ? ESCAPE '\' OR provider_handle LIKE ? ESCAPE '\')`, like, like, like, like)
		}
	}
	for _, p := range []struct{ name, op string }{{"since", ">="}, {"until", "<"}} {
		if s := q.Get(p.name); s != "" {
			t, err := parseTime(s, c)
			if err != nil {
				return f, api.BadRequest(timeHint, "%s: %v", p.name, err)
			}
			f.add("started_at "+p.op+" ?", store.Millis(t))
		}
	}
	return f, nil
}

// values returns the non-empty values of a repeatable parameter.
func values(q url.Values, name string) []string {
	var out []string
	for _, v := range q[name] {
		if v = strings.TrimSpace(v); v != "" {
			out = append(out, v)
		}
	}
	return out
}
