package gateway

import (
	"net/http"

	"github.com/hoangvu12/iroha/internal/caching"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/translate"
)

func (x *exchange) conversationID(c planner.Candidate) string {
	return caching.PromptCacheKey(x.affinityKey(c.Provider, c.Provider.ModelFor(x.planned)))
}

func (x *exchange) cachingFor(c planner.Candidate, withoutAdditions bool) translate.Caching {
	if withoutAdditions {
		return translate.Caching{}
	}
	p := caching.For(c.Endpoint.Shape, c.Endpoint.URL, c.Endpoint.Caching)
	tc := translate.Caching{Markers: p.Markers, Fields: p.Fields}
	if p.PromptCacheKey {
		tc.PromptCacheKey = x.conversationID(c)
	}
	return tc
}

func (x *exchange) passthroughCaching(c planner.Candidate, body []byte, withoutAdditions bool) ([]byte, cacheAdditions) {
	sh := c.Endpoint.Shape
	if (sh != shape.OpenAIChat && sh != shape.OpenAIResponses) || withoutAdditions ||
		!caching.For(sh, c.Endpoint.URL, c.Endpoint.Caching).PromptCacheKey {
		return body, cacheAdditions{}
	}
	id := x.conversationID(c)
	if id == "" {
		return body, cacheAdditions{}
	}
	if _, ok := field(body, "prompt_cache_key"); ok {
		return body, cacheAdditions{}
	}
	out, ok := setField(body, "prompt_cache_key", jsonString(id))
	if !ok {
		return body, cacheAdditions{}
	}
	return out, cacheAdditions{fields: []string{"prompt_cache_key"}, passthrough: true}
}

// Recipients ignore header fields they do not recognise (RFC 9110, section
// 5.1), so session headers stay on the retry without the cache additions.
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

var KindCacheFieldRefused = logs.NewKind("cache_field.refused",
	"An Endpoint refused a request with a field Iroha adds for the prompt cache (cache_control, metadata or user when translating; prompt_cache_key, passthrough too); the Attempt was made again at once without Iroha's additions: endpoint, field, attempt.")

func (x *exchange) askAgainWithoutCacheAdditions(c planner.Candidate, a requests.Attempt, f *rules.Failure, r cacheRefusal) tried {
	d := rules.Decision{Outcome: rules.RetryElsewhere, Status: f.Status, Reason: r.reason}
	a.Outcome, a.Reason = string(d.Outcome), d.Reason
	a.Action = "Asked again at once on the same key without Iroha's cache additions; set the Endpoint's cache_markers or send_prompt_cache_key to off to skip this."
	x.g.log.Warn("an Endpoint refused a cache field Iroha added", logs.Kind(KindCacheFieldRefused), logs.Request(x.rec.ID), logs.Provider(c.Provider.Handle),
		"endpoint", c.Endpoint.Name, "field", r.field, "attempt", a.Seq)
	return tried{attempt: a, decision: d, failure: f}
}
