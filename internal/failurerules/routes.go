package failurerules

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/store"
)

// RuleView is one Failure Rule as the API shows it: its definition, whether
// it is on, where it comes from, what it does, and how often it decided.
type RuleView struct {
	rules.Rule
	Enabled       bool        `json:"enabled" doc:"false: the rule is switched off and never matches."`
	Source        string      `json:"source" enum:"builtin,owner" doc:"builtin: shipped with Iroha and unchanged (it may be switched off). owner: added by the Owner or an agent, or a built-in rule overridden by name."`
	Overrides     *rules.Rule `json:"overrides,omitempty" doc:"For an owner rule with a built-in rule's name: the built-in rule it replaces. DELETE /api/rules/{rule} brings the built-in back."`
	Order         int         `json:"order" doc:"Position, from 1, in the order rules are tried (among the rules listed): rules limited to a Provider or host first, then the others; the Owner's new rules before the built-ins. The first enabled rule that matches decides."`
	KeyEffect     string      `json:"key_effect" doc:"What a match does to the Upstream Key, in words: Mark invalid, Cool 60 s, Cool until reset, Record Model Gap, No change."`
	RequestEffect string      `json:"request_effect" enum:"Try next key,Return to Caller" doc:"What a match does to the Request."`
	Hits          int         `json:"hits" doc:"Failed Attempts this rule decided since hits_since (only on the Provider asked for, when there is one)."`
	LastHitAt     *time.Time  `json:"last_hit_at,omitempty" doc:"When it last decided an Attempt within that window."`
}

// RuleList is the response of GET /api/rules.
type RuleList struct {
	Provider  string     `json:"provider,omitempty" doc:"Handle of the Provider the list was narrowed to."`
	HitsSince time.Time  `json:"hits_since" doc:"Start of the window hits count over."`
	Rules     []RuleView `json:"rules" doc:"In the order they are tried, switched-off rules in their place."`
}

// RuleFields are the changeable fields of a Failure Rule. Fields left out
// keep their current values (a built-in's, for a new override); send an
// empty value to clear one.
type RuleFields struct {
	Description    *string            `json:"description,omitempty" doc:"What the rule recognises and why it decides as it does."`
	Provider       *string            `json:"provider,omitempty" doc:"Handle or ID of the only Provider the rule applies to (stored as the handle); empty for every Provider."`
	Host           *string            `json:"host,omitempty" doc:"Endpoint host the rule applies to, or a parent domain of it (aliyuncs.com matches dashscope.aliyuncs.com); empty for any host."`
	Status         *[]string          `json:"status,omitempty" doc:"Upstream statuses, any of which matches: exact (429), a class (5xx), network (no response at all) or timeout (no response within the time budget)."`
	Code           *[]string          `json:"code,omitempty" doc:"Provider error codes, any of which matches, compared without case against error.code, error.type, error.status, code and type of the JSON body (numbers as text)."`
	Body           *string            `json:"body,omitempty" doc:"Regular expression, case-insensitive, that must match somewhere in the response body (a plain word works: Arrearage)."`
	Header         *map[string]string `json:"header,omitempty" doc:"Response headers that must be present, each with a case-insensitive regular expression its value must match (empty: any value)."`
	Outcome        *rules.Outcome     `json:"outcome,omitempty" enum:"invalid,cooling_key,cooling_key_model,model_gap,retry_elsewhere,fail_request" doc:"What a match means; required for a new rule. Changing it to a non-cooling outcome clears cooling_seconds and reset unless you send them."`
	CoolingSeconds *int               `json:"cooling_seconds,omitempty" doc:"For cooling outcomes: how long to cool when the response names no reset time; 0 for the default (60 s, doubling on repeats up to 1 h)."`
	Reset          *[]string          `json:"reset,omitempty" doc:"For cooling outcomes: where the response names its reset time, tried in order before Retry-After: header:<name> or json:<dotted.path>."`
	Enabled        *bool              `json:"enabled,omitempty" doc:"false switches the rule off. Default true for a new rule."`
}

// CreateRule is the body of POST /api/rules and each item of its bulk.
type CreateRule struct {
	Name string `json:"name" doc:"Unique name. The name of a built-in rule overrides it (fields left out keep the built-in's values); the name of an existing owner rule updates it."`
	RuleFields
}

// RuleResult is the response of a change to one Failure Rule.
type RuleResult struct {
	audit.Result
	Rule   RuleView `json:"rule" doc:"The rule after the change (on a dry run, as it would be); for a deleted owner rule, the rule as it was."`
	Replay *Replay  `json:"replay,omitempty" doc:"Only on a dry run: recent failed Attempts classified by the rules as they are and as they would be."`
}

const tag = "Failure Rules"

var (
	ruleSince = api.Param{Name: "since", Description: "Start of the window hits count over: RFC 3339, or a duration back from now such as 24h (the default)."}
)

// Routes returns the Failure Rule routes.
func Routes(tr *audit.Trail, db *store.DB) []api.Route {
	h := handlers{tr: tr, db: db}
	return []api.Route{
		{
			Method: http.MethodGet, Path: "/api/rules", Tag: tag,
			Summary:     "List Failure Rules, built-in and the Owner's, in the order they are tried",
			Description: "Each rule shows its match, outcome, key_effect and request_effect, whether it is on, its source and its hits. With provider, only the rules that can apply to that Provider (global ones, ones limited to it, and ones limited to a host of its Endpoints), with hits on it alone.",
			Query: []api.Param{
				{Name: "provider", Description: "Handle or ID of a Provider: only rules that can apply to it, hits counted on it."},
				ruleSince,
			},
			Response: RuleList{},
			Handle:   h.list,
		},
		{
			Method: http.MethodGet, Path: "/api/rules/{rule}", Tag: tag,
			Summary:  "Read a Failure Rule by name",
			Query:    []api.Param{ruleSince},
			Response: RuleView{},
			Handle: func(c *api.Call) (any, error) {
				since, err := h.since(c)
				if err != nil {
					return nil, err
				}
				return h.view(c.R.Context(), h.db, c.Path("rule"), since)
			},
		},
		{
			Method: http.MethodPost, Path: "/api/rules", Tag: tag,
			Summary: "Add a Failure Rule, override a built-in one by name, or update the Owner's rule of that name",
			Description: "Applies to the next Attempt. With dry_run=true the answer also has replay: the most recent failed Attempts (at most 1000, last 7 days) " +
				"classified by the rules as they are and as they would be, with match counts per rule and the Attempts whose decision would change.",
			Query:   []api.Param{audit.DryRun},
			Request: CreateRule{}, Response: RuleResult{},
			Handle: func(c *api.Call) (any, error) {
				var in CreateRule
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return h.mutate(c, "failure_rule.create", "Saved", func(m *audit.Mutation) (RuleView, error) {
					return h.upsert(m, in)
				})
			},
		},
		{
			Method: http.MethodPost, Path: "/api/rules/bulk", Tag: tag,
			Summary:     "Add, override or update many Failure Rules, each by name",
			Description: "Each item is applied or refused on its own; read failed and each item's error. Dry runs here report changes but no replay; dry-run one rule at a time to replay it.",
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[CreateRule]{}, Response: audit.BulkResult[RuleView]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[CreateRule]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "failure_rule.create", "Saved", in.Items, h.upsert)
			},
		},
		{
			Method: http.MethodPatch, Path: "/api/rules/{rule}", Tag: tag,
			Summary:     "Change a Failure Rule; changing a built-in one overrides it",
			Description: "Rules cannot be renamed: add one under the new name and delete the old. dry_run=true adds replay, as on POST /api/rules.",
			Query:       []api.Param{audit.DryRun},
			Request:     RuleFields{}, Response: RuleResult{},
			Handle: func(c *api.Call) (any, error) {
				var in RuleFields
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return h.mutate(c, "failure_rule.update", "Edited", func(m *audit.Mutation) (RuleView, error) {
					return h.apply(m, c.Path("rule"), in, false)
				})
			},
		},
		{
			Method: http.MethodDelete, Path: "/api/rules/{rule}", Tag: tag,
			Summary: "Delete the Owner's Failure Rule, or drop an override so the built-in rule comes back",
			Description: "Built-in rules cannot be deleted (409 builtin_rule); switch one off with POST /api/rules/{rule}/disable instead. " +
				"Deleting an override or a switched-off built-in restores the built-in as shipped (outcome updated). dry_run=true adds replay.",
			Query:    []api.Param{audit.DryRun},
			Response: RuleResult{},
			Handle: func(c *api.Call) (any, error) {
				return h.mutate(c, "failure_rule.delete", "Deleted", func(m *audit.Mutation) (RuleView, error) {
					return h.remove(m, c.Path("rule"))
				})
			},
		},
		{
			Method: http.MethodPost, Path: "/api/rules/bulk/delete", Tag: tag,
			Summary:     "Delete many Failure Rules (or drop overrides), each by name",
			Description: `Body {"items": ["rule-a", "rule-b"]}. Each item is applied or refused on its own; built-in rules are refused.`,
			Query:       []api.Param{audit.DryRun},
			Request:     audit.BulkRequest[string]{}, Response: audit.BulkResult[RuleView]{},
			Handle: func(c *api.Call) (any, error) {
				var in audit.BulkRequest[string]
				if err := c.Decode(&in); err != nil {
					return nil, err
				}
				return audit.Bulk(h.tr, c, "failure_rule.delete", "Deleted", in.Items, h.remove)
			},
		},
		h.switchRoute("enable", true), h.switchRoute("disable", false),
		h.bulkSwitchRoute("enable", true), h.bulkSwitchRoute("disable", false),
	}
}

func (h handlers) switchRoute(word string, on bool) api.Route {
	verb := map[bool]string{true: "Enabled", false: "Disabled"}[on]
	return api.Route{
		Method: http.MethodPost, Path: "/api/rules/{rule}/" + word, Tag: tag,
		Summary:     fmt.Sprintf("Switch a Failure Rule %s, built-in ones included", map[bool]string{true: "on", false: "off"}[on]),
		Description: "Applies to the next Attempt. dry_run=true adds replay, as on POST /api/rules.",
		Query:       []api.Param{audit.DryRun},
		Response:    RuleResult{},
		Handle: func(c *api.Call) (any, error) {
			return h.mutate(c, "failure_rule."+word, verb, func(m *audit.Mutation) (RuleView, error) {
				return h.apply(m, c.Path("rule"), RuleFields{Enabled: &on}, false)
			})
		},
	}
}

func (h handlers) bulkSwitchRoute(word string, on bool) api.Route {
	verb := map[bool]string{true: "Enabled", false: "Disabled"}[on]
	return api.Route{
		Method: http.MethodPost, Path: "/api/rules/bulk/" + word, Tag: tag,
		Summary:     fmt.Sprintf("Switch many Failure Rules %s, each by name", map[bool]string{true: "on", false: "off"}[on]),
		Description: `Body {"items": ["rule-a", "rule-b"]}. Each item is applied or refused on its own.`,
		Query:       []api.Param{audit.DryRun},
		Request:     audit.BulkRequest[string]{}, Response: audit.BulkResult[RuleView]{},
		Handle: func(c *api.Call) (any, error) {
			var in audit.BulkRequest[string]
			if err := c.Decode(&in); err != nil {
				return nil, err
			}
			return audit.Bulk(h.tr, c, "failure_rule."+word, verb, in.Items, func(m *audit.Mutation, name string) (RuleView, error) {
				return h.apply(m, name, RuleFields{Enabled: &on}, false)
			})
		},
	}
}

type handlers struct {
	tr *audit.Trail
	db *store.DB
}

// since reads ?since=, default 24 hours back.
func (h handlers) since(c *api.Call) (time.Time, error) {
	now := h.db.Clock().Now().UTC()
	s := c.Query("since")
	if s == "" {
		return now.Add(-24 * time.Hour), nil
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UTC(), nil
	}
	if d, err := time.ParseDuration(s); err == nil && d >= 0 {
		return now.Add(-d), nil
	}
	return time.Time{}, api.BadRequest("Use an RFC 3339 time (2026-01-02T00:00:00Z) or a duration such as 24h.", "since: %q is neither an RFC 3339 time nor a duration.", s)
}

func (h handlers) list(c *api.Call) (any, error) {
	ctx := c.R.Context()
	since, err := h.since(c)
	if err != nil {
		return nil, err
	}
	entries, err := readEntries(ctx, h.db)
	if err != nil {
		return nil, err
	}
	out := RuleList{HitsSince: since, Rules: []RuleView{}}
	if ref := c.Query("provider"); ref != "" {
		handle, hosts, err := providerScope(ctx, h.db, ref)
		if err != nil {
			return nil, err
		}
		out.Provider = handle
		entries = slices.DeleteFunc(entries, func(e entry) bool { return !appliesTo(e.rule, handle, hosts) })
	}
	hits, err := countHits(ctx, h.db, since, out.Provider)
	if err != nil {
		return nil, err
	}
	for i, e := range entries {
		out.Rules = append(out.Rules, viewOf(e, i+1, hits[e.rule.Name]))
	}
	return out, nil
}

// view is one rule by name with its global order and hits since since.
func (h handlers) view(ctx context.Context, q queryer, name string, since time.Time) (RuleView, error) {
	entries, err := readEntries(ctx, q)
	if err != nil {
		return RuleView{}, err
	}
	i := slices.IndexFunc(entries, func(e entry) bool { return e.rule.Name == name })
	if i < 0 {
		return RuleView{}, notFound(name)
	}
	hits, err := countHits(ctx, q, since, "")
	if err != nil {
		return RuleView{}, err
	}
	return viewOf(entries[i], i+1, hits[name]), nil
}

type hit struct {
	n    int
	last time.Time
}

// countHits counts classified Attempts per rule since since, on one
// Provider when handle is set.
func countHits(ctx context.Context, q queryer, since time.Time, handle string) (map[string]hit, error) {
	query := `SELECT rule, count(*), max(started_at) FROM attempts WHERE outcome != '' AND rule != '' AND started_at >= ?`
	args := []any{store.Millis(since)}
	if handle != "" {
		query += ` AND provider_handle = ?`
		args = append(args, handle)
	}
	rows, err := q.QueryContext(ctx, query+` GROUP BY rule`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]hit{}
	for rows.Next() {
		var name string
		var n int
		var last int64
		if err := rows.Scan(&name, &n, &last); err != nil {
			return nil, err
		}
		out[name] = hit{n: n, last: store.FromMillis(last)}
	}
	return out, rows.Err()
}

func viewOf(e entry, order int, h hit) RuleView {
	v := RuleView{Rule: e.rule, Enabled: e.enabled, Source: e.source, Order: order, Hits: h.n,
		KeyEffect: keyEffect(e.rule), RequestEffect: requestEffect(e.rule.Outcome)}
	if e.source == SourceOwner && e.builtin != nil {
		b := *e.builtin
		v.Overrides = &b
	}
	if h.n > 0 {
		t := h.last
		v.LastHitAt = &t
	}
	return v
}

func keyEffect(r rules.Rule) string {
	switch r.Outcome {
	case rules.Invalid:
		return "Mark invalid"
	case rules.ModelGap:
		return "Record Model Gap"
	case rules.CoolingKey, rules.CoolingKeyModel:
		s := "Cool 60 s"
		switch {
		case len(r.Reset) > 0:
			s = "Cool until reset"
		case r.CoolingSeconds > 0:
			s = "Cool " + seconds(r.CoolingSeconds)
		}
		if r.Outcome == rules.CoolingKeyModel {
			s += " for the model"
		}
		return s
	}
	return "No change"
}

func seconds(n int) string {
	switch {
	case n < 120 || n%60 != 0:
		return fmt.Sprintf("%d s", n)
	case n < 7200 || n%3600 != 0:
		return fmt.Sprintf("%d min", n/60)
	}
	return fmt.Sprintf("%d h", n/3600)
}

func requestEffect(o rules.Outcome) string {
	if o.Retries() {
		return "Try next key"
	}
	return "Return to Caller"
}

// providerScope resolves a Provider by handle or ID to its handle and the
// hosts of its Endpoints.
func providerScope(ctx context.Context, q queryer, ref string) (string, []string, error) {
	id, err := providers.Resource.Resolve(ctx, q, ref)
	if err != nil {
		return "", nil, err
	}
	var handle string
	if err := q.QueryRowContext(ctx, `SELECT handle FROM providers WHERE id = ?`, id).Scan(&handle); err != nil {
		return "", nil, err
	}
	rows, err := q.QueryContext(ctx, `SELECT url FROM endpoints WHERE provider_id = ?`, id)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	var hosts []string
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return "", nil, err
		}
		if u, err := url.Parse(raw); err == nil && u.Hostname() != "" {
			hosts = append(hosts, strings.ToLower(u.Hostname()))
		}
	}
	return handle, hosts, rows.Err()
}

// appliesTo reports whether a rule can match failures of the Provider.
func appliesTo(r rules.Rule, handle string, hosts []string) bool {
	if r.Provider != "" && r.Provider != handle {
		return false
	}
	if r.Host == "" {
		return true
	}
	domain := strings.ToLower(strings.TrimSuffix(r.Host, "."))
	return slices.ContainsFunc(hosts, func(h string) bool { return h == domain || strings.HasSuffix(h, "."+domain) })
}

// mutate runs one audited rule change; on a dry run it also replays recent
// failed Attempts under the rules before and after the change.
func (h handlers) mutate(c *api.Call, action, verb string, fn func(m *audit.Mutation) (RuleView, error)) (RuleResult, error) {
	var out RuleView
	var rep *Replay
	res, err := h.tr.Mutate(c, action, verb, func(m *audit.Mutation) error {
		var before []entry
		var err error
		if m.DryRun {
			if before, err = readEntries(m.Ctx, m.Tx); err != nil {
				return err
			}
		}
		if out, err = fn(m); err != nil {
			return err
		}
		if !m.DryRun {
			return nil
		}
		after, err := readEntries(m.Ctx, m.Tx)
		if err != nil {
			return err
		}
		rep, err = replay(m.Ctx, m.Tx, compile(before, nil), compile(after, nil), m.Now)
		return err
	})
	return RuleResult{Result: res, Rule: out, Replay: rep}, err
}

// upsert adds the rule named in.Name or changes the existing one.
func (h handlers) upsert(m *audit.Mutation, in CreateRule) (RuleView, error) {
	if err := api.CheckName("name", in.Name); err != nil {
		return RuleView{}, err
	}
	return h.apply(m, in.Name, in.RuleFields, true)
}

// apply changes rule name by f; with create, a name that is no rule yet
// makes a new one.
func (h handlers) apply(m *audit.Mutation, name string, f RuleFields, create bool) (RuleView, error) {
	cur, ok, err := readEntry(m.Ctx, m.Tx, name)
	if err != nil {
		return RuleView{}, err
	}
	s := snapshot{Rule: rules.Rule{Name: name}, Enabled: true}
	if ok {
		s = snapshot{Rule: cur.rule, Enabled: cur.enabled}
	} else if !create {
		return RuleView{}, notFound(name)
	}
	if err := f.applyTo(m, &s); err != nil {
		return RuleView{}, err
	}
	if err := rules.Validate(s.Rule); err != nil {
		return RuleView{}, api.BadRequest("Fix the rule as the message says; GET /api/openapi.json describes each field, and /skill.md has examples.", "%s", err.Error())
	}
	if err := m.Track(Resource, name); err != nil {
		return RuleView{}, err
	}
	if err := write(m.Ctx, m.Tx, name, &s); err != nil {
		return RuleView{}, err
	}
	return h.view(m.Ctx, m.Tx, name, m.Now.Add(-24*time.Hour))
}

func (f RuleFields) applyTo(m *audit.Mutation, s *snapshot) error {
	r := &s.Rule
	if f.Description != nil {
		r.Description = strings.TrimSpace(*f.Description)
	}
	if f.Provider != nil {
		r.Provider = ""
		if ref := strings.TrimSpace(*f.Provider); ref != "" {
			handle, _, err := providerScope(m.Ctx, m.Tx, ref)
			if err != nil {
				return err
			}
			r.Provider = handle
		}
	}
	if f.Host != nil {
		r.Host = strings.ToLower(strings.TrimSpace(*f.Host))
	}
	if f.Status != nil {
		r.Status = trimAll(*f.Status)
	}
	if f.Code != nil {
		r.Code = trimAll(*f.Code)
	}
	if f.Body != nil {
		r.Body = *f.Body
	}
	if f.Header != nil {
		r.Header = nil
		if len(*f.Header) > 0 {
			r.Header = *f.Header
		}
	}
	if f.Outcome != nil {
		r.Outcome = *f.Outcome
		if !r.Outcome.Cools() {
			if f.CoolingSeconds == nil {
				r.CoolingSeconds = 0
			}
			if f.Reset == nil {
				r.Reset = nil
			}
		}
	}
	if f.CoolingSeconds != nil {
		r.CoolingSeconds = *f.CoolingSeconds
	}
	if f.Reset != nil {
		r.Reset = trimAll(*f.Reset)
	}
	if f.Enabled != nil {
		s.Enabled = *f.Enabled
	}
	return nil
}

func trimAll(in []string) []string {
	var out []string
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// remove deletes the Owner's rule of that name; for a built-in name it
// drops the override so the built-in stands as shipped.
func (h handlers) remove(m *audit.Mutation, name string) (RuleView, error) {
	cur, ok, err := readEntry(m.Ctx, m.Tx, name)
	if err != nil {
		return RuleView{}, err
	}
	if !ok {
		return RuleView{}, notFound(name)
	}
	r, err := readRow(m.Ctx, m.Tx, name)
	if err != nil {
		return RuleView{}, err
	}
	if r == nil {
		return RuleView{}, api.Conflict("builtin_rule",
			fmt.Sprintf("Switch it off with POST /api/rules/%s/disable, or override it with POST /api/rules {\"name\": %q, ...}.", name, name),
			"%q is a built-in Failure Rule; built-in rules cannot be deleted.", name)
	}
	if err := m.Track(Resource, name); err != nil {
		return RuleView{}, err
	}
	if err := write(m.Ctx, m.Tx, name, nil); err != nil {
		return RuleView{}, err
	}
	if cur.builtin != nil {
		m.Summarize("Restored built-in Failure Rule " + name)
		return h.view(m.Ctx, m.Tx, name, m.Now.Add(-24*time.Hour))
	}
	return viewOf(cur, 0, hit{}), nil
}
