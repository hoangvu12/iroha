package v1import

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/audit"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/providers"
)

// Options configure one import run.
type Options struct {
	V1DB      string // path to a copy of v1's iroha.db
	MasterKey string // v1's IROHA_MASTER_KEY
	URL       string // v2 base URL, e.g. http://127.0.0.1:8080
	Token     string // v2 Admin Token
	Apply     bool   // false: dry run, only GET requests are sent
	HTTP      *http.Client
	Out       io.Writer
}

// Counts are what happened (or would happen) to records of one kind.
type Counts struct {
	Create, Update, Unchanged, Failed int
}

func (c *Counts) add(outcome string) {
	switch outcome {
	case "created", "create":
		c.Create++
	case "updated", "update":
		c.Update++
	case "unchanged":
		c.Unchanged++
	default:
		c.Failed++
	}
}

// Report sums up a run.
type Report struct {
	DryRun                                          bool
	Providers, Endpoints, UpstreamKeys, GatewayKeys Counts
	DisableKeys                                     int // keys v1 had disabled that get (or would get) disabled
	Skipped, NotMapped                              int // report lines
}

// Failed is the number of records that could not be imported.
func (r Report) Failed() int {
	return r.Providers.Failed + r.Endpoints.Failed + r.UpstreamKeys.Failed + r.GatewayKeys.Failed
}

// Line is the last line of the output, for agents to read.
func (r Report) Line() string {
	mode := "applied"
	if r.DryRun {
		mode = "dry_run"
	}
	var b strings.Builder
	b.WriteString("IROHA_IMPORT " + mode)
	for _, k := range []struct {
		name string
		c    Counts
	}{{"providers", r.Providers}, {"endpoints", r.Endpoints}, {"upstream_keys", r.UpstreamKeys}, {"gateway_keys", r.GatewayKeys}} {
		fmt.Fprintf(&b, " %s_create=%d %s_update=%d %s_unchanged=%d", k.name, k.c.Create, k.name, k.c.Update, k.name, k.c.Unchanged)
	}
	fmt.Fprintf(&b, " upstream_keys_disable=%d skipped=%d not_mapped=%d failed=%d", r.DisableKeys, r.Skipped, r.NotMapped, r.Failed())
	return b.String()
}

// Run reads the v1 database, compares it with v2's current configuration
// and prints what it would do; with Apply it does it through the admin API.
// It never prints a secret.
func Run(ctx context.Context, o Options) (Report, error) {
	rep := Report{DryRun: !o.Apply}
	v, err := Read(ctx, o.V1DB, o.MasterKey)
	if err != nil {
		return rep, err
	}
	pl := MakePlan(v)
	r := &run{ctx: ctx, o: o, plan: pl, rep: &rep, c: client{http: o.HTTP, base: strings.TrimRight(o.URL, "/"), token: o.Token}}
	if r.c.http == nil {
		r.c.http = http.DefaultClient
	}
	for _, p := range pl.Providers {
		for _, k := range p.Keys {
			r.secrets = append(r.secrets, k.Secret)
		}
		for _, e := range p.Endpoints {
			r.secrets = slices.AppendSeq(r.secrets, maps.Values(e.StaticHeaders))
		}
	}
	r.secrets = append(r.secrets, o.Token, o.MasterKey)
	return rep, r.run()
}

type run struct {
	ctx     context.Context
	o       Options
	plan    Plan
	rep     *Report
	c       client
	secrets []string
}

// say prints one line with every known secret masked.
func (r *run) say(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	for _, s := range r.secrets {
		if len(s) >= 4 {
			line = strings.ReplaceAll(line, s, "[redacted]")
		}
	}
	fmt.Fprintln(r.o.Out, line)
}

func (r *run) verb(dry string) string {
	if r.o.Apply {
		return map[string]string{"create": "created", "update": "updated", "unchanged": "unchanged"}[dry]
	}
	if dry == "unchanged" {
		return dry
	}
	return "would " + dry
}

func (r *run) run() error {
	mode := "dry run: only reads v2; run again with --apply to import"
	if r.o.Apply {
		mode = "applying"
	}
	r.say("Iroha v1 import into %s (%s)", r.c.base, mode)

	var list providers.ProviderList
	if err := r.c.do(r.ctx, http.MethodGet, "/api/providers", nil, &list); err != nil {
		return fmt.Errorf("read v2 Providers: %w", err)
	}
	existing := map[string]providers.Provider{}
	for _, p := range list.Providers {
		existing[p.Handle] = p
	}
	for _, p := range r.plan.Providers {
		cur, ok := existing[p.Handle]
		if err := r.provider(p, cur, ok); err != nil {
			return err
		}
	}
	if err := r.gatewayKeys(); err != nil {
		return err
	}

	if len(r.plan.Skipped) > 0 {
		r.say("Not imported:")
		for _, s := range r.plan.Skipped {
			r.say("  %s", s)
		}
	}
	if len(r.plan.NotMapped) > 0 {
		r.say("v1 settings with no place in v2:")
		for _, s := range r.plan.NotMapped {
			r.say("  %s", s)
		}
	}
	r.rep.Skipped, r.rep.NotMapped = len(r.plan.Skipped), len(r.plan.NotMapped)
	if r.rep.GatewayKeys.Create > 0 {
		r.say("New Gateway Keys get new secrets. Read them with GET /api/gateway-keys (or the Gateway Keys page) and hand each to its Caller once; v1's secrets do not work in v2.")
	}
	r.say("%s", r.rep.Line())
	return nil
}

// provider plans and (with Apply) applies one Provider with its Endpoints and keys.
func (r *run) provider(p PProvider, cur providers.Provider, exists bool) error {
	if exists && cur.Archived {
		r.say("Provider %s: failed: an archived v2 Provider holds this handle; unarchive or pick it up by hand", p.Handle)
		r.rep.Providers.Failed++
		r.rep.Endpoints.Failed += len(p.Endpoints)
		r.rep.UpstreamKeys.Failed += len(p.Keys)
		return nil
	}
	body := providers.CreateProvider{Handle: p.Handle, Name: &p.Name, Enabled: &p.Enabled}
	body.Discovery = &p.Discovery
	if p.ModelsDevBrand != "" {
		body.ModelsDevBrand = &p.ModelsDevBrand
	}
	if p.LogoDomain != "" {
		body.LogoDomain = &p.LogoDomain
	}
	if p.MaxAttempts > 0 {
		body.MaxAttempts = &p.MaxAttempts
	}
	action := "create"
	if exists {
		action = "unchanged"
		logo := cur.LogoDomain
		if cur.LogoGuessed {
			logo = ""
		}
		if cur.Name != p.Name || cur.Enabled != p.Enabled || cur.Discovery != p.Discovery ||
			(p.ModelsDevBrand != "" && cur.ModelsDevBrand != p.ModelsDevBrand) ||
			(p.LogoDomain != "" && logo != p.LogoDomain) ||
			(p.MaxAttempts > 0 && (!cur.Budget.Overridden || cur.Budget.MaxAttempts != p.MaxAttempts)) {
			action = "update"
		}
	}
	if r.o.Apply && action != "unchanged" {
		var res providers.ProviderResult
		if err := r.c.do(r.ctx, http.MethodPost, "/api/providers", body, &res); err != nil {
			if fatal(err) {
				return err
			}
			r.say("Provider %s: failed: %s", p.Handle, err)
			r.rep.Providers.Failed++
			r.rep.Endpoints.Failed += len(p.Endpoints)
			r.rep.UpstreamKeys.Failed += len(p.Keys)
			return nil
		}
		action = dryWord(res.Outcome)
	}
	r.rep.Providers.add(action)
	state := "enabled"
	if !p.Enabled {
		state = "disabled"
	}
	r.say("Provider %s: %s (%s, discovery %s, %d Endpoints, %d Upstream Keys)", p.Handle, r.verb(action), state, p.Discovery, len(p.Endpoints), len(p.Keys))

	// Endpoints, matched by URL and Shape like the API does.
	names := map[string]bool{}
	for _, e := range cur.Endpoints {
		names[strings.ToLower(e.Name)] = true
	}
	epNames := make([]string, len(p.Endpoints)) // "" when the Endpoint failed
	for i, e := range p.Endpoints {
		var match *providers.Endpoint
		for j := range cur.Endpoints {
			if cur.Endpoints[j].URL == e.URL && cur.Endpoints[j].Shape == e.Shape {
				match = &cur.Endpoints[j]
			}
		}
		body := providers.CreateEndpoint{URL: &e.URL, Shape: &e.Shape, AuthStyle: &e.AuthStyle}
		if e.AuthParam != "" {
			body.AuthParam = &e.AuthParam
		}
		if len(e.StaticHeaders) > 0 {
			body.StaticHeaders = &e.StaticHeaders
		}
		if len(e.Renames) > 0 {
			body.Renames = &e.Renames
		}
		if e.DiscoveryURL != "" {
			body.DiscoveryURL = &e.DiscoveryURL
		}
		action := "create"
		name := ""
		if match != nil {
			name = match.Name
			action = "unchanged"
			if match.AuthStyle != e.AuthStyle || (e.AuthParam != "" && match.AuthParam != e.AuthParam) ||
				(len(e.StaticHeaders) > 0 && !maps.Equal(match.StaticHeaders, e.StaticHeaders)) ||
				(len(e.Renames) > 0 && !maps.Equal(match.Renames, e.Renames)) ||
				(e.DiscoveryURL != "" && match.DiscoveryURL != e.DiscoveryURL) {
				action = "update"
			}
		} else {
			name = uniqueName(e.NameHint, names)
			names[strings.ToLower(name)] = true
			body.Name = name // the API matches an unnamed create by URL and Shape; a new one needs a free name
		}
		if r.o.Apply && action != "unchanged" {
			var res providers.EndpointResult
			if err := r.c.do(r.ctx, http.MethodPost, "/api/providers/"+url.PathEscape(p.Handle)+"/endpoints", body, &res); err != nil {
				if fatal(err) {
					return err
				}
				r.say("  Endpoint %s %s: failed: %s", name, e.URL, err)
				r.rep.Endpoints.Failed++
				continue
			}
			action, name = dryWord(res.Outcome), res.Endpoint.Name
		}
		epNames[i] = name
		r.rep.Endpoints.add(action)
		extra := ""
		if len(e.StaticHeaders) > 0 {
			extra += fmt.Sprintf(", static headers %s (values redacted)", strings.Join(slices.Sorted(maps.Keys(e.StaticHeaders)), ", "))
		}
		if len(e.Renames) > 0 {
			extra += fmt.Sprintf(", %d model renames", len(e.Renames))
		}
		r.say("  Endpoint %s %s (%s, auth %s%s): %s", name, e.URL, e.Shape, e.AuthStyle, extra, r.verb(action))
	}

	return r.keys(p, exists, epNames)
}

// keys plans and applies a Provider's Upstream Keys, matched by secret
// (keyless slots by name).
func (r *run) keys(p PProvider, exists bool, epNames []string) error {
	bySecret := map[string]providers.UpstreamKey{}
	byName := map[string]providers.UpstreamKey{}
	if exists {
		var kl providers.UpstreamKeyList
		if err := r.c.do(r.ctx, http.MethodGet, "/api/providers/"+url.PathEscape(p.Handle)+"/keys", nil, &kl); err != nil {
			return fmt.Errorf("read Upstream Keys of %s: %w", p.Handle, err)
		}
		for _, k := range kl.UpstreamKeys {
			if k.Secret != "" {
				bySecret[k.Secret] = k
			}
			byName[k.Name] = k
		}
	}
	var items []providers.CreateUpstreamKey
	var itemKeys []int // plan index of each item
	var disable []string
	disableNew := map[int]bool{}
	var c Counts
	restricted := 0
	for i, k := range p.Keys {
		var want []string
		failedEP := false
		for _, ep := range k.Endpoints {
			if epNames[ep] == "" {
				failedEP = true
			}
			want = append(want, epNames[ep])
		}
		if failedEP {
			c.Failed++
			continue
		}
		if want != nil {
			restricted++
		}
		var cur providers.UpstreamKey
		found := false
		if k.Secret != "" {
			cur, found = bySecret[k.Secret]
		} else {
			cur, found = byName[k.KeylessName]
		}
		item := providers.CreateUpstreamKey{}
		if k.Secret != "" {
			item.Secret = &p.Keys[i].Secret
		} else {
			item.Name = k.KeylessName
		}
		if want != nil {
			item.Endpoints = &want
		}
		switch {
		case !found:
			c.Create++
			items, itemKeys = append(items, item), append(itemKeys, i)
			if k.Disabled {
				disableNew[i] = true
			}
		case want != nil && !sameSet(cur.Endpoints, want):
			c.Update++
			items, itemKeys = append(items, item), append(itemKeys, i)
		default:
			c.Unchanged++
		}
		if found && k.Disabled && cur.Enabled {
			disable = append(disable, cur.Name)
		}
	}
	if r.o.Apply && len(items) > 0 {
		var res audit.BulkResult[providers.UpstreamKey]
		if err := r.c.do(r.ctx, http.MethodPost, "/api/providers/"+url.PathEscape(p.Handle)+"/keys/bulk", audit.BulkRequest[providers.CreateUpstreamKey]{Items: items}, &res); err != nil {
			return fmt.Errorf("add Upstream Keys of %s: %w", p.Handle, err)
		}
		c = Counts{Unchanged: c.Unchanged, Failed: c.Failed}
		for _, it := range res.Items {
			if !it.OK {
				r.say("  Upstream Key (item %d): failed: %s", it.Index, it.Error)
				c.Failed++
				continue
			}
			c.add(it.Outcome)
			if it.Result != nil && disableNew[itemKeys[it.Index]] {
				disable = append(disable, it.Result.Name)
			}
		}
	} else {
		for i := range disableNew {
			if disableNew[i] {
				disable = append(disable, "")
			}
		}
	}
	r.rep.UpstreamKeys.Create += c.Create
	r.rep.UpstreamKeys.Update += c.Update
	r.rep.UpstreamKeys.Unchanged += c.Unchanged
	r.rep.UpstreamKeys.Failed += c.Failed
	if len(p.Keys) > 0 {
		how := ""
		if restricted > 0 {
			how = fmt.Sprintf(", %d restricted to their v1 base URL's Endpoint", restricted)
		}
		r.say("  Upstream Keys: %d %s, %d %s, %d unchanged%s (secrets not shown)", c.Create, r.verb("create"), c.Update, r.verb("update"), c.Unchanged, how)
	}
	if len(disable) > 0 {
		r.rep.DisableKeys += len(disable)
		if r.o.Apply {
			var res audit.BulkResult[providers.UpstreamKey]
			if err := r.c.do(r.ctx, http.MethodPost, "/api/providers/"+url.PathEscape(p.Handle)+"/keys/bulk/disable", audit.BulkRequest[string]{Items: disable}, &res); err != nil {
				return fmt.Errorf("disable Upstream Keys of %s: %w", p.Handle, err)
			}
		}
		done := "to disable"
		if r.o.Apply {
			done = "disabled"
		}
		r.say("  Upstream Keys disabled in v1: %d %s", len(disable), done)
	}
	return nil
}

// gatewayKeys plans and applies the Gateway Keys, matched by name.
func (r *run) gatewayKeys() error {
	var list gatewaykeys.GatewayKeyList
	if err := r.c.do(r.ctx, http.MethodGet, "/api/gateway-keys", nil, &list); err != nil {
		return fmt.Errorf("read v2 Gateway Keys: %w", err)
	}
	byName := map[string]gatewaykeys.GatewayKey{}
	for _, k := range list.GatewayKeys {
		byName[k.Name] = k
	}
	for _, g := range r.plan.GatewayKeys {
		scope := gatewaykeys.Scope{All: g.All}
		for _, s := range g.Providers {
			scope.Providers = append(scope.Providers, gatewaykeys.ScopeProvider{Provider: s.Provider, Models: s.Models})
		}
		action := "create"
		if cur, ok := byName[g.Name]; ok {
			if cur.Revoked {
				r.say("Gateway Key %s: failed: a revoked v2 Gateway Key holds this name", g.Name)
				r.rep.GatewayKeys.Failed++
				continue
			}
			action = "unchanged"
			if !sameScope(cur.Scope, scope) {
				action = "update"
			}
		}
		if r.o.Apply && action != "unchanged" {
			var res gatewaykeys.GatewayKeyResult
			if err := r.c.do(r.ctx, http.MethodPost, "/api/gateway-keys", gatewaykeys.CreateGatewayKey{Name: g.Name, Scope: &scope}, &res); err != nil {
				if fatal(err) {
					return err
				}
				r.say("Gateway Key %s: failed: %s", g.Name, err)
				r.rep.GatewayKeys.Failed++
				continue
			}
			action = dryWord(res.Outcome)
		}
		r.rep.GatewayKeys.add(action)
		r.say("Gateway Key %s: %s (scope: %s)", g.Name, r.verb(action), describeScope(g))
	}
	return nil
}

func describeScope(g PGatewayKey) string {
	if g.All {
		return "everything"
	}
	if len(g.Providers) == 0 {
		return "nothing"
	}
	var parts []string
	for _, p := range g.Providers {
		if p.Models == nil {
			parts = append(parts, p.Provider)
		} else {
			parts = append(parts, fmt.Sprintf("%s (%d models)", p.Provider, len(p.Models)))
		}
	}
	return strings.Join(parts, ", ")
}

func sameScope(a, b gatewaykeys.Scope) bool {
	if a.All || b.All {
		return a.All == b.All
	}
	if len(a.Pools) != len(b.Pools) || len(a.Providers) != len(b.Providers) {
		return false
	}
	am := map[string][]string{}
	for _, p := range a.Providers {
		am[p.Provider] = p.Models
	}
	for _, p := range b.Providers {
		m, ok := am[p.Provider]
		if !ok || !sameSet(m, p.Models) {
			return false
		}
	}
	return true
}

func sameSet(a, b []string) bool {
	x, y := slices.Clone(a), slices.Clone(b)
	slices.Sort(x)
	slices.Sort(y)
	return slices.Equal(slices.Compact(x), slices.Compact(y))
}

// dryWord maps an API outcome to the word the plan uses.
func dryWord(outcome string) string {
	switch outcome {
	case "created":
		return "create"
	case "updated":
		return "update"
	}
	return outcome
}

// fatal reports errors that would fail every later call too (bad token,
// unreachable server), as opposed to one record being refused.
func fatal(err error) bool {
	var e *api.Error
	if errors.As(err, &e) {
		return e.Status == http.StatusUnauthorized || e.Status == http.StatusForbidden || e.Status >= 500
	}
	return true
}

// client calls the v2 admin API with an Admin Token.
type client struct {
	http  *http.Client
	base  string
	token string
}

func (c client) do(ctx context.Context, method, path string, body, out any) error {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("%s %s: %w", method, path, err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 64<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		var eb api.ErrorBody
		if json.Unmarshal(b, &eb) == nil && eb.Error != nil {
			eb.Error.Status = resp.StatusCode
			return eb.Error
		}
		return &api.Error{Status: resp.StatusCode, Code: "http_" + fmt.Sprint(resp.StatusCode), Message: fmt.Sprintf("%s %s answered %s", method, path, resp.Status)}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(b, out)
}
