// Package planner is candidate planning, the one deep module that decides
// where a Request may go. Given the Request (Shape, model) and the routing
// view of one or more Providers, it returns the ordered list of
// (Provider, Endpoint, Upstream Key, wire model) to try. It does no I/O and
// reads no clock; the only state it consults is the Rotation it is handed.
//
// Ticket 04 order: Providers in the order given (Pool members later); within
// a Provider only Endpoints speaking the Caller's Shape (translation, ticket
// 13, adds other Endpoints after them); Upstream Keys round-robin, each key
// paired with every such Endpoint in configured order. Later tickets add
// exclusions (Key States, Model Gaps, Endpoint restrictions) and tiers
// (known carriers first) here, and nowhere else.
package planner

import (
	"fmt"
	"sync"

	"github.com/hoangvu12/iroha/internal/shape"
)

// Request is what planning needs to know about a Request.
type Request struct {
	Shape shape.Shape // the Caller's Shape
	Model string      // the model as the Caller named it, without any Provider handle
}

// Provider is the routing view of one Provider.
type Provider struct {
	ID        string
	Handle    string
	Endpoints []Endpoint
	Keys      []Key
}

// Endpoint is one URL of a Provider.
type Endpoint struct {
	ID    string
	Name  string
	URL   string // base URL including the version path
	Shape shape.Shape
	// AuthStyle is how the Upstream Key is sent: "bearer" (default), later
	// "x-api-key", "header", "query" or "none" (ticket 09); AuthParam names
	// the header or query parameter for "header" and "query".
	AuthStyle     string
	AuthParam     string
	StaticHeaders map[string]string
	// Renames maps a Caller-facing model name to the name this URL uses.
	Renames map[string]string
}

// Key is one Upstream Key. An empty Secret sends no auth at all.
type Key struct {
	ID     string
	Name   string
	Secret string
}

// Candidate is one Attempt Iroha may make.
type Candidate struct {
	Provider  *Provider
	Endpoint  *Endpoint
	Key       *Key
	WireModel string // the model name sent on this Endpoint
}

// Reasons a plan is empty.
const (
	NoEndpoint    = "no_endpoint"     // no Endpoint speaks the Caller's Shape
	NoUpstreamKey = "no_upstream_key" // the Provider holds no Upstream Keys
)

// Empty explains why nothing can serve the Request.
type Empty struct {
	Code    string
	Message string
}

// Result is the plan: Candidates in the order to try, or why there is none.
type Result struct {
	Candidates []Candidate
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
	var empty *Empty
	for pi := range providers {
		p := &providers[pi]
		var eps []*Endpoint
		for ei := range p.Endpoints {
			if p.Endpoints[ei].Shape == req.Shape {
				eps = append(eps, &p.Endpoints[ei])
			}
		}
		if len(eps) == 0 {
			if empty == nil {
				empty = &Empty{Code: NoEndpoint, Message: fmt.Sprintf("Provider %s has no Endpoint speaking %s.", p.Handle, req.Shape)}
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
		for i := range n {
			k := &p.Keys[(start+i)%n]
			for _, ep := range eps {
				out = append(out, Candidate{Provider: p, Endpoint: ep, Key: k, WireModel: wireModel(ep, req.Model)})
			}
		}
	}
	if len(out) > 0 {
		return Result{Candidates: out}
	}
	if empty == nil {
		empty = &Empty{Code: NoEndpoint, Message: "No Provider was given to plan for."}
	}
	return Result{Empty: empty}
}

func wireModel(ep *Endpoint, model string) string {
	if w, ok := ep.Renames[model]; ok && w != "" {
		return w
	}
	return model
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
