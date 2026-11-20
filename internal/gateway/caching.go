package gateway

import (
	"net/http"
	"strings"

	"github.com/hoangvu12/iroha/internal/caching"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/translate"
)

// What an Attempt adds for the Provider's prompt cache. caching.For turns
// the Endpoint's two settings, Shape and host into a policy.
//
// Caching across Shapes (prompt caching 03): translate applies the policy's
// markers and conversation fields to a translated Attempt.
//
// The conversation's ID on every Attempt (prompt caching 04): the derived
// ID comes from the conversation's affinity value (ticket 02), so a
// conversation has one per Caller, Provider and model, the same value its
// Upstream Keys are ranked by; never the Caller's raw session string, since
// many Endpoints are third-party relays. It goes in the session headers
// relays route by (every Shape, strict hosts too) and, on OpenAI Chat and
// Responses Endpoints, as prompt_cache_key: translation adds it, and
// passthrough appends it with setField, so the only change to the Caller's
// bytes is that one field. A value the Caller sent itself is never replaced.
//
// An Endpoint refusing what was added (a 400 or 422 saying cache_control,
// prompt_cache_key, metadata or user is unknown) is asked again at once, on
// the same key, with nothing added, and keeps getting nothing for the rest
// of the Request. On passthrough the added prompt_cache_key is the only
// difference from the Caller's request, so any 400 or 422 the Failure Rules
// would end the Request with is asked again the same way, whatever its
// wording; a 400 the rules read as the key's or model's keeps its normal
// handling. That retry is free: it is recorded as its own Attempt but does
// not use the Request's Attempt budget, and is made at most once per
// Endpoint. Decided over relying on the settings alone: an Endpoint that
// rejects the fields is only found out by sending them, and nothing that
// worked before may fail now. Decided over a Failure Rule: rules judge keys,
// and this refusal says nothing about the key. The Attempt shows why, so
// the Owner can set the Endpoint's setting off and save the retry. Session
// headers stay on the retry: unknown headers are ignored in practice.

// conversationID is the derived ID of the Request's conversation on
// candidate c's Provider and model; "" when it belongs to no conversation.
func (x *exchange) conversationID(c planner.Candidate) string {
	model := c.Provider.Model
	if model == "" {
		model = x.model
	}
	return caching.PromptCacheKey(x.affinityKey(c.Provider, model))
}

// cachingFor is what candidate c's translated request gets.
func (x *exchange) cachingFor(c planner.Candidate) translate.Caching {
	if x.plain[c.Endpoint.ID] {
		return translate.Caching{}
	}
	p := caching.For(c.Endpoint.Shape, c.Endpoint.URL, c.Endpoint.Caching)
	tc := translate.Caching{Markers: p.Markers, Fields: p.Fields}
	if p.PromptCacheKey {
		tc.PromptCacheKey = x.conversationID(c)
	}
	return tc
}

// passthroughCaching returns the passthrough body for candidate c with the
// conversation's prompt_cache_key appended when the Endpoint takes one and
// the Caller sent none, and records the addition in x.added.
func (x *exchange) passthroughCaching(c planner.Candidate, body []byte) []byte {
	sh := c.Endpoint.Shape
	if (sh != shape.OpenAIChat && sh != shape.OpenAIResponses) || x.plain[c.Endpoint.ID] ||
		!caching.For(sh, c.Endpoint.URL, c.Endpoint.Caching).PromptCacheKey {
		return body
	}
	id := x.conversationID(c)
	if id == "" {
		return body
	}
	if _, ok := field(body, "prompt_cache_key"); ok {
		return body
	}
	out, ok := setField(body, "prompt_cache_key", jsonString(id))
	if !ok {
		return body
	}
	x.added, x.addedPass = []string{"prompt_cache_key"}, true
	return out
}

// sessionHeaders returns h with the conversation's derived ID in the
// session headers the Caller did not send, when candidate c's Endpoint
// takes them; h itself is never changed.
func (x *exchange) sessionHeaders(c planner.Candidate, h http.Header) http.Header {
	if !caching.For(c.Endpoint.Shape, c.Endpoint.URL, c.Endpoint.Caching).SessionHeaders {
		return h
	}
	id := x.conversationID(c)
	if id == "" {
		return h
	}
	h = h.Clone()
	caching.SetSessionHeaders(h, id)
	return h
}

// refusedAddition says why failure f of candidate c's Attempt is to be
// asked again without Iroha's additions: field is what was refused (or
// added, on passthrough), reason the Attempt's reason. "" when f is no such
// refusal, nothing was added, or c's Endpoint was already asked again
// without the additions in this Request (at most once per Endpoint).
func (x *exchange) refusedAddition(set *rules.Set, c planner.Candidate, f *rules.Failure) (field, reason string) {
	if f == nil || len(x.added) == 0 || x.plain[c.Endpoint.ID] || (f.Status != http.StatusBadRequest && f.Status != http.StatusUnprocessableEntity) {
		return "", ""
	}
	if field := caching.Refused(f.Body, x.added); field != "" {
		return field, "the Endpoint refused " + field + ", which Iroha adds for the prompt cache"
	}
	if x.addedPass && noCredential(set.Classify(*f, x.g.clock.Now()), c).Outcome == rules.FailRequest {
		field = strings.Join(x.added, ", ")
		return field, "the Endpoint refused the request with " + field + " added by Iroha for the prompt cache, the only change to the Caller's request"
	}
	return "", ""
}

// KindCacheFieldRefused is logged when an Endpoint refused a request with
// a field Iroha added for the prompt cache and the Attempt is made again
// without it.
var KindCacheFieldRefused = logs.NewKind("cache_field.refused",
	"An Endpoint refused a request with a field Iroha adds for the prompt cache (cache_control, metadata or user when translating; prompt_cache_key, passthrough too); the Attempt was made again at once without Iroha's additions: endpoint, field, attempt.")

// retryPlain records Attempt a, refused for field, as one to be made again
// at once without Iroha's cache additions on its Endpoint.
func (x *exchange) retryPlain(c planner.Candidate, a requests.Attempt, f *rules.Failure, field, reason string) tried {
	if x.plain == nil {
		x.plain = map[string]bool{}
	}
	x.plain[c.Endpoint.ID] = true
	d := rules.Decision{Outcome: rules.RetryElsewhere, Status: f.Status, Reason: reason}
	a.Outcome, a.Reason = string(d.Outcome), d.Reason
	a.Action = "Asked again at once on the same key without Iroha's cache additions; set the Endpoint's cache_markers or send_prompt_cache_key to off to skip this."
	x.g.log.Warn("an Endpoint refused a cache field Iroha added", logs.Kind(KindCacheFieldRefused), logs.Request(x.rec.ID), logs.Provider(c.Provider.Handle),
		"endpoint", c.Endpoint.Name, "field", field, "attempt", a.Seq)
	return tried{attempt: a, decision: d, failure: f}
}
