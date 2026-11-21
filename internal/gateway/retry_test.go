package gateway

import (
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/keystate"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/rules"
)

var policyStart = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

const policyBudget = 60 * time.Second

func candidates(t *testing.T, specs ...string) []planner.Candidate {
	t.Helper()
	provider := &planner.Provider{ID: "p", Handle: "acme"}
	keys, endpoints := map[string]*planner.Key{}, map[string]*planner.Endpoint{}
	var out []planner.Candidate
	for _, spec := range specs {
		var key, endpoint, model string
		if _, err := fmt.Sscanf(strings.NewReplacer("@", " ", ":", " ").Replace(spec), "%s %s %s", &key, &endpoint, &model); err != nil {
			t.Fatalf("candidate %q: want key@endpoint:model", spec)
		}
		if keys[key] == nil {
			keys[key] = &planner.Key{ID: key, Name: key, Secret: "sk"}
		}
		if endpoints[endpoint] == nil {
			endpoints[endpoint] = &planner.Endpoint{ID: endpoint, Name: endpoint}
		}
		out = append(out, planner.Candidate{Provider: provider, Key: keys[key], Endpoint: endpoints[endpoint], WireModel: model})
	}
	return out
}

func label(s step) string {
	l := s.c.Key.ID + "@" + s.c.Endpoint.ID + ":" + s.c.WireModel
	switch s.kind {
	case replay:
		l = "replay " + l
	case retryWithoutCacheAdditions:
		l = "again " + l
	}
	if s.withoutCacheAdditions {
		l += " without cache additions"
	}
	return l
}

func failed(o rules.Outcome, status int) outcome {
	return outcome{decision: rules.Decision{Outcome: o, Status: status}}
}

var (
	serverError    = failed(rules.RetryElsewhere, 503)
	clientError    = failed(rules.RetryElsewhere, 404)
	failRequest    = failed(rules.FailRequest, 400)
	invalidKey     = failed(rules.Invalid, 401)
	coolingKey     = failed(rules.CoolingKey, 402)
	coolingModel   = failed(rules.CoolingKeyModel, 429)
	modelGap       = failed(rules.ModelGap, 404)
	timedOut       = outcome{decision: rules.Decision{Outcome: rules.RetryElsewhere}, timeout: true}
	refusedCaching = outcome{refusedCacheAddition: true}
)

func withEffect(o outcome, e keystate.Effect) outcome {
	o.effect = e
	return o
}

func askingToWait(o outcome, seconds string) outcome {
	o.answerHeader = http.Header{"Retry-After": {seconds}}
	return o
}

type try struct {
	want string
	took time.Duration
	then outcome
}

func TestTheRetryPolicy(t *testing.T) {
	cases := []struct {
		name        string
		cands       []string
		maxAttempts int
		tries       []try
		stop        stopReason
		budgetUsed  int
	}{
		{
			name:  "candidates are tried in plan order until none is left",
			cands: []string{"a@e1:m", "b@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: clientError}, {want: "b@e1:m", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "fail_request ends the Request: no other key would do better",
			cands: []string{"a@e1:m", "b@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: failRequest}},
			stop:  stopRule, budgetUsed: 1,
		},
		{
			name:  "an invalid key is out for the rest of the Request, on every Endpoint and model",
			cands: []string{"a@e1:m", "a@e2:m", "a@e1:n", "b@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: invalidKey}, {want: "b@e1:m", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "a cooling key is out for the rest of the Request",
			cands: []string{"a@e1:m", "a@e2:n", "b@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: coolingKey}, {want: "b@e1:m", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "a key cooling for one model still serves another model, on any Endpoint",
			cands: []string{"a@e1:m", "a@e2:m", "a@e1:n"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: coolingModel}, {want: "a@e1:n", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "a Model Gap keeps the key out for that model only",
			cands: []string{"a@e1:m", "a@e2:m", "a@e2:n"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: modelGap}, {want: "a@e2:n", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "a model cooling that escalated to the whole key keeps the key out",
			cands: []string{"a@e1:m", "a@e1:n", "b@e1:n"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: withEffect(coolingModel, keystate.Effect{Escalated: true})}, {want: "b@e1:n", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "an invalid outcome that became an Endpoint Gap keeps the key out of that Endpoint only",
			cands: []string{"a@e1:m", "a@e1:n", "a@e2:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: withEffect(invalidKey, keystate.Effect{EndpointGap: "e1"})}, {want: "a@e2:m", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "retry_elsewhere keeps the key out of that Endpoint only",
			cands: []string{"a@e1:m", "a@e1:n", "a@e2:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: clientError}, {want: "a@e2:m", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "a 5xx is replayed once on the same key and Endpoint, after every other candidate",
			cands: []string{"a@e1:m", "b@e1:m"}, maxAttempts: 5,
			tries: []try{
				{want: "a@e1:m", then: serverError}, {want: "b@e1:m", then: serverError},
				{want: "replay a@e1:m", then: serverError}, {want: "replay b@e1:m", then: serverError},
			},
			stop: stopCandidates, budgetUsed: 4,
		},
		{
			name:  "replays use the Attempt budget",
			cands: []string{"a@e1:m", "b@e1:m"}, maxAttempts: 3,
			tries: []try{{want: "a@e1:m", then: serverError}, {want: "b@e1:m", then: serverError}, {want: "replay a@e1:m", then: serverError}},
			stop:  stopAttempts, budgetUsed: 3,
		},
		{
			name:  "a timeout is never replayed, and its key and Endpoint are out",
			cands: []string{"a@e1:m", "a@e1:n", "b@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: timedOut}, {want: "b@e1:m", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "a timeout is not replayed whatever status it is read as",
			cands: []string{"a@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: outcome{decision: rules.Decision{Outcome: rules.RetryElsewhere, Status: 504}, timeout: true}}},
			stop:  stopCandidates, budgetUsed: 1,
		},
		{
			name:  "a timeout read as another outcome still keeps its key and Endpoint out",
			cands: []string{"a@e1:m", "a@e1:n", "a@e2:n"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: outcome{decision: rules.Decision{Outcome: rules.ModelGap}, timeout: true}}, {want: "a@e2:n", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "a 4xx is not replayed",
			cands: []string{"a@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", then: clientError}},
			stop:  stopCandidates, budgetUsed: 1,
		},
		{
			name:  "a replay that could only go at the deadline is not made",
			cands: []string{"a@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", took: time.Second, then: askingToWait(serverError, "59")}},
			stop:  stopCandidates, budgetUsed: 1,
		},
		{
			name:  "a replay that can go before the deadline waits for its pause",
			cands: []string{"a@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", took: time.Second, then: askingToWait(serverError, "58")}, {want: "replay a@e1:m", then: clientError}},
			stop:  stopCandidates, budgetUsed: 2,
		},
		{
			name:  "the Attempt budget stops the Request",
			cands: []string{"a@e1:m", "b@e1:m", "c@e1:m"}, maxAttempts: 2,
			tries: []try{{want: "a@e1:m", then: clientError}, {want: "b@e1:m", then: clientError}},
			stop:  stopAttempts, budgetUsed: 2,
		},
		{
			name:  "the first-byte budget stops the Request",
			cands: []string{"a@e1:m", "b@e1:m"}, maxAttempts: 5,
			tries: []try{{want: "a@e1:m", took: policyBudget, then: clientError}},
			stop:  stopTime, budgetUsed: 1,
		},
		{
			name:  "a refused cache addition is asked again at once on the same key and Endpoint, outside the budget",
			cands: []string{"a@e1:m", "b@e1:m", "c@e1:m"}, maxAttempts: 2,
			tries: []try{
				{want: "a@e1:m", then: refusedCaching},
				{want: "again a@e1:m without cache additions", then: clientError},
				{want: "b@e1:m without cache additions", then: clientError},
			},
			stop: stopAttempts, budgetUsed: 2,
		},
		{
			name:  "the Endpoint that refused a cache addition gets none for the rest of the Request; others still do",
			cands: []string{"a@e1:m", "a@e2:m", "b@e1:m"}, maxAttempts: 5,
			tries: []try{
				{want: "a@e1:m", then: refusedCaching},
				{want: "again a@e1:m without cache additions", then: serverError},
				{want: "a@e2:m", then: clientError},
				{want: "b@e1:m without cache additions", then: clientError},
				{want: "replay a@e1:m without cache additions", then: clientError},
			},
			stop: stopCandidates, budgetUsed: 4,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			now := policyStart
			p := newRetryPolicy(candidates(t, tc.cands...), tc.maxAttempts, func(planner.Candidate) time.Time { return policyStart.Add(policyBudget) })
			p.jitter = func() float64 { return 0.5 }
			for i, tr := range tc.tries {
				s, ok := p.Next(now)
				if !ok {
					t.Fatalf("try %d: stopped (%s), want %s", i+1, p.stopped(), tr.want)
				}
				if got := label(s); got != tr.want {
					t.Fatalf("try %d: got %s, want %s", i+1, got, tr.want)
				}
				if s.seq != i+1 {
					t.Fatalf("try %d: seq %d", i+1, s.seq)
				}
				if s.kind == replay && s.notBefore.After(now) {
					now = s.notBefore
				}
				now = now.Add(tr.took)
				o := tr.then
				o.at = now
				p.Record(s, o)
			}
			if s, ok := p.Next(now); ok {
				t.Fatalf("after the last try: got %s, want stop %s", label(s), tc.stop)
			}
			if p.stopped() != tc.stop || p.budgetUsed() != tc.budgetUsed {
				t.Fatalf("stop %s with %d of the budget used, want %s with %d", p.stopped(), p.budgetUsed(), tc.stop, tc.budgetUsed)
			}
		})
	}
}

func TestAReplayWaitsLongerAfterEachReplayOfTheRequest(t *testing.T) {
	p := newRetryPolicy(candidates(t, "a@e1:m", "b@e1:m", "c@e1:m"), 10, func(planner.Candidate) time.Time { return policyStart.Add(policyBudget) })
	p.jitter = func() float64 { return 0.5 }
	for range 3 {
		s, _ := p.Next(policyStart)
		p.Record(s, outcome{decision: serverError.decision, at: policyStart})
	}
	for _, want := range []time.Duration{250 * time.Millisecond, 500 * time.Millisecond, time.Second} {
		s, ok := p.Next(policyStart)
		if !ok || s.kind != replay || s.notBefore.Sub(policyStart) != want {
			t.Fatalf("got %s after %v, want a replay after %v", label(s), s.notBefore.Sub(policyStart), want)
		}
		p.Record(s, clientError)
	}
}

func TestReplayPause(t *testing.T) {
	now := policyStart
	header := func(k, v string) http.Header { return http.Header{k: {v}} }
	cases := []struct {
		name   string
		n      int
		h      http.Header
		jitter float64
		want   time.Duration
	}{
		{"the first replay waits 250 ms", 1, nil, 0.5, 250 * time.Millisecond},
		{"each replay of the Request doubles it", 3, nil, 0.5, time.Second},
		{"up to 8 s", 7, nil, 0.5, 8 * time.Second},
		{"jittered down to half", 1, nil, 0, 125 * time.Millisecond},
		{"jittered up to one and a half", 1, nil, 1, 375 * time.Millisecond},
		{"Retry-After wins when it asks for longer", 1, header("Retry-After", "3"), 0.5, 3 * time.Second},
		{"Retry-After as a date", 1, header("Retry-After", now.Add(5*time.Second).Format(http.TimeFormat)), 0.5, 5 * time.Second},
		{"Retry-After-Ms", 1, header("Retry-After-Ms", "1500"), 0.5, 1500 * time.Millisecond},
		{"Retry-After is capped at 60 s", 1, header("Retry-After", "120"), 0.5, 60 * time.Second},
		{"a shorter Retry-After does not shorten the pause", 6, header("Retry-After", "1"), 0.5, 8 * time.Second},
	}
	for _, tc := range cases {
		if got := replayPause(tc.n, tc.h, now, tc.jitter); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestARefusedCacheAddition(t *testing.T) {
	first := step{c: candidates(t, "a@e1:m")[0]}
	plain := first
	plain.withoutCacheAdditions = true
	translated := cacheAdditions{fields: []string{"cache_control", "metadata"}}
	passthrough := cacheAdditions{fields: []string{"prompt_cache_key"}, passthrough: true}
	body := func(status int, b string) *rules.Failure { return &rules.Failure{Status: status, Body: []byte(b)} }
	naming := `{"error":{"message":"Unrecognized request argument supplied: metadata"}}`
	other := `{"error":{"message":"temperature must be at most 2"}}`
	cases := []struct {
		name  string
		s     step
		added cacheAdditions
		f     *rules.Failure
		d     rules.Outcome
		field string
	}{
		{"a 400 naming a field Iroha added", first, translated, body(400, naming), rules.FailRequest, "metadata"},
		{"a 422 naming a field Iroha added", first, translated, body(422, naming), rules.FailRequest, "metadata"},
		{"a 400 on passthrough that the rules end the Request with, whatever it says", first, passthrough, body(400, other), rules.FailRequest, "prompt_cache_key"},
		{"not a 400 the rules read as the key's, on passthrough", first, passthrough, body(400, other), rules.Invalid, ""},
		{"not an ordinary 400 on a translated Attempt", first, translated, body(400, other), rules.FailRequest, ""},
		{"not when nothing was added", first, cacheAdditions{}, body(400, naming), rules.FailRequest, ""},
		{"not twice on one Endpoint", plain, translated, body(400, naming), rules.FailRequest, ""},
		{"not a 5xx", first, translated, body(500, naming), rules.RetryElsewhere, ""},
	}
	for _, tc := range cases {
		r, ok := refusedCacheAddition(tc.s, tc.added, tc.f, rules.Decision{Outcome: tc.d})
		if ok != (tc.field != "") || r.field != tc.field {
			t.Errorf("%s: got %q (%v), want %q", tc.name, r.field, ok, tc.field)
		}
	}
}
