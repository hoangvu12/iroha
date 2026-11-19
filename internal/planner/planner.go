// Package planner is candidate planning, the one deep module that decides
// where a Request may go. Given the Request (Shape, model) and the routing
// view of one or more Providers, it returns the ordered list of
// (Provider, Endpoint, Upstream Key, wire model) to try. It does no I/O and
// reads no clock; the only state it consults is the Rotation it is handed.
//
// Order: Providers in the order given (Pool members later). Within a
// Provider, Endpoints come in tiers (endpointTiers) and the first tier that
// yields any candidate is the one used, so a later tier is reached only when
// nothing in an earlier one can serve: first the Endpoints speaking the
// Caller's Shape, then those speaking a Shape the Gateway translates it to
// (Request.Translate). Within a tier, Upstream Keys round-robin, each
// key paired with every Endpoint of the tier it may use, in configured order.
//
// Excluded: disabled and invalid keys, keys cooling at Request.Now, keys
// with a live Model Gap for the wire model of that Endpoint (ticket 08), keys
// cooling for that wire model, and keys restricted to other Endpoints (09).
// Each exclusion is reported as a Skip. Later tickets add exclusions and key
// tiers (known carriers first) here, and nowhere else.
package planner

import (
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/shape"
)

// Request is what planning needs to know about a Request.
type Request struct {
	Shape shape.Shape // the Caller's Shape
	Model string      // the model as the Caller named it, without any Provider handle
	Now   time.Time   // the time Key States are judged at
	// Translate lists the other Shapes the Gateway can translate the
	// Caller's Shape to; Endpoints speaking them form the second tier.
	Translate []shape.Shape
}

// Provider is the routing view of one Provider.
type Provider struct {
	ID        string
	Handle    string
	Endpoints []Endpoint
	Keys      []Key
	// Budget overrides; zero means the Gateway's default.
	MaxAttempts int
	FirstByte   time.Duration
}

// Endpoint is one URL of a Provider.
type Endpoint struct {
	ID    string
	Name  string
	URL   string // base URL including the version path
	Shape shape.Shape
	// AuthStyle is how the Upstream Key is sent: AuthBearer (also when
	// empty), AuthXAPIKey, AuthHeader, AuthQuery or AuthNone; AuthParam
	// names the header or query parameter for AuthHeader and AuthQuery.
	AuthStyle     string
	AuthParam     string
	StaticHeaders map[string]string
	// Renames maps a Caller-facing model name to the name this URL uses.
	Renames map[string]string
}

// Auth styles of an Endpoint.
const (
	AuthBearer  = "bearer"    // Authorization: Bearer <secret>
	AuthXAPIKey = "x-api-key" // x-api-key: <secret>
	AuthHeader  = "header"    // <AuthParam>: <secret>
	AuthQuery   = "query"     // ?<AuthParam>=<secret>
	AuthNone    = "none"      // nothing, whatever the key holds
)

// AuthStyles lists every auth style.
var AuthStyles = []string{AuthBearer, AuthXAPIKey, AuthHeader, AuthQuery, AuthNone}

// WireModel is the model name this Endpoint uses for the Caller's model:
// the rename applied after the Endpoint is chosen, so each Attempt sends
// its own Endpoint's name.
func (e *Endpoint) WireModel(model string) string {
	if w, ok := e.Renames[model]; ok && w != "" {
		return w
	}
	return model
}

// Key is one Upstream Key with its Key State. An empty Secret sends no auth
// at all.
type Key struct {
	ID       string
	Name     string
	Secret   string
	Disabled bool
	Invalid  bool
	// Endpoints restricts the key to these Endpoint IDs; empty means every
	// Endpoint of its Provider.
	Endpoints []string
	// CoolingUntil is the end of the key's own latest cooling, which may be
	// past; zero when the key has not been cooling since it last served.
	CoolingUntil time.Time
	// ModelCooling maps wire models to the end of the key's latest cooling
	// for that model, which may be past.
	ModelCooling map[string]time.Time
	// ModelGaps maps wire models the key was refused to when that Model Gap
	// expires, which may be past.
	ModelGaps map[string]time.Time
}

// Allows reports whether the key may be sent to Endpoint id.
func (k *Key) Allows(id string) bool {
	return len(k.Endpoints) == 0 || slices.Contains(k.Endpoints, id)
}

// Keyless reports whether an Attempt with this key on e sends no credential.
func (k *Key) Keyless(e *Endpoint) bool { return k.Secret == "" || e.AuthStyle == AuthNone }

// Recovering reports whether a success with this key on model has a
// cooling to clear.
func (k *Key) Recovering(model string) bool {
	_, ok := k.ModelCooling[model]
	return ok || !k.CoolingUntil.IsZero()
}

// Candidate is one Attempt Iroha may make.
type Candidate struct {
	Provider  *Provider
	Endpoint  *Endpoint
	Key       *Key
	WireModel string // the model name sent on this Endpoint
}

// Reasons a plan is empty. All but Cooling mean nothing can serve the
// Request until the Owner changes something.
const (
	NoEndpoint    = "no_endpoint"     // no Endpoint speaks the Caller's Shape
	NoUpstreamKey = "no_upstream_key" // the Provider holds no Upstream Keys
	NoUsableKey   = "no_usable_key"   // every Upstream Key is disabled, invalid or restricted to other Endpoints
	Cooling       = "cooling"         // every usable key is cooling; Empty.Until says until when
	ModelGap      = "model_gap"       // every usable key has a Model Gap for the model; Empty.Until is the first expiry
)

// Reasons a key is skipped.
const (
	SkipDisabled     = "disabled"
	SkipInvalid      = "invalid"
	SkipCooling      = "cooling"
	SkipCoolingModel = "cooling_model"
	SkipModelGap     = "model_gap"
	SkipRestricted   = "restricted" // restricted to Endpoints outside the tier that served (or to none that could)
)

// Empty explains why nothing can serve the Request.
type Empty struct {
	Code    string
	Message string
	Until   time.Time // Cooling: when the first key is usable again
}

// Skip is a key left out of the plan, and why.
type Skip struct {
	Provider *Provider
	Key      *Key
	Model    string    // the wire model, for SkipCoolingModel and SkipModelGap
	Reason   string    // one of the Skip* constants
	Until    time.Time // cooling end, or when the Model Gap expires
}

// Result is the plan: Candidates in the order to try, or why there is none.
type Result struct {
	Candidates []Candidate
	Skipped    []Skip // keys left out, once per key and reason
	Empty      *Empty // set when Candidates is empty
}

// Rotation gives the round-robin starting point of a group of keys. Next
// returns a counter that grows by one per call for the same group.
type Rotation interface {
	Next(group string) uint64
}

// Plan orders the candidates for req across providers.
func Plan(req Request, providers []Provider, rot Rotation) Result {
	var out []Candidate
	var skipped []Skip
	var empty *Empty
	for pi := range providers {
		p := &providers[pi]
		tiers := endpointTiers(p, req)
		if len(tiers) == 0 {
			if empty == nil {
				empty = &Empty{Code: NoEndpoint, Message: noEndpoint(p, req)}
			}
			continue
		}
		n := len(p.Keys)
		if n == 0 {
			if empty == nil {
				empty = &Empty{Code: NoUpstreamKey, Message: fmt.Sprintf("Provider %s has no Upstream Keys.", p.Handle)}
			}
			continue
		}
		start := int(rot.Next(p.ID) % uint64(n))
		var pSkips []Skip
		for _, eps := range tiers {
			cands, skips := planTier(req, p, eps, start)
			if len(cands) > 0 {
				out = append(out, cands...)
				pSkips = skips // only the serving tier's skips explain the plan
				break
			}
			for _, s := range skips {
				pSkips = addSkip(pSkips, s)
			}
		}
		for _, s := range pSkips {
			skipped = addSkip(skipped, s)
		}
	}
	if len(out) > 0 {
		return Result{Candidates: out, Skipped: skipped}
	}
	if len(skipped) > 0 {
		// Cooling (servable soon) beats a never-servable reason of another Provider.
		if e := emptyFromSkips(skipped); empty == nil || e.Code == Cooling {
			empty = e
		}
	}
	if empty == nil {
		empty = &Empty{Code: NoEndpoint, Message: "No Provider was given to plan for."}
	}
	return Result{Skipped: skipped, Empty: empty}
}

// endpointTiers groups p's Endpoints in the order they are tried; Plan uses
// the first tier that yields a candidate. The first tier speaks the Caller's
// Shape (passthrough); the second speaks a Shape in req.Translate, which
// gives "translate only when no same-Shape Endpoint has a candidate"
// (restricted, cooling and disabled keys included).
func endpointTiers(p *Provider, req Request) [][]*Endpoint {
	var same, other []*Endpoint
	for ei := range p.Endpoints {
		switch ep := &p.Endpoints[ei]; {
		case ep.Shape == req.Shape:
			same = append(same, ep)
		case slices.Contains(req.Translate, ep.Shape):
			other = append(other, ep)
		}
	}
	var tiers [][]*Endpoint
	for _, t := range [][]*Endpoint{same, other} {
		if len(t) > 0 {
			tiers = append(tiers, t)
		}
	}
	return tiers
}

func noEndpoint(p *Provider, req Request) string {
	if len(req.Translate) == 0 {
		return fmt.Sprintf("Provider %s has no Endpoint speaking %s.", p.Handle, req.Shape)
	}
	return fmt.Sprintf("Provider %s has no Endpoint speaking %s or a Shape Iroha translates it to.", p.Handle, req.Shape)
}

// planTier pairs p's keys, round-robin from start, with the Endpoints of one
// tier each key may use.
func planTier(req Request, p *Provider, eps []*Endpoint, start int) ([]Candidate, []Skip) {
	var out []Candidate
	var skipped []Skip
	n := len(p.Keys)
	for i := range n {
		k := &p.Keys[(start+i)%n]
		allowed := false
		for _, ep := range eps {
			if !k.Allows(ep.ID) {
				continue
			}
			allowed = true
			wm := ep.WireModel(req.Model)
			if s := skip(k, wm, req.Now); s != nil {
				s.Provider = p
				skipped = addSkip(skipped, *s)
				continue
			}
			out = append(out, Candidate{Provider: p, Endpoint: ep, Key: k, WireModel: wm})
		}
		if !allowed {
			skipped = addSkip(skipped, Skip{Provider: p, Key: k, Reason: SkipRestricted})
		}
	}
	return out, skipped
}

// skip says why key k cannot serve wire model wm at now, or nil.
func skip(k *Key, wm string, now time.Time) *Skip {
	switch {
	case k.Disabled:
		return &Skip{Key: k, Reason: SkipDisabled}
	case k.Invalid:
		return &Skip{Key: k, Reason: SkipInvalid}
	case k.CoolingUntil.After(now):
		return &Skip{Key: k, Reason: SkipCooling, Until: k.CoolingUntil}
	}
	if until, ok := k.ModelGaps[wm]; ok && until.After(now) {
		return &Skip{Key: k, Reason: SkipModelGap, Model: wm, Until: until}
	}
	if until, ok := k.ModelCooling[wm]; ok && until.After(now) {
		return &Skip{Key: k, Reason: SkipCoolingModel, Model: wm, Until: until}
	}
	return nil
}

func addSkip(list []Skip, s Skip) []Skip {
	for _, x := range list {
		if x.Key == s.Key && x.Reason == s.Reason && x.Model == s.Model {
			return list
		}
	}
	return append(list, s)
}

// emptyFromSkips explains a plan whose every key was skipped: cooling until
// the earliest end when any key is cooling, else a Model Gap when any key has
// one, else nothing usable.
func emptyFromSkips(skipped []Skip) *Empty {
	var until, gapUntil time.Time
	var handle, gapHandle, gapModel string
	for _, s := range skipped {
		if (s.Reason == SkipCooling || s.Reason == SkipCoolingModel) && (until.IsZero() || s.Until.Before(until)) {
			until, handle = s.Until, s.Provider.Handle
		}
		if s.Reason == SkipModelGap && (gapUntil.IsZero() || s.Until.Before(gapUntil)) {
			gapUntil, gapHandle, gapModel = s.Until, s.Provider.Handle, s.Model
		}
	}
	if !until.IsZero() {
		return &Empty{Code: Cooling, Until: until,
			Message: fmt.Sprintf("Every usable Upstream Key of %s is cooling; the first is usable again at %s.", handle, until.UTC().Format(time.RFC3339))}
	}
	if !gapUntil.IsZero() {
		return &Empty{Code: ModelGap, Until: gapUntil,
			Message: fmt.Sprintf("Every usable Upstream Key of %s has a Model Gap for %s (the Provider refused them that model); the first expires at %s.",
				gapHandle, gapModel, gapUntil.UTC().Format(time.RFC3339))}
	}
	what := "disabled or invalid"
	for _, s := range skipped {
		if s.Reason == SkipRestricted {
			what = "disabled, invalid or restricted to Endpoints that cannot serve this Request"
			break
		}
	}
	return &Empty{Code: NoUsableKey, Message: fmt.Sprintf("Every Upstream Key of %s is %s.", skipped[0].Provider.Handle, what)}
}

// Counter is the in-memory Rotation of live traffic. It resets on restart.
type Counter struct {
	mu sync.Mutex
	n  map[string]uint64
}

// NewCounter returns an empty Counter.
func NewCounter() *Counter { return &Counter{n: map[string]uint64{}} }

// Next returns the group's counter and advances it.
func (c *Counter) Next(group string) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	v := c.n[group]
	c.n[group] = v + 1
	return v
}

// Fixed is a Rotation that always answers the same value; previews use it
// so planning without sending never moves live traffic's rotation.
type Fixed uint64

// Next returns f.
func (f Fixed) Next(string) uint64 { return uint64(f) }
