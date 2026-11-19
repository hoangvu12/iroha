package gateway

import (
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/gatewaykeys"
	"github.com/hoangvu12/iroha/internal/pools"
)

// Model Pools (ticket 18): a name without a slash on a global route names a
// Pool. Each switched-on member whose Provider is enabled and offers the
// member's model becomes one Provider of the route, in member order, so the
// planner lists the first member's candidates first and the budget loop
// fails over down the list. Members that cannot be planned are noted for the
// route preview (preview.go) and left out.

// Why a member is not planned.
const (
	memberOff         = "off"                  // switched off by the Owner
	memberUnavailable = "provider_unavailable" // its Provider is disabled, archived or gone
	memberNotOffered  = "model_not_offered"    // its model is hidden, or unlisted on a strict Provider
)

// memberNote is one Pool member as routing found it.
type memberNote struct {
	member  pools.RoutingMember
	planned int    // index in route.providers; -1 when not planned
	reason  string // why not planned: memberOff, memberUnavailable, memberNotOffered
	detail  string // the reason in a sentence
}

// poolRoute resolves a Pool name. An unknown Pool and one outside the
// Caller's scope are refused alike (errNotQualified). A Pool's members are
// usable whatever Providers the Gateway Key's scope names: the Pool is the
// grant.
func (x *exchange) poolRoute(caller gatewaykeys.Caller, name string) (route, *api.Error) {
	pl, ok, err := x.g.pools.Lookup(x.ctx, name)
	if err != nil {
		return route{}, api.AsError(err)
	}
	if !ok || !caller.AllowsPool(pl.ID) {
		return route{}, errNotQualified(name)
	}
	x.pool, x.rec.Pool = &pl, pl.Name
	rt := route{pool: &pl}
	for _, m := range pl.Members {
		note := memberNote{member: m, planned: -1}
		switch r, found, err := x.g.providers.Routing(x.ctx, m.Handle); {
		case err != nil:
			return rt, api.AsError(err)
		case !m.Enabled:
			note.reason, note.detail = memberOff, "Switched off by the Owner."
		case !found:
			note.reason, note.detail = memberUnavailable, fmt.Sprintf("Provider %s no longer exists.", m.Handle)
		case !r.Enabled || r.Archived:
			state := "disabled"
			if r.Archived {
				state = "archived"
			}
			note.reason, note.detail = memberUnavailable, fmt.Sprintf("Provider %s is %s.", m.Handle, state)
		default:
			p := r.Provider
			p.Model = m.Model
			if err := x.g.models.Prepare(x.ctx, &p, m.Model); err != nil {
				var ae *api.Error
				if !errors.As(err, &ae) || ae.Status != http.StatusNotFound {
					return rt, api.AsError(err)
				}
				note.reason, note.detail = memberNotOffered, ae.Message
				break
			}
			note.planned = len(rt.providers)
			rt.providers = append(rt.providers, p)
		}
		rt.members = append(rt.members, note)
	}
	if len(rt.providers) == 0 {
		return rt, errNoMember(pl, rt.members)
	}
	return rt, nil
}

// errNoMember refuses a Pool none of whose members can be planned.
func errNoMember(pl pools.Routing, notes []memberNote) *api.Error {
	why := "it has no members"
	if len(notes) > 0 {
		parts := make([]string, 0, len(notes))
		for _, n := range notes {
			parts = append(parts, fmt.Sprintf("#%d %s/%s: %s", n.member.Position, n.member.Handle, n.member.Model, strings.TrimSuffix(n.detail, ".")))
		}
		why = strings.Join(parts, "; ")
	}
	return api.Errorf(http.StatusServiceUnavailable, "no_candidate",
		"Ask the Owner to switch a member on or add one (PATCH /api/pools/"+pl.Name+"); GET /api/route-preview?model="+pl.Name+" shows each member.",
		"No member of Model Pool %s can serve: %s.", pl.Name, why).WithDetails(map[string]string{"reason": "no_member", "pool": pl.Name})
}
