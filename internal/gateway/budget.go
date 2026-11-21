package gateway

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/store"
)

type tried struct {
	attempt  requests.Attempt
	decision rules.Decision
	failure  *rules.Failure
	effect   keystate.Effect
}

func (x *exchange) pauseUntil(t time.Time) bool {
	d := t.Sub(x.g.clock.Now())
	if d <= 0 {
		return true
	}
	return clock.Sleep(x.ctx, x.g.clock, d) == nil
}

func (x *exchange) serve(cands []planner.Candidate, body []byte, cr callerRequest) {
	maxAttempts, _ := x.budget(cands[0].Provider)
	policy := newRetryPolicy(cands, maxAttempts, x.firstByteDeadline)
	set := x.g.rules()
	var failed []tried
	var last *planner.Candidate
	for {
		s, ok := policy.Next(x.g.clock.Now())
		if !ok {
			break
		}
		if s.kind == replay && !x.pauseUntil(s.notBefore) {
			x.endedEarly(cands[0], last, failed)
			return
		}
		if s.seq == 1 {
			x.noteProvider(s.c.Provider)
		}
		last = &s.c
		a, f, added := x.attempt(s, body, cr)
		if f == nil {
			x.answered(cands[0], s.c, a, failed)
			return
		}
		t, o := x.judge(set, s, a, f, added)
		x.recordAttempt(t.attempt)
		failed = append(failed, t)
		policy.Record(s, o)
		if !o.refusedCacheAddition && x.ctx.Err() != nil {
			x.endedEarly(cands[0], last, failed)
			return
		}
	}
	x.noteServed(cands[0], last, false)
	x.failAll(failed, policy.stopped(), maxAttempts)
}

func (x *exchange) answered(first, c planner.Candidate, a requests.Attempt, failed []tried) {
	ok := a.Status >= 200 && a.Status < 300
	x.noteServed(first, &c, ok && a.Error == "")
	x.recordAttempt(a)
	if ok {
		x.worked(c)
	}
	x.summarize(failed, &a, "")
}

func (x *exchange) endedEarly(first planner.Candidate, last *planner.Candidate, failed []tried) {
	x.noteServed(first, last, false)
	x.stopped()
	x.summarize(failed, nil, "")
}

func (x *exchange) judge(set *rules.Set, s step, a requests.Attempt, f *rules.Failure, added cacheAdditions) (tried, outcome) {
	d := noCredential(set.Classify(*f, x.g.clock.Now()), s.c)
	if r, ok := refusedCacheAddition(s, added, f, d); ok {
		return x.askAgainWithoutCacheAdditions(s.c, a, f, r), outcome{refusedCacheAddition: true}
	}
	t := x.applyDecision(s.c, a, f, d)
	return t, outcome{decision: d, effect: t.effect, timeout: f.Timeout, answerHeader: f.Header, at: x.g.clock.Now()}
}

func (x *exchange) budget(p *planner.Provider) (int, time.Duration) {
	n, fb := providers.EffectiveBudget(p.MaxAttempts, p.FirstByte)
	if x.pool != nil {
		if x.pool.MaxAttempts > 0 {
			n = x.pool.MaxAttempts
		}
		if x.pool.FirstByte > 0 {
			_, fb = providers.EffectiveBudget(0, x.pool.FirstByte)
		}
	}
	return n, fb
}

func (x *exchange) firstByteDeadline(c planner.Candidate) time.Time {
	_, fb := x.budget(c.Provider)
	deadline, ceiling := x.start.Add(fb), x.start.Add(providers.FirstByteCeiling)
	if deadline.After(ceiling) {
		return ceiling
	}
	return deadline
}

func (x *exchange) applyDecision(c planner.Candidate, a requests.Attempt, f *rules.Failure, d rules.Decision) tried {
	g := x.g
	t := tried{attempt: a, decision: d, failure: f}
	k := keystate.Key{ID: c.Key.ID, Name: c.Key.Name, Provider: c.Provider.Handle}
	switch d.Outcome {
	case rules.Invalid, rules.CoolingKey, rules.CoolingKeyModel, rules.ModelGap:
		eff, err := g.states.Fail(x.ctx, keystate.Failure{Key: k, Endpoint: keystate.Endpoint{ID: c.Endpoint.ID, Name: c.Endpoint.Name},
			Model: c.WireModel, RequestID: x.rec.ID, Decision: d})
		if err != nil {
			g.log.Error("recording a Key State failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
		}
		t.effect = eff
		t.attempt.Action = eff.Action
	case rules.RetryElsewhere:
		t.attempt.Action = "Key State unchanged; moved on to the next candidate."
	case rules.FailRequest:
		t.attempt.Action = "Request failed: the Provider refused the request itself, so no other key would do better."
	}
	t.attempt.Rule, t.attempt.Outcome, t.attempt.Reason = d.Rule, string(d.Outcome), d.Reason
	attrs := []any{logs.Kind(logs.KindRuleMatch), logs.Request(x.rec.ID), logs.Provider(c.Provider.Handle),
		"rule", d.Rule, "outcome", string(d.Outcome), "action", t.attempt.Action, "attempt", a.Seq,
		"upstream_key", c.Key.Name, "model", c.WireModel, "status", f.Status, "reason", d.Reason}
	g.log.Info("Failure Rule matched", attrs...)
	return t
}

func (x *exchange) worked(c planner.Candidate) {
	g := x.g
	k := keystate.Key{ID: c.Key.ID, Name: c.Key.Name, Provider: c.Provider.Handle}
	if c.Key.Recovering(c.WireModel) {
		if err := g.states.Succeeded(x.ctx, k, c.WireModel, x.rec.ID); err != nil {
			g.log.Error("clearing a Key State failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
		}
	}
	last, ok := c.Key.WorkedOn[c.Endpoint.ID]
	if ok && g.clock.Now().Sub(last) < store.TouchEvery && !c.Key.EndpointGaps[c.Endpoint.ID] {
		return
	}
	if err := g.states.Worked(x.ctx, k, keystate.Endpoint{ID: c.Endpoint.ID, Name: c.Endpoint.Name}, x.rec.ID); err != nil {
		g.log.Error("recording where a key works failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
	}
}

func noCredential(d rules.Decision, c planner.Candidate) rules.Decision {
	if d.Outcome == rules.Invalid && c.Key.Keyless(c.Endpoint) {
		d.Outcome = rules.RetryElsewhere
		d.Reason += " (no credential was sent, so the key is not invalid)"
	}
	return d
}

func (x *exchange) noteProvider(p *planner.Provider) {
	if !x.recorded {
		return
	}
	if err := x.g.rec.NoteProvider(x.ctx, x.rec.ID, p.ID, p.Handle, x.rec.Pool); err != nil {
		x.g.log.Error("recording a Request failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
	}
}

func (x *exchange) summarize(failed []tried, last *requests.Attempt, stop string) {
	if len(failed) == 0 {
		return
	}
	parts := make([]string, 0, len(failed)+2)
	for _, t := range failed {
		parts = append(parts, describe(t))
	}
	if last != nil {
		s := fmt.Sprintf("#%d %s: %d", last.Seq, last.UpstreamKey, last.Status)
		if last.Error != "" {
			s += " (" + last.Error + ")"
		}
		parts = append(parts, s)
	}
	if stop != "" {
		parts = append(parts, stop)
	}
	x.rec.Summary = strings.Join(parts, "; ")
}

func describe(t tried) string {
	s := fmt.Sprintf("#%d %s: %s", t.attempt.Seq, t.attempt.UpstreamKey, t.decision.Reason)
	rule := t.decision.Rule
	if rule == "" {
		rule = "no rule"
	}
	s += " -> " + rule + ", " + string(t.decision.Outcome)
	if !t.effect.Until.IsZero() {
		s += " until " + t.effect.Until.UTC().Format("15:04:05")
	}
	return s
}

type attemptView struct {
	Seq         int    `json:"seq"`
	Provider    string `json:"provider"`
	Endpoint    string `json:"endpoint"`
	UpstreamKey string `json:"upstream_key"`
	Model       string `json:"model"`
	Status      int    `json:"status"`
	Rule        string `json:"rule,omitempty"`
	Outcome     string `json:"outcome"`
	Reason      string `json:"reason"`
	Action      string `json:"action"`
}

func (x *exchange) failAll(failed []tried, stop stopReason, maxAttempts int) {
	handle := x.rec.Provider
	subject, on := "Provider "+handle, handle
	if x.pool != nil {
		subject, on = "Model Pool "+x.pool.Name, "Model Pool "+x.pool.Name
	}
	var stopText string
	switch stop {
	case stopAttempts:
		stopText = fmt.Sprintf("stopped: all %d Attempts of the budget used", maxAttempts)
	case stopTime:
		stopText = "stopped: the time budget for the first byte ran out"
	case stopCandidates:
		stopText = "stopped: no Upstream Key left to try"
	}
	x.summarize(failed, nil, stopText)
	last := failed[len(failed)-1]
	views := make([]attemptView, 0, len(failed))
	for _, t := range failed {
		views = append(views, attemptView{Seq: t.attempt.Seq, Provider: t.attempt.Provider, Endpoint: t.attempt.Endpoint, UpstreamKey: t.attempt.UpstreamKey,
			Model: t.attempt.WireModel, Status: t.attempt.Status, Rule: t.decision.Rule, Outcome: string(t.decision.Outcome), Reason: t.decision.Reason, Action: t.attempt.Action})
	}
	details := map[string]any{"attempts": views, "summary": x.rec.Summary}
	n := len(failed)
	plural := "Attempts"
	if n == 1 {
		plural = "Attempt"
	}
	reqHint := "GET /api/requests/" + x.rec.ID + " (Admin Token) shows every Attempt with the Provider's full answer."

	var e *api.Error
	switch {
	case allGaps(failed):
		e = api.Errorf(http.StatusNotFound, "model_unavailable", "Use another model; every key that tried it now has a Model Gap for it (GET /api/providers/"+handle+"/model-gaps, Admin Token). "+reqHint,
			"Provider %s refused %s on every key tried: %s", handle, last.attempt.WireModel, last.decision.Reason)
		details["reason"] = planner.ModelGap
	case last.decision.Outcome == rules.FailRequest:
		status := last.decision.Status
		if status < 400 || status > 599 {
			status = http.StatusBadGateway
		}
		e = api.Errorf(status, "upstream_rejected", "Fix the request as the Provider's message says; another key would be refused the same way. "+reqHint,
			"Provider %s refused the request: %s", handle, last.decision.Reason)
	case last.failure.Timeout || stop == stopTime:
		e = api.Errorf(http.StatusGatewayTimeout, "upstream_timeout", "Retry later, or ask the Owner to raise the Provider's first_byte_seconds (at most 95). "+reqHint,
			"%s did not answer within the time budget (%d %s): %s", subject, n, plural, x.rec.Summary)
	default:
		retry := earliestCooling(failed, x.g.clock.Now())
		if retry > 0 {
			x.out.setHeader("Retry-After", strconv.Itoa(int(retry.Seconds())))
			e = api.Errorf(http.StatusServiceUnavailable, "upstream_unavailable", fmt.Sprintf("Retry after %d seconds (Retry-After), when the first key cools down. %s", int(retry.Seconds()), reqHint),
				"Every Attempt on %s failed (%d %s): %s", on, n, plural, x.rec.Summary)
		} else {
			e = api.Errorf(http.StatusBadGateway, "upstream_failed", "Retry in a moment; if it keeps failing, read the Attempts. "+reqHint,
				"Every Attempt on %s failed (%d %s): %s", on, n, plural, x.rec.Summary)
		}
	}
	x.fail(e.WithDetails(details))
}

func allGaps(failed []tried) bool {
	for _, t := range failed {
		if t.decision.Outcome != rules.ModelGap {
			return false
		}
	}
	return len(failed) > 0
}

func earliestCooling(failed []tried, now time.Time) time.Duration {
	var best time.Time
	for _, t := range failed {
		if u := t.effect.Until; !u.IsZero() && (best.IsZero() || u.Before(best)) {
			best = u
		}
	}
	if best.IsZero() {
		return 0
	}
	d := best.Sub(now).Round(time.Second)
	if d < time.Second {
		d = time.Second
	}
	return d
}
