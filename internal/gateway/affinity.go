package gateway

import (
	"context"
	"net/http"

	"github.com/hoangvu12/iroha/internal/affinity"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/settings"
)

var Experiment = settings.NewChoice(settings.Choice{
	Name:    "affinity.experiment",
	Choices: []string{ExperimentOff, ExperimentHalf},
	Default: ExperimentOff,
	Description: "Conversation affinity experiment. off: every conversation keeps its Upstream Key on Providers with affinity on. " +
		"half: about half the conversations (by a hash of the conversation) are used in turn (round-robin) instead, recorded with affinity control, so their cache use can be compared.",
})

const (
	ExperimentOff  = "off"
	ExperimentHalf = "half"
)

type conversation struct {
	affinity.Conversation
	mode string
}

func (g *Gateway) conversationOf(ctx context.Context, h http.Header, body []byte, caller requests.Caller, rt route) conversation {
	c := conversation{Conversation: affinity.Identify(h, body).For(callerScope(caller))}
	switch {
	case c.ID == "":
		c.mode = requests.AffinityNone
	case allOff(rt):
		c.mode = requests.AffinityOff
	case c.Control() && g.experiment(ctx) == ExperimentHalf:
		c.mode = requests.AffinityControl
	default:
		c.mode = requests.AffinityOn
	}
	return c
}

func callerScope(c requests.Caller) string {
	return c.Kind + ":" + c.GatewayKeyID
}

func allOff(rt route) bool {
	for _, p := range rt.providers {
		if !p.AffinityOff {
			return false
		}
	}
	return true
}

func (g *Gateway) experiment(ctx context.Context) string {
	if g.db == nil {
		return ExperimentOff
	}
	v, err := Experiment.Get(ctx, g.db)
	if err != nil {
		g.log.Error("reading affinity.experiment failed", logs.Kind(logs.KindGeneric), "err", err.Error())
	}
	return v
}

func (c conversation) planned() string {
	if c.mode != requests.AffinityOn {
		return ""
	}
	return c.ID
}

func (x *exchange) affinityKey(p *planner.Provider, model string) string {
	return affinity.Key(x.conv.ID, p.ID, model)
}

func (x *exchange) noteAffinity() {
	x.rec.Affinity = &requests.Affinity{Source: string(x.conv.Source), Mode: x.conv.mode}
}

func (x *exchange) noteServed(first planner.Candidate, last *planner.Candidate, success bool) {
	if x.rec.Affinity == nil || x.conv.mode == requests.AffinityNone {
		return
	}
	if last != nil && last.Provider.AffinityOff {
		x.rec.Affinity.Mode = requests.AffinityOff
	}
	if x.rec.Affinity.Mode != requests.AffinityOn {
		return
	}
	ok := success && last != nil && last.Key.ID == first.Key.ID && last.Provider.ID == first.Provider.ID
	x.rec.Affinity.PreferredServed = &ok
}
