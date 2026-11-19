package gateway

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/providers"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
)

// The Request budget: at most MaxAttempts Attempts, and the first upstream
// byte within FirstByte of the Request's arrival (per Provider, overridable),
// never later than providers.FirstByteCeiling.
//
// Candidates are tried in plan order. A failed Attempt is classified by the
// Failure Rules; its outcome changes the key's Key State and says whether
// to move on. A key that was refused (invalid, cooling, Model Gap) is not
// tried again in this Request; a 5xx may be replayed once on the same key
// and Endpoint after every other candidate, but a timeout never is.

// stop reasons of the loop.
const (
	stopAttempts   = "attempts"   // MaxAttempts used
	stopTime       = "time"       // the first-byte budget ran out
	stopCandidates = "candidates" // no candidate left
	stopRule       = "rule"       // a rule said fail_request
)

// tried is one finished failed Attempt, for the Caller's error and the summary.
type tried struct {
	attempt  requests.Attempt
	decision rules.Decision
	failure  *rules.Failure
	effect   keystate.Effect
}

type queued struct {
	c      planner.Candidate
	replay bool
}

// serve runs the budget loop over the plan's candidates and answers the
// Caller, whatever its Shape.
func (x *exchange) serve(cands []planner.Candidate, body []byte, cr callerRequest) {
	g := x.g
	first := cands[0].Provider
	maxAttempts, _ := providers.EffectiveBudget(first.MaxAttempts, first.FirstByte)
	ceiling := x.start.Add(providers.FirstByteCeiling)
	set := g.rules()

	queue := make([]queued, 0, len(cands))
	for _, c := range cands {
		queue = append(queue, queued{c: c})
	}
	keyOut := map[string]bool{}  // key IDs refused for this Request
	pairOut := map[string]bool{} // key ID + Endpoint ID that failed
	replayed := map[string]bool{}
	var failed []tried
	stop := stopCandidates
	seq := 0
	for i := 0; i < len(queue); i++ {
		q := queue[i]
		c := q.c
		pair := c.Key.ID + "\x00" + c.Endpoint.ID
		if keyOut[c.Key.ID] || (pairOut[pair] && !q.replay) {
			continue
		}
		if seq >= maxAttempts {
			stop = stopAttempts
			break
		}
		_, fb := providers.EffectiveBudget(c.Provider.MaxAttempts, c.Provider.FirstByte)
		deadline := x.start.Add(fb)
		if deadline.After(ceiling) {
			deadline = ceiling
		}
		if !g.clock.Now().Before(deadline) {
			stop = stopTime
			break
		}
		seq++
		if seq == 1 {
			x.noteProvider(c.Provider)
		}
		a, f := x.attempt(seq, c, body, cr, deadline)
		if f == nil { // answered
			x.recordAttempt(a)
			if a.Status >= 200 && a.Status < 300 && c.Key.Recovering(c.WireModel) {
				k := keystate.Key{ID: c.Key.ID, Name: c.Key.Name, Provider: c.Provider.Handle}
				if err := g.states.Succeeded(x.ctx, k, c.WireModel, x.rec.ID); err != nil {
					g.log.Error("clearing a Key State failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
				}
			}
			x.summarize(failed, &a, "")
			return
		}
		t := x.classify(set, c, a, f)
		x.recordAttempt(t.attempt)
		failed = append(failed, t)
		if x.ctx.Err() != nil {
			x.stopped()
			x.summarize(failed, nil, "")
			return
		}
		switch t.decision.Outcome {
		case rules.FailRequest:
			stop = stopRule
		case rules.RetryElsewhere:
			pairOut[pair] = true
			if f.Status >= 500 && !replayed[pair] {
				replayed[pair] = true
				queue = append(queue, queued{c: c, replay: true})
			}
		default: // invalid, cooling, Model Gap: this key is out for this Request
			keyOut[c.Key.ID] = true
		}
		if stop == stopRule {
			break
		}
		if t.failure.Timeout {
			pairOut[pair] = true // never replay an Attempt that used up its time
		}
	}
	x.failAll(failed, stop, maxAttempts)
}

// classify runs the Failure Rules on a failed Attempt, applies the outcome
// to the key's Key State and fills in the Attempt's rule, outcome and action.
func (x *exchange) classify(set *rules.Set, c planner.Candidate, a requests.Attempt, f *rules.Failure) tried {
	g := x.g
	d := noCredential(set.Classify(*f, g.clock.Now()), c)
	t := tried{attempt: a, decision: d, failure: f}
	k := keystate.Key{ID: c.Key.ID, Name: c.Key.Name, Provider: c.Provider.Handle}
	switch d.Outcome {
	case rules.Invalid, rules.CoolingKey, rules.CoolingKeyModel, rules.ModelGap:
		eff, err := g.states.Fail(x.ctx, keystate.Failure{Key: k, Model: c.WireModel, RequestID: x.rec.ID, Decision: d})
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

// noCredential keeps a keyless Attempt (empty secret, or auth style none)
// from making its key invalid: an auth refusal of a request that carried no
// credential says the Endpoint wants one, not that the key is bad.
func noCredential(d rules.Decision, c planner.Candidate) rules.Decision {
	if d.Outcome == rules.Invalid && c.Key.Keyless(c.Endpoint) {
		d.Outcome = rules.RetryElsewhere
		d.Reason += " (no credential was sent, so the key is not invalid)"
	}
	return d
}

// noteProvider records the serving Provider as soon as the first Attempt
// starts, so a Request interrupted mid-Attempt still names it.
func (x *exchange) noteProvider(p *planner.Provider) {
	if !x.begun {
		return
	}
	if err := x.g.rec.NoteProvider(x.ctx, x.rec.ID, p.ID, p.Handle); err != nil {
		x.g.log.Error("recording a Request failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
	}
}

// summarize sets the Request's one-line summary when anything failed or
// more than one Attempt was made. last is the answering Attempt, if any.
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

// describe is one failed Attempt in a line: "#1 key-1: 429 rate_limit_exceeded:
// Slow down -> rate-limited, cooling_key_model".
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

// attemptView is one Attempt in the Caller's error.
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

// failAll answers the Caller when no Attempt succeeded, listing them all.
func (x *exchange) failAll(failed []tried, stop string, maxAttempts int) {
	handle := x.rec.Provider
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
		status := last.failure.Status
		if status < 400 || status > 599 {
			status = http.StatusBadGateway
		}
		e = api.Errorf(status, "upstream_rejected", "Fix the request as the Provider's message says; another key would be refused the same way. "+reqHint,
			"Provider %s refused the request: %s", handle, last.decision.Reason)
	case last.failure.Timeout || stop == stopTime:
		e = api.Errorf(http.StatusGatewayTimeout, "upstream_timeout", "Retry later, or ask the Owner to raise the Provider's first_byte_seconds (at most 95). "+reqHint,
			"Provider %s did not answer within the time budget (%d %s): %s", handle, n, plural, x.rec.Summary)
	default:
		retry := earliestCooling(failed, x.g.clock.Now())
		if retry > 0 {
			x.setHeader("Retry-After", strconv.Itoa(int(retry.Seconds())))
			e = api.Errorf(http.StatusServiceUnavailable, "upstream_unavailable", fmt.Sprintf("Retry after %d seconds (Retry-After), when the first key cools down. %s", int(retry.Seconds()), reqHint),
				"Every Attempt on %s failed (%d %s): %s", handle, n, plural, x.rec.Summary)
		} else {
			e = api.Errorf(http.StatusBadGateway, "upstream_failed", "Retry in a moment; if it keeps failing, read the Attempts. "+reqHint,
				"Every Attempt on %s failed (%d %s): %s", handle, n, plural, x.rec.Summary)
		}
	}
	x.fail(e.WithDetails(details))
}

// allGaps reports whether every failed Attempt recorded a Model Gap.
func allGaps(failed []tried) bool {
	for _, t := range failed {
		if t.decision.Outcome != rules.ModelGap {
			return false
		}
	}
	return len(failed) > 0
}

// earliestCooling is how long until the first key that cooled in this
// Request is usable again; 0 when none cooled.
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
