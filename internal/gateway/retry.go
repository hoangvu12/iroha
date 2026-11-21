package gateway

import (
	"math/rand/v2"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/caching"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/rules"
)

type stopReason string

const (
	stopAttempts   stopReason = "attempts"
	stopTime       stopReason = "time"
	stopCandidates stopReason = "candidates"
	stopRule       stopReason = "rule"
)

type stepKind int

const (
	firstTry stepKind = iota
	replay
	retryWithoutCacheAdditions
)

type step struct {
	c                     planner.Candidate
	kind                  stepKind
	seq                   int
	deadline              time.Time
	notBefore             time.Time
	withoutCacheAdditions bool
}

type outcome struct {
	decision             rules.Decision
	effect               keystate.Effect
	timeout              bool
	answerHeader         http.Header
	at                   time.Time
	refusedCacheAddition bool
}

type keyModel struct{ key, model string }

type keyEndpoint struct{ key, endpoint string }

func keyModelOf(c planner.Candidate) keyModel { return keyModel{c.Key.ID, c.WireModel} }

func keyEndpointOf(c planner.Candidate) keyEndpoint { return keyEndpoint{c.Key.ID, c.Endpoint.ID} }

type exclusions struct {
	keys         map[string]bool
	keyModels    map[keyModel]bool
	keyEndpoints map[keyEndpoint]bool
}

func (e exclusions) exclude(s step) bool {
	c := s.c
	return e.keys[c.Key.ID] || e.keyModels[keyModelOf(c)] || (s.kind != replay && e.keyEndpoints[keyEndpointOf(c)])
}

type retryPolicy struct {
	queue       []step
	next        int
	maxAttempts int
	deadlineOf  func(planner.Candidate) time.Time
	jitter      func() float64

	made, used     int
	stop           stopReason
	out            exclusions
	replayed       map[keyEndpoint]bool
	plainEndpoints map[string]bool
}

func newRetryPolicy(cands []planner.Candidate, maxAttempts int, deadlineOf func(planner.Candidate) time.Time) *retryPolicy {
	p := &retryPolicy{maxAttempts: maxAttempts, deadlineOf: deadlineOf, jitter: rand.Float64,
		out:      exclusions{keys: map[string]bool{}, keyModels: map[keyModel]bool{}, keyEndpoints: map[keyEndpoint]bool{}},
		replayed: map[keyEndpoint]bool{}, plainEndpoints: map[string]bool{}}
	for _, c := range cands {
		p.queue = append(p.queue, step{c: c})
	}
	return p
}

func (p *retryPolicy) Next(now time.Time) (step, bool) {
	for p.stop == "" && p.next < len(p.queue) {
		s := p.queue[p.next]
		p.next++
		if p.out.exclude(s) {
			continue
		}
		if p.used >= p.maxAttempts && s.kind != retryWithoutCacheAdditions {
			p.stop = stopAttempts
			break
		}
		s.deadline = p.deadlineOf(s.c)
		if !now.Before(s.deadline) {
			p.stop = stopTime
			break
		}
		if s.kind == replay && !s.notBefore.Before(s.deadline) {
			continue
		}
		p.made++
		if s.kind != retryWithoutCacheAdditions {
			p.used++
		}
		s.seq = p.made
		s.withoutCacheAdditions = p.plainEndpoints[s.c.Endpoint.ID]
		return s, true
	}
	if p.stop == "" {
		p.stop = stopCandidates
	}
	return step{}, false
}

func (p *retryPolicy) Record(s step, o outcome) {
	c := s.c
	if o.refusedCacheAddition {
		p.plainEndpoints[c.Endpoint.ID] = true
		p.queue = append(p.queue[:p.next], append([]step{{c: c, kind: retryWithoutCacheAdditions}}, p.queue[p.next:]...)...)
		return
	}
	switch o.decision.Outcome {
	case rules.FailRequest:
		p.stop = stopRule
		return
	case rules.RetryElsewhere:
		p.out.keyEndpoints[keyEndpointOf(c)] = true
	case rules.Invalid:
		if o.effect.EndpointGap != "" {
			p.out.keyEndpoints[keyEndpointOf(c)] = true
		} else {
			p.out.keys[c.Key.ID] = true
		}
	case rules.CoolingKeyModel, rules.ModelGap:
		p.out.keyModels[keyModelOf(c)] = true
		if o.effect.Escalated {
			p.out.keys[c.Key.ID] = true
		}
	default:
		p.out.keys[c.Key.ID] = true
	}
	if o.timeout {
		p.out.keyEndpoints[keyEndpointOf(c)] = true
	}
	if pair := keyEndpointOf(c); replayable(o) && !p.replayed[pair] {
		p.replayed[pair] = true
		pause := replayPause(len(p.replayed), o.answerHeader, o.at, p.jitter())
		p.queue = append(p.queue, step{c: c, kind: replay, notBefore: o.at.Add(pause)})
	}
}

func replayable(o outcome) bool {
	return o.decision.Outcome == rules.RetryElsewhere && o.decision.Status >= 500 && !o.timeout
}

func (p *retryPolicy) stopped() stopReason { return p.stop }

func (p *retryPolicy) budgetUsed() int { return p.used }

const (
	replayBase          = 250 * time.Millisecond
	replayMax           = 8 * time.Second
	replayRetryAfterMax = 60 * time.Second
)

func replayPause(n int, h http.Header, now time.Time, jitter float64) time.Duration {
	d := replayBase << min(n-1, 5)
	d = min(d, replayMax)
	d = time.Duration(float64(d) * (0.5 + jitter))
	if ra := askedWait(h, now); ra > d {
		d = min(ra, replayRetryAfterMax)
	}
	return d
}

func askedWait(h http.Header, now time.Time) time.Duration {
	if h == nil {
		return 0
	}
	if v := strings.TrimSpace(h.Get("Retry-After-Ms")); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
			return time.Duration(n * float64(time.Millisecond))
		}
	}
	if t, ok := rules.ParseReset(h.Get("Retry-After"), now); ok && t.After(now) {
		return t.Sub(now)
	}
	return 0
}

type cacheAdditions struct {
	fields      []string
	passthrough bool
}

type cacheRefusal struct {
	field, reason string
}

func refusedCacheAddition(s step, added cacheAdditions, f *rules.Failure, d rules.Decision) (cacheRefusal, bool) {
	if len(added.fields) == 0 || s.withoutCacheAdditions || (f.Status != http.StatusBadRequest && f.Status != http.StatusUnprocessableEntity) {
		return cacheRefusal{}, false
	}
	if field := caching.Refused(f.Body, added.fields); field != "" {
		return cacheRefusal{field, "the Endpoint refused " + field + ", which Iroha adds for the prompt cache"}, true
	}
	if added.passthrough && d.Outcome == rules.FailRequest {
		field := strings.Join(added.fields, ", ")
		return cacheRefusal{field, "the Endpoint refused the request with " + field + " added by Iroha for the prompt cache, the only change to the Caller's request"}, true
	}
	return cacheRefusal{}, false
}
