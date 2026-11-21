package planner

import (
	"cmp"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"slices"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/affinity"
	"github.com/hoangvu12/iroha/internal/caching"
	"github.com/hoangvu12/iroha/internal/shape"
)

type Request struct {
	Shape     shape.Shape
	Model     string // the model as the Caller named it, without any Provider handle
	Now       time.Time
	Translate []shape.Shape
	// Affinity is the Caller-scoped conversation ID (affinity.Conversation.ID
	// after For); "" keeps round-robin.
	Affinity string
}

type Provider struct {
	ID        string
	Handle    string
	Endpoints []Endpoint
	Keys      []Key
	// Model is a Pool member's own model; empty means Request.Model.
	Model string
	// Budget overrides; zero means the Gateway's default.
	MaxAttempts int
	FirstByte   time.Duration
	AffinityOff bool
}

// AffinityKey is "" when p's keys round-robin for req.
func (p *Provider) AffinityKey(req Request) string {
	if p.AffinityOff {
		return ""
	}
	return affinity.Key(req.Affinity, p.ID, p.ModelFor(req))
}

// ModelFor is the model asked of this Provider for req, before renames.
func (p *Provider) ModelFor(req Request) string {
	if p.Model != "" {
		return p.Model
	}
	return req.Model
}

type Endpoint struct {
	ID            string
	Name          string
	URL           string // base URL including the version path
	Shape         shape.Shape
	AuthStyle     AuthStyle
	AuthParam     string // the header or query parameter for AuthHeader and AuthQuery
	StaticHeaders map[string]string
	// Renames maps a Caller-facing model name to the name this URL uses.
	Renames map[string]string
	Caching caching.Settings
}

func (e *Endpoint) WireModel(model string) string {
	if w, ok := e.Renames[model]; ok && w != "" {
		return w
	}
	return model
}

type Key struct {
	ID       string
	Name     string
	Secret   string // empty sends no auth at all
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
	// Carries holds the wire models this key's own discovered model list
	// names.
	Carries      map[string]bool
	EndpointGaps map[string]bool
	// WorkedOn maps Endpoint IDs to the latest time the key worked there (a
	// 2xx Attempt or a passing key test).
	WorkedOn map[string]time.Time
}

func (k *Key) Allows(id string) bool {
	return len(k.Endpoints) == 0 || slices.Contains(k.Endpoints, id)
}

func (k *Key) Keyless(e *Endpoint) bool { return k.Secret == "" || e.AuthStyle == AuthNone }

func (k *Key) Recovering(model string) bool {
	_, ok := k.ModelCooling[model]
	return ok || !k.CoolingUntil.IsZero()
}

type Candidate struct {
	Provider  *Provider
	Endpoint  *Endpoint
	Key       *Key
	WireModel string
}

type EmptyCode string

const (
	NoEndpoint    EmptyCode = "no_endpoint"
	NoUpstreamKey EmptyCode = "no_upstream_key"
	NoUsableKey   EmptyCode = "no_usable_key"
	Cooling       EmptyCode = "cooling"   // Empty.Until says until when
	ModelGap      EmptyCode = "model_gap" // Empty.Until is the first expiry
)

type SkipReason string

const (
	SkipDisabled     SkipReason = "disabled"
	SkipInvalid      SkipReason = "invalid"
	SkipCooling      SkipReason = "cooling"
	SkipCoolingModel SkipReason = "cooling_model"
	SkipModelGap     SkipReason = "model_gap"
	SkipRestricted   SkipReason = "restricted"
	SkipEndpointGap  SkipReason = "endpoint_gap"
)

type Empty struct {
	Code     EmptyCode
	Message  string
	Until    time.Time
	Provider string // handle of the Provider the explanation is about
}

type Skip struct {
	Provider *Provider
	Key      *Key
	Model    string    // the wire model, for SkipCoolingModel and SkipModelGap
	Endpoint *Endpoint // for SkipEndpointGap
	Reason   SkipReason
	Until    time.Time // cooling end, or when the Model Gap expires
}

type Result struct {
	Candidates []Candidate
	Skipped    []Skip // once per key and reason
	Empty      *Empty // set when Candidates is empty
}

// Rotation.Next must return a counter that grows by one per call for the
// same group.
type Rotation interface {
	Next(group string) uint64
}

func Plan(req Request, providers []Provider, rot Rotation) Result {
	var out []Candidate
	var skipped []Skip
	var empty *Empty
	for pi := range providers {
		p := &providers[pi]
		tiers := endpointTiers(p, req)
		if len(tiers) == 0 {
			if empty == nil {
				empty = &Empty{Code: NoEndpoint, Message: noEndpoint(p, req), Provider: p.Handle}
			}
			continue
		}
		n := len(p.Keys)
		if n == 0 {
			if empty == nil {
				empty = &Empty{Code: NoUpstreamKey, Message: fmt.Sprintf("Provider %s has no Upstream Keys.", p.Handle), Provider: p.Handle}
			}
			continue
		}
		served := firstServingTier(req, p, tiers, keyOrder(p, req, rot))
		out = append(out, served.candidates...)
		for _, s := range served.skipped {
			skipped = addSkip(skipped, s)
		}
	}
	if len(out) > 0 {
		return Result{Candidates: out, Skipped: skipped}
	}
	if len(skipped) > 0 {
		empty = preferCooling(empty, emptyFromSkips(skipped))
	}
	if empty == nil {
		empty = &Empty{Code: NoEndpoint, Message: "No Provider was given to plan for."}
	}
	return Result{Skipped: skipped, Empty: empty}
}

type tierResult struct {
	candidates []Candidate
	skipped    []Skip
}

func firstServingTier(req Request, p *Provider, tiers [][]*Endpoint, order []int) tierResult {
	var unserved []Skip
	for _, eps := range tiers {
		t := planTier(req, p, eps, order)
		if len(t.candidates) > 0 {
			return t
		}
		for _, s := range t.skipped {
			unserved = addSkip(unserved, s)
		}
	}
	return tierResult{skipped: unserved}
}

func preferCooling(first, fromSkips *Empty) *Empty {
	if first == nil || fromSkips.Code == Cooling {
		return fromSkips
	}
	return first
}

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

func keyOrder(p *Provider, req Request, rot Rotation) []int {
	if ak := p.AffinityKey(req); ak != "" {
		return rendezvousOrder(ak, p.Keys)
	}
	return roundRobinOrder(rot.Next(p.ID), len(p.Keys))
}

func rendezvousOrder(affinityKey string, keys []Key) []int {
	order := make([]int, len(keys))
	scores := make([]uint64, len(keys))
	for i := range keys {
		order[i] = i
		sum := sha256.Sum256([]byte(affinityKey + "/" + keys[i].ID))
		scores[i] = binary.BigEndian.Uint64(sum[:8])
	}
	slices.SortStableFunc(order, func(a, b int) int {
		if c := cmp.Compare(scores[b], scores[a]); c != 0 {
			return c
		}
		return a - b
	})
	return order
}

func roundRobinOrder(turn uint64, n int) []int {
	order := make([]int, n)
	start := int(turn % uint64(n))
	for i := range n {
		order[i] = (start + i) % n
	}
	return order
}

func planTier(req Request, p *Provider, eps []*Endpoint, order []int) tierResult {
	var out []Candidate
	var skipped []Skip
	for _, i := range order {
		k := &p.Keys[i]
		allowed := false
		for _, ep := range eps {
			if !k.Allows(ep.ID) {
				continue
			}
			allowed = true
			wm := ep.WireModel(p.ModelFor(req))
			if s := skip(k, ep, wm, req.Now); s != nil {
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
	slices.SortStableFunc(out, func(a, b Candidate) int {
		if c := recoveringLast(a, b); c != 0 {
			return c
		}
		return carriersFirst(a, b)
	})
	return tierResult{candidates: out, skipped: skipped}
}

func recoveringLast(a, b Candidate) int {
	return trueFirst(!a.Key.Recovering(a.WireModel), !b.Key.Recovering(b.WireModel))
}

func carriersFirst(a, b Candidate) int {
	return trueFirst(a.Key.Carries[a.WireModel], b.Key.Carries[b.WireModel])
}

func trueFirst(a, b bool) int {
	switch {
	case a && !b:
		return -1
	case b && !a:
		return 1
	}
	return 0
}

func skip(k *Key, ep *Endpoint, wm string, now time.Time) *Skip {
	switch {
	case k.Disabled:
		return &Skip{Key: k, Reason: SkipDisabled}
	case k.Invalid:
		return &Skip{Key: k, Reason: SkipInvalid}
	case k.CoolingUntil.After(now):
		return &Skip{Key: k, Reason: SkipCooling, Until: k.CoolingUntil}
	case k.EndpointGaps[ep.ID]:
		return &Skip{Key: k, Reason: SkipEndpointGap, Endpoint: ep}
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
		if x.Key == s.Key && x.Reason == s.Reason && x.Model == s.Model && x.Endpoint == s.Endpoint {
			return list
		}
	}
	return append(list, s)
}

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
		return &Empty{Code: Cooling, Until: until, Provider: handle,
			Message: fmt.Sprintf("Every usable Upstream Key of %s is cooling; the first is usable again at %s.", handle, until.UTC().Format(time.RFC3339))}
	}
	if !gapUntil.IsZero() {
		return &Empty{Code: ModelGap, Until: gapUntil, Provider: gapHandle,
			Message: fmt.Sprintf("Every usable Upstream Key of %s has a Model Gap for %s (the Provider refused them that model); the first expires at %s.",
				gapHandle, gapModel, gapUntil.UTC().Format(time.RFC3339))}
	}
	restricted, gapped := false, false
	for _, s := range skipped {
		restricted = restricted || s.Reason == SkipRestricted
		gapped = gapped || s.Reason == SkipEndpointGap
	}
	what := "disabled or invalid"
	switch {
	case restricted && gapped:
		what = "disabled, invalid, restricted to Endpoints that cannot serve this Request, or has an Endpoint Gap on those that can"
	case restricted:
		what = "disabled, invalid or restricted to Endpoints that cannot serve this Request"
	case gapped:
		what = "disabled, invalid or has an Endpoint Gap on the Endpoints that can serve this Request"
	}
	return &Empty{Code: NoUsableKey, Message: fmt.Sprintf("Every Upstream Key of %s is %s.", skipped[0].Provider.Handle, what), Provider: skipped[0].Provider.Handle}
}

type Counter struct {
	mu sync.Mutex
	n  map[string]uint64
}

func NewCounter() *Counter { return &Counter{n: map[string]uint64{}} }

func (c *Counter) Next(group string) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	v := c.n[group]
	c.n[group] = v + 1
	return v
}

// Peek is a Rotation answering what c would answer next without advancing
// it.
func (c *Counter) Peek() Rotation { return peek{c} }

type peek struct{ c *Counter }

func (p peek) Next(group string) uint64 {
	p.c.mu.Lock()
	defer p.c.mu.Unlock()
	return p.c.n[group]
}

type Fixed uint64

func (f Fixed) Next(string) uint64 { return uint64(f) }
