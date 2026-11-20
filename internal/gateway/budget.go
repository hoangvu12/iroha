package gateway

import (
	"fmt"
	"math/rand/v2"
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

// The Request budget: at most MaxAttempts Attempts, and the first upstream
// byte within FirstByte of the Request's arrival (per Provider, overridable),
// never later than providers.FirstByteCeiling.
//
// Candidates are tried in plan order. A failed Attempt is classified by the
// Failure Rules; its outcome changes the key's Key State and says whether
// to move on. A key that was refused (invalid, cooling) is not tried again
// in this Request; a refusal of one key and model (model cooling, Model Gap)
// keeps that key out for that wire model only, so it still serves the
// Request on an Endpoint or Pool member sending another model; an invalid
// outcome that became an Endpoint Gap (ticket 40) keeps the key out of that
// Endpoint only, as retry_elsewhere would; a 5xx may be replayed once on the same key
// and Endpoint after every other candidate, once a pause has passed
// (replayPause), but a timeout never is.

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
	// notBefore is when a replay may go: its failure plus replayPause.
	notBefore time.Time
}

// The pause before a replay (FAIL-83, TIME-09): 250 ms doubling with each
// replay of the Request, at most 8 s, jittered x0.5-1.5. A Retry-After on
// the failed answer wins when it asks for longer, up to 60 s.
const (
	replayBase          = 250 * time.Millisecond
	replayMax           = 8 * time.Second
	replayRetryAfterMax = 60 * time.Second
)

// replayPause is the pause before the n-th replay (from 1) of a Request
// after an answer with header h.
func replayPause(n int, h http.Header, now time.Time) time.Duration {
	d := replayBase << min(n-1, 5)
	d = min(d, replayMax)
	d = time.Duration(float64(d) * (0.5 + rand.Float64()))
	if ra := askedWait(h, now); ra > d {
		d = min(ra, replayRetryAfterMax)
	}
	return d
}

// askedWait is how long the answer asks to wait (Retry-After-Ms, else
// Retry-After in seconds or as a date); 0 when it does not say.
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

// pauseUntil waits on the clock until t, or until the Caller leaves (false).
func (x *exchange) pauseUntil(t time.Time) bool {
	d := t.Sub(x.g.clock.Now())
	if d <= 0 {
		return true
	}
	return clock.Sleep(x.ctx, x.g.clock, d) == nil
}

// serve runs the budget loop over the plan's candidates and answers the
// Caller, whatever its Shape.
func (x *exchange) serve(cands []planner.Candidate, body []byte, cr callerRequest) {
	g := x.g
	maxAttempts, _ := x.budget(cands[0].Provider)
	ceiling := x.start.Add(providers.FirstByteCeiling)
	set := g.rules()

	queue := make([]queued, 0, len(cands))
	for _, c := range cands {
		queue = append(queue, queued{c: c})
	}
	keyOut := map[string]bool{}   // key IDs refused for this Request
	modelOut := map[string]bool{} // key ID + wire model refused for this Request
	pairOut := map[string]bool{}  // key ID + Endpoint ID that failed
	replayed := map[string]bool{}
	var failed []tried
	stop := stopCandidates
	seq := 0
	for i := 0; i < len(queue); i++ {
		q := queue[i]
		c := q.c
		pair := c.Key.ID + "\x00" + c.Endpoint.ID
		keyModel := c.Key.ID + "\x00" + c.WireModel
		if keyOut[c.Key.ID] || modelOut[keyModel] || (pairOut[pair] && !q.replay) {
			continue
		}
		if seq >= maxAttempts {
			stop = stopAttempts
			break
		}
		_, fb := x.budget(c.Provider)
		deadline := x.start.Add(fb)
		if deadline.After(ceiling) {
			deadline = ceiling
		}
		if !g.clock.Now().Before(deadline) {
			stop = stopTime
			break
		}
		if q.replay {
			// A replay that could only go at the deadline is not made.
			if !q.notBefore.Before(deadline) {
				continue
			}
			if !x.pauseUntil(q.notBefore) {
				x.stopped()
				x.summarize(failed, nil, "")
				return
			}
		}
		seq++
		if seq == 1 {
			x.noteProvider(c.Provider)
		}
		a, f := x.attempt(seq, c, body, cr, deadline)
		if f == nil { // answered
			x.notePreferred(cands[0], &c)
			x.recordAttempt(a)
			if a.Status >= 200 && a.Status < 300 {
				x.worked(c)
			}
			x.summarize(failed, &a, "")
			return
		}
		if field := refusedAddition(f, x.added); field != "" { // caching.go
			t := x.retryPlain(c, a, f, field)
			x.recordAttempt(t.attempt)
			failed = append(failed, t)
			queue = append(queue[:i+1], append([]queued{{c: c}}, queue[i+1:]...)...)
			continue
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
			if t.decision.Status >= 500 && !replayed[pair] {
				replayed[pair] = true
				now := g.clock.Now()
				queue = append(queue, queued{c: c, replay: true, notBefore: now.Add(replayPause(len(replayed), t.failure.Header, now))})
			}
		case rules.Invalid:
			if t.effect.EndpointGap != "" { // this key is out for this Endpoint
				pairOut[pair] = true
			} else {
				keyOut[c.Key.ID] = true
			}
		case rules.CoolingKeyModel, rules.ModelGap: // this key is out for this wire model
			modelOut[keyModel] = true
			if t.effect.Escalated { // the model cooling became the whole key's
				keyOut[c.Key.ID] = true
			}
		default: // invalid, cooling: this key is out for this Request
			keyOut[c.Key.ID] = true
		}
		if stop == stopRule {
			break
		}
		if t.failure.Timeout {
			pairOut[pair] = true // never replay an Attempt that used up its time
		}
	}
	x.notePreferred(cands[0], nil)
	x.failAll(failed, stop, maxAttempts)
}

// budget is the Request budget while p serves: the Attempts allowed and the
// wait for a first byte, counted from the Request's arrival. A Pool's own
// override wins over p's; either is capped at the 95 s ceiling. The Attempt
// count is fixed by the first candidate, so it is shared by every member.
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

// classify runs the Failure Rules on a failed Attempt, applies the outcome
// to the key's Key State and fills in the Attempt's rule, outcome and action.
func (x *exchange) classify(set *rules.Set, c planner.Candidate, a requests.Attempt, f *rules.Failure) tried {
	g := x.g
	d := noCredential(set.Classify(*f, g.clock.Now()), c)
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

// worked records what a 2xx Attempt with candidate c proves: a cooling it
// ends, and that the key works on c's Endpoint (written at most once a
// minute per key and Endpoint, and at once when it clears an Endpoint Gap).
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
	if err := x.g.rec.NoteProvider(x.ctx, x.rec.ID, p.ID, p.Handle, x.rec.Pool); err != nil {
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
	handle := x.rec.Provider                  // the last Attempt's Provider
	subject, on := "Provider "+handle, handle // what "every Attempt" was made on
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
		status := last.decision.Status // an error sent inside a 200 answer: the status it stands for
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
			x.setHeader("Retry-After", strconv.Itoa(int(retry.Seconds())))
			e = api.Errorf(http.StatusServiceUnavailable, "upstream_unavailable", fmt.Sprintf("Retry after %d seconds (Retry-After), when the first key cools down. %s", int(retry.Seconds()), reqHint),
				"Every Attempt on %s failed (%d %s): %s", on, n, plural, x.rec.Summary)
		} else {
			e = api.Errorf(http.StatusBadGateway, "upstream_failed", "Retry in a moment; if it keeps failing, read the Attempts. "+reqHint,
				"Every Attempt on %s failed (%d %s): %s", on, n, plural, x.rec.Summary)
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
