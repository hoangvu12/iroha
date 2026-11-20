package gateway

import (
	"net/http"

	"github.com/hoangvu12/iroha/internal/caching"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/translate"
)

// Caching across Shapes (prompt caching 03): what a translated Attempt adds
// for the Provider's prompt cache. caching.For turns the Endpoint's two
// settings, Shape and host into a policy; translate applies it; the derived
// prompt_cache_key comes from the conversation's affinity value (ticket 02),
// so a conversation has one key per Caller, Provider and model, the same
// value its Upstream Keys are ranked by. Passthrough never comes here.
//
// An Endpoint refusing what was added (a 400 or 422 saying cache_control,
// prompt_cache_key, metadata or user is unknown) is asked again at once, on
// the same key, with nothing added, and keeps getting nothing for the rest
// of the Request. That retry is free: it is recorded as its own Attempt but
// does not use the Request's Attempt budget, and is made at most once per
// Endpoint. Decided over relying on the settings alone: an Endpoint that
// rejects the fields is only found out by sending them, and nothing that
// worked before this ticket may fail now. Decided over a Failure Rule: rules
// judge keys, and this refusal says nothing about the key. The Attempt shows
// why, so the Owner can set the Endpoint's setting off and save the retry.

// cachingFor is what candidate c's translated request gets.
func (x *exchange) cachingFor(c planner.Candidate) translate.Caching {
	if x.plain[c.Endpoint.ID] {
		return translate.Caching{}
	}
	p := caching.For(c.Endpoint.Shape, c.Endpoint.URL, c.Endpoint.CacheMarkers, c.Endpoint.SendPromptCacheKey)
	tc := translate.Caching{Markers: p.Markers, Fields: p.Fields}
	if p.PromptCacheKey {
		model := c.Provider.Model
		if model == "" {
			model = x.model
		}
		tc.PromptCacheKey = caching.PromptCacheKey(x.affinityKey(c.Provider, model))
	}
	return tc
}

// refusedAddition is the field Iroha added to candidate c's request that
// failure f refuses as unknown (caching.Refused); "" when f is no such
// refusal, or c's Endpoint was already asked again without the additions
// in this Request (the retry is made at most once per Endpoint).
func (x *exchange) refusedAddition(c planner.Candidate, f *rules.Failure) string {
	if f == nil || x.plain[c.Endpoint.ID] || (f.Status != http.StatusBadRequest && f.Status != http.StatusUnprocessableEntity) {
		return ""
	}
	return caching.Refused(f.Body, x.added)
}

// KindCacheFieldRefused is logged when an Endpoint refused a field Iroha
// added for the prompt cache and the Attempt is made again without it.
var KindCacheFieldRefused = logs.NewKind("cache_field.refused",
	"An Endpoint refused a field Iroha adds for the prompt cache when translating (cache_control, metadata, user, prompt_cache_key); the Attempt was made again at once without Iroha's additions: endpoint, field, attempt.")

// retryPlain records Attempt a, refused for field, as one to be made again
// at once without Iroha's cache additions on its Endpoint.
func (x *exchange) retryPlain(c planner.Candidate, a requests.Attempt, f *rules.Failure, field string) tried {
	if x.plain == nil {
		x.plain = map[string]bool{}
	}
	x.plain[c.Endpoint.ID] = true
	d := rules.Decision{Outcome: rules.RetryElsewhere, Status: f.Status,
		Reason: "the Endpoint refused " + field + ", which Iroha adds for the prompt cache when translating"}
	a.Outcome, a.Reason = string(d.Outcome), d.Reason
	a.Action = "Asked again at once on the same key without Iroha's cache additions; set the Endpoint's cache_markers or send_prompt_cache_key to off to skip this."
	x.g.log.Warn("an Endpoint refused a cache field Iroha added", logs.Kind(KindCacheFieldRefused), logs.Request(x.rec.ID), logs.Provider(c.Provider.Handle),
		"endpoint", c.Endpoint.Name, "field", field, "attempt", a.Seq)
	return tried{attempt: a, decision: d, failure: f}
}
