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

// Conversation affinity (prompt-caching ticket 02): the turns of one
// conversation go to one Upstream Key, so the Provider's prompt cache stays
// warm. The affinity package says which conversation a Request belongs to;
// the planner ranks each Provider's keys for it (planner.keyOrder); this
// file decides whether it applies (the Provider's switch, the experiment)
// and records what happened on the Request.

// Experiment is the affinity experiment switch: with half, conversations
// whose hash falls in one bucket keep round-robin, so the two halves can be
// compared on the same Providers (GET /api/requests/stats?affinity=on and
// ?affinity=control).
var Experiment = settings.NewChoice(settings.Choice{
	Name:    "affinity.experiment",
	Choices: []string{ExperimentOff, ExperimentHalf},
	Default: ExperimentOff,
	Description: "Conversation affinity experiment. off: every conversation keeps its Upstream Key on Providers with affinity on. " +
		"half: about half the conversations (by a hash of the conversation) are used in turn (round-robin) instead, recorded with affinity control, so their cache use can be compared.",
})

// Values of affinity.experiment.
const (
	ExperimentOff  = "off"
	ExperimentHalf = "half"
)

// conversation is what affinity knows of one Request.
type conversation struct {
	affinity.Conversation        // scoped to the Caller
	mode                  string // requests.AffinityOn, Off, Control or None
}

// conversationOf identifies the conversation of a Request with headers h
// and body from caller (scoped to it), and whether affinity orders the keys
// of rt for it.
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

// callerScope keeps one Caller's conversations apart from another's: a
// Gateway Key by its ID, test sends apart from that key's own traffic.
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

// planned is the conversation planning ranks keys for: its ID when
// affinity applies, else "" (round-robin).
func (c conversation) planned() string {
	if c.mode != requests.AffinityOn {
		return ""
	}
	return c.ID
}

// affinityKey is the affinity value of the Request x serves on Provider p
// for the model asked of it: the conversation, scoped to its Caller, p and
// that model. It is what p's keys are ranked by when affinity applies, and
// the one value to derive anything else per conversation from (ticket 03's
// prompt_cache_key). "" when the Request belongs to no conversation; it
// does not depend on the Provider's affinity switch or the experiment.
func (x *exchange) affinityKey(p *planner.Provider, model string) string {
	return affinity.Key(x.conv.ID, p.ID, model)
}

// noteAffinity records on the Request where its conversation came from and
// whether affinity applied.
func (x *exchange) noteAffinity() {
	x.rec.Affinity = &requests.Affinity{Source: string(x.conv.Source), Mode: x.conv.mode}
}

// notePreferred records whether the key affinity put first (the plan's
// first candidate) answered the Request.
func (x *exchange) notePreferred(first planner.Candidate, served *planner.Candidate) {
	if x.rec.Affinity == nil || x.rec.Affinity.Mode != requests.AffinityOn {
		return
	}
	ok := served != nil && served.Key.ID == first.Key.ID && served.Provider.ID == first.Provider.ID
	x.rec.Affinity.PreferredServed = &ok
}
