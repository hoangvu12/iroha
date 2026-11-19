package v1import

import (
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/logos"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/shape"
)

// Plan is the v2 configuration the v1 database maps to.
type Plan struct {
	Providers   []PProvider
	GatewayKeys []PGatewayKey
	// Skipped lists v1 records deliberately left out; NotMapped lists v1
	// settings v2 has no place for. Both are lines for the report.
	Skipped   []string
	NotMapped []string
}

// PProvider is a Provider to create or update.
type PProvider struct {
	Handle, Name   string
	Enabled        bool
	Discovery      string
	ModelsDevBrand string
	LogoDomain     string // "" leaves it to v2's guess from the Endpoint
	MaxAttempts    int    // 0: the default
	Endpoints      []PEndpoint
	Keys           []PKey
}

// PEndpoint is an Endpoint to create or update; it is found again by URL and Shape.
type PEndpoint struct {
	NameHint      string
	URL, Shape    string
	AuthStyle     string
	AuthParam     string
	StaticHeaders map[string]string
	Renames       map[string]string
	DiscoveryURL  string
}

// PKey is an Upstream Key to create or update, found again by its secret
// (keyless slots by their name).
type PKey struct {
	Secret      string
	KeylessName string
	// Endpoints are indexes into PProvider.Endpoints the key is restricted
	// to; nil when the Provider has one Endpoint (no restriction).
	Endpoints []int
	Disabled  bool
}

// PGatewayKey is a Gateway Key to create (with a new secret) or update.
type PGatewayKey struct {
	Name      string
	All       bool
	Providers []PScope
}

// PScope is one Provider of a Gateway Key scope; Models nil is every model.
type PScope struct {
	Provider string
	Models   []string
}

// template is what v1's Provider Templates said that matters here.
type template struct {
	shape        shape.Shape
	brand        string // models.dev provider ID
	availability string // "provider" or "key" (v1's default)
	discovery    string // v1 modelDiscovery default
	basePath     string // v1 modelDiscoveryBasePath
}

// templates are v1's built-in Provider Packs (src/providers/packs/*.ts).
var templates = map[string]template{
	"anthropic":                    {shape: shape.AnthropicMessages, brand: "anthropic"},
	"generic-anthropic-compatible": {shape: shape.AnthropicMessages},
	"generic-openai-compatible":    {shape: shape.OpenAIChat},
	"openai":                       {shape: shape.OpenAIChat, brand: "openai"},
	"openrouter":                   {shape: shape.OpenAIChat, brand: "openrouter"},
	"mistral":                      {shape: shape.OpenAIChat, brand: "mistral"},
	"MiniMax":                      {shape: shape.OpenAIChat, brand: "minimax"},
	"dashscope":                    {shape: shape.OpenAIChat, brand: "alibaba", availability: "key"},
	"zai":                          {shape: shape.OpenAIChat, brand: "zai-coding-plan", availability: "key", discovery: "best_effort", basePath: "/api/coding/paas/v4"},
	"deepai-code":                  {shape: shape.OpenAIChat, availability: "provider", discovery: "supported"},
	"nousresearch":                 {shape: shape.OpenAIChat, discovery: "supported"},
}

// v1 defaults that need no mapping.
const v1DefaultAttempts = 3

// MakePlan maps a v1 configuration onto v2. It is pure: the same input
// always gives the same plan.
func MakePlan(v *V1) Plan {
	var pl Plan
	imported := map[string]string{} // v1 Provider ID -> handle
	var archived []string
	archivedKeys := 0
	var notes notes

	for _, p := range v.Providers {
		if p.Archived {
			archived = append(archived, p.Handle)
			archivedKeys += len(p.Keys)
			continue
		}
		if err := providers.CheckHandle(p.Handle); err != nil {
			pl.Skipped = append(pl.Skipped, fmt.Sprintf("Provider %q: its handle is not valid in v2 (%s)", p.Handle, apiMessage(err)))
			continue
		}
		pp, ok := mapProvider(p, &notes)
		if !ok {
			continue
		}
		imported[p.ID] = p.Handle
		pl.Providers = append(pl.Providers, pp)
	}
	if len(archived) > 0 {
		pl.Skipped = append(pl.Skipped, fmt.Sprintf("%d archived v1 Providers and their %d Upstream Keys (v1 refused Callers on them): %s",
			len(archived), archivedKeys, strings.Join(archived, ", ")))
	}

	used := map[string]bool{}
	revoked := 0
	for _, g := range v.GatewayKeys {
		if g.Revoked {
			revoked++
			continue
		}
		name := uniqueName(gatewayKeyName(g.Name), used)
		used[strings.ToLower(name)] = true
		if name != g.Name {
			notes.add("Gateway Keys renamed to fit v2's names (letters, digits, '.', '_', '-')", fmt.Sprintf("%q -> %q", g.Name, name))
		}
		pg := PGatewayKey{Name: name, All: g.All}
		if !g.All {
			for _, e := range g.Scope {
				h, ok := imported[e.ProviderID]
				switch {
				case !ok:
					notes.add("Gateway Key scope entries dropped: their Provider is archived or gone", name)
				case e.Models != nil && len(e.Models) == 0:
					notes.add("Gateway Key scope entries dropped: they allowed no model of the Provider", name+" on "+h)
				default:
					pg.Providers = append(pg.Providers, PScope{Provider: h, Models: e.Models})
				}
			}
		}
		if g.CORSOrigins > 0 {
			notes.add("Gateway Key CORS origins (v2 has none; out of scope)", name)
		}
		pl.GatewayKeys = append(pl.GatewayKeys, pg)
	}
	if revoked > 0 {
		pl.Skipped = append(pl.Skipped, fmt.Sprintf("%d revoked v1 Gateway Keys", revoked))
	}
	if v.Accounts > 0 {
		pl.Skipped = append(pl.Skipped, fmt.Sprintf("%d v1 Upstream Accounts (v2 has none; their keys are imported ungrouped)", v.Accounts))
	}
	pl.Skipped = append(pl.Skipped, "Request history, audit history, Management Keys, the Owner's password and sessions, model catalogs, usage snapshots and runtime key health: never read")
	if v.CatalogOwnerEntries > 0 {
		notes.add("v1 model catalog entries the Owner excluded, added or overrode (set them again with /api/providers/{provider}/models)", fmt.Sprintf("%d entries", v.CatalogOwnerEntries))
	}
	pl.NotMapped = notes.lines()
	return pl
}

func mapProvider(p V1Provider, n *notes) (PProvider, bool) {
	t, known := templates[p.TemplateID]
	if !known {
		if p.TemplateID != "" {
			n.add("Unknown v1 template; read as the OpenAI Chat Shape", p.Handle+" ("+p.TemplateID+")")
		}
		t = template{shape: shape.OpenAIChat}
	}
	pp := PProvider{Handle: p.Handle, Name: p.Name, Enabled: p.Enabled, ModelsDevBrand: t.brand}
	if strings.TrimSpace(pp.Name) == "" || len(pp.Name) > 128 {
		pp.Name = p.Handle
	}

	disc := p.ModelDiscovery
	if disc == "" {
		disc = t.discovery
	}
	switch {
	case disc == "unsupported":
		pp.Discovery = providers.DiscoveryNone
	case t.availability == "provider":
		pp.Discovery = providers.DiscoveryProvider
	default: // v1 read a missing availability as per key
		pp.Discovery = providers.DiscoveryKey
	}

	if d := strings.TrimSpace(p.LogoDomain); d != "" {
		if nd, err := logos.NormalizeDomain(d); err == nil {
			pp.LogoDomain = nd
		} else {
			n.add("Logo domains v2 does not accept (the logo is guessed from the Endpoint instead)", p.Handle)
		}
	}
	if p.RetryMaxAttempts != v1DefaultAttempts && p.RetryMaxAttempts > 0 {
		pp.MaxAttempts = min(p.RetryMaxAttempts, providers.MaxAttemptsLimit)
	}
	if p.TransportChanged {
		n.add("Provider transport settings changed from v1's defaults (timeouts, redirects, idempotency header); v2 uses its Request budget instead", p.Handle)
	}

	style, param := authStyle(p, n)

	// Endpoints: the Provider's base URL first, then each distinct per-key
	// base URL, in the order keys were added.
	var eps []PEndpoint
	index := map[string]int{}
	endpointOf := func(raw string) (int, bool) {
		u, err := normalURL(raw)
		if err != nil {
			n.add("Base URLs v2 cannot use as an Endpoint ("+err.Error()+"); keys on them are left out", p.Handle)
			return -1, false
		}
		if i, ok := index[u]; ok {
			return i, true
		}
		e := PEndpoint{URL: u, Shape: string(t.shape), AuthStyle: style, AuthParam: param, StaticHeaders: p.StaticHeaders}
		if t.basePath != "" {
			if pu, err := url.Parse(u); err == nil {
				if d := pu.Scheme + "://" + pu.Host + t.basePath + "/models"; d != u+"/models" {
					e.DiscoveryURL = d
				}
			}
		}
		index[u] = len(eps)
		eps = append(eps, e)
		return len(eps) - 1, true
	}
	defaultEP, defaultOK := endpointOf(p.BaseURL)

	type keyAt struct {
		k  V1Key
		ep int
	}
	var keys []keyAt
	modelLists, healthNotCarried := 0, 0
	for _, k := range p.Keys {
		ep := defaultEP
		ok := defaultOK
		if strings.TrimSpace(k.BaseURL) != "" {
			ep, ok = endpointOf(k.BaseURL)
		}
		if !ok {
			continue
		}
		keys = append(keys, keyAt{k, ep})
		if k.ModelLists {
			modelLists++
		}
		if k.Health != "active" && k.Health != "unverified" && k.Health != "disabled" {
			healthNotCarried++
		}
	}
	if modelLists > 0 {
		n.add("Upstream Key model allow/deny lists (v2 learns Model Gaps instead)", fmt.Sprintf("%s: %d keys", p.Handle, modelLists))
	}
	if healthNotCarried > 0 {
		n.add("Runtime key health (cooling, exhausted, invalid) is not carried; the keys start active", fmt.Sprintf("%s: %d keys", p.Handle, healthNotCarried))
	}

	// Model rewrites were per key; v2 renames are per Endpoint, so they map
	// only when every key on an Endpoint had the same ones.
	for i := range eps {
		var first map[string]string
		same, seen := true, false
		for _, ka := range keys {
			if ka.ep != i {
				continue
			}
			if !seen {
				first, seen = ka.k.Rewrites, true
			} else if !maps.Equal(first, ka.k.Rewrites) {
				same = false
			}
		}
		if !same {
			n.add("Per-key model rewrites that differ between keys of one URL (v2 renames are per Endpoint)", p.Handle+" "+eps[i].URL)
			continue
		}
		if len(first) > 0 {
			eps[i].Renames = first
		}
	}

	// Keys: one per distinct secret, restricted to their Endpoints when the
	// Provider has more than one.
	bySecret := map[string]int{}
	keyless := map[string]bool{}
	merged := 0
	defer func() {
		if merged > 0 {
			n.add("v1 key rows repeating a secret already on the Provider (imported once, restricted to every Endpoint they were on)", fmt.Sprintf("%s: %d rows", p.Handle, merged))
		}
	}()
	for _, ka := range keys {
		secret := strings.TrimSpace(ka.k.Secret)
		if !p.RequiresKey {
			secret = ""
		}
		if secret == "" {
			name := uniqueName("keyless", keyless)
			keyless[name] = true
			pp.Keys = append(pp.Keys, PKey{KeylessName: name, Endpoints: []int{ka.ep}, Disabled: ka.k.Health == "disabled"})
			continue
		}
		if i, ok := bySecret[secret]; ok {
			merged++
			if !slices.Contains(pp.Keys[i].Endpoints, ka.ep) {
				pp.Keys[i].Endpoints = append(pp.Keys[i].Endpoints, ka.ep)
			}
			pp.Keys[i].Disabled = pp.Keys[i].Disabled && ka.k.Health == "disabled"
			continue
		}
		bySecret[secret] = len(pp.Keys)
		pp.Keys = append(pp.Keys, PKey{Secret: secret, Endpoints: []int{ka.ep}, Disabled: ka.k.Health == "disabled"})
	}
	if len(eps) <= 1 {
		for i := range pp.Keys {
			pp.Keys[i].Endpoints = nil
		}
	}

	// Endpoint names: the Provider's own URL is "default", the others are
	// named after their host.
	names := map[string]bool{}
	for i := range eps {
		hint := "default"
		if i != defaultEP || !defaultOK {
			if u, err := url.Parse(eps[i].URL); err == nil {
				hint = gatewayKeyName(u.Hostname())
			}
		}
		eps[i].NameHint = uniqueName(hint, names)
		names[strings.ToLower(eps[i].NameHint)] = true
	}
	pp.Endpoints = eps
	return pp, true
}

// authStyle maps v1's auth header and prefix onto an Endpoint auth style.
func authStyle(p V1Provider, n *notes) (style, param string) {
	h := strings.ToLower(strings.TrimSpace(p.AuthHeader))
	prefix := strings.TrimSpace(p.AuthPrefix)
	switch {
	case h == "authorization" && strings.EqualFold(prefix, "Bearer"):
		return string(planner.AuthBearer), ""
	case h == "x-api-key" && prefix == "":
		return string(planner.AuthXAPIKey), ""
	case h != "" && prefix == "":
		return string(planner.AuthHeader), p.AuthHeader
	case h == "authorization":
		n.add("Auth prefixes other than Bearer (sent as Bearer instead; check these Providers)", p.Handle+" ("+prefix+")")
		return string(planner.AuthBearer), ""
	default:
		n.add("Auth prefixes on a custom header (the raw key is sent instead; check these Providers)", p.Handle)
		return string(planner.AuthHeader), p.AuthHeader
	}
}

// normalURL is the URL as v2 stores an Endpoint URL, refusing what v2 refuses.
func normalURL(s string) (string, error) {
	s = strings.TrimSpace(s)
	u, err := url.Parse(s)
	switch {
	case err != nil:
		return "", fmt.Errorf("does not parse")
	case u.Scheme != "http" && u.Scheme != "https":
		return "", fmt.Errorf("not http or https")
	case u.Host == "":
		return "", fmt.Errorf("no host")
	case u.User != nil, u.RawQuery != "", u.Fragment != "":
		return "", fmt.Errorf("credentials, query or fragment in the URL")
	}
	n := len(u.Scheme) + len("://") + len(u.Host)
	if len(s) >= n && strings.EqualFold(s[:n], u.Scheme+"://"+u.Host) {
		s = strings.ToLower(s[:n]) + s[n:]
	}
	return strings.TrimRight(s, "/"), nil
}

// gatewayKeyName fits a v1 name to v2's name rules: other characters become
// '-', and it starts with a letter or digit.
func gatewayKeyName(s string) string {
	var b strings.Builder
	dash := false
	for _, c := range strings.TrimSpace(s) {
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-'
		if !ok {
			if !dash && b.Len() > 0 {
				b.WriteByte('-')
				dash = true
			}
			continue
		}
		b.WriteRune(c)
		dash = false
	}
	out := strings.TrimLeft(strings.TrimRight(b.String(), "-"), "._-")
	if len(out) > api.MaxNameLen-4 {
		out = strings.TrimRight(out[:api.MaxNameLen-4], "._-")
	}
	if out == "" || api.CheckName("name", out) != nil {
		out = "v1-" + out
		if api.CheckName("name", out) != nil {
			out = "v1-key"
		}
	}
	return out
}

// uniqueName is name, or name-2, name-3... when taken (case-insensitive).
func uniqueName(name string, taken map[string]bool) string {
	if !taken[strings.ToLower(name)] {
		return name
	}
	for i := 2; ; i++ {
		c := fmt.Sprintf("%s-%d", name, i)
		if !taken[strings.ToLower(c)] {
			return c
		}
	}
}

func apiMessage(err error) string {
	if e := api.AsError(err); e != nil {
		return e.Message
	}
	return err.Error()
}

// notes groups report lines by topic, keeping the order topics appeared.
type notes struct {
	order []string
	items map[string][]string
}

func (n *notes) add(topic, item string) {
	if n.items == nil {
		n.items = map[string][]string{}
	}
	if _, ok := n.items[topic]; !ok {
		n.order = append(n.order, topic)
	}
	n.items[topic] = append(n.items[topic], item)
}

func (n *notes) lines() []string {
	var out []string
	for _, t := range n.order {
		out = append(out, fmt.Sprintf("%s: %s", t, strings.Join(n.items[t], ", ")))
	}
	return out
}
