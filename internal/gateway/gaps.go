package gateway

import (
	"time"

	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
)

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
