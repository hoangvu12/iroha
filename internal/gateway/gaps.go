package gateway

import (
	"time"

	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
)

// expireGaps deletes (and logs as expired) the Model Gaps of p that expired
// by now. Planning ignores them already; this only tidies the store, so it
// runs only when the routing view holds one.
func (g *Gateway) expireGaps(x *exchange, p *planner.Provider, now time.Time) {
	for _, k := range p.Keys {
		for _, until := range k.ModelGaps {
			if !until.After(now) {
				if err := g.states.ExpireGaps(x.ctx, p.ID, p.Handle); err != nil {
					g.log.Error("expiring Model Gaps failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
				}
				return
			}
		}
	}
}
