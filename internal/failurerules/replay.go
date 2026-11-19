package failurerules

import (
	"context"
	"encoding/json"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/hosts"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/store"
)

// How far back a dry run replays, and how many failed Attempts at most.
const (
	ReplayWindow = 7 * 24 * time.Hour
	ReplayLimit  = 1000
	replayShown  = 20
)

// Replay is what a rule change would have decided on recent failed
// Attempts, compared with the rules in force.
type Replay struct {
	Since    time.Time         `json:"since" doc:"Start of the window replayed (7 days back)."`
	Attempts int               `json:"attempts" doc:"Failed Attempts replayed: the most recent ones in the window, at most 1000."`
	Changed  int               `json:"changed" doc:"How many of them the change would decide differently (another rule or another outcome)."`
	Rules    []ReplayRule      `json:"rules" doc:"Per rule, how many of the replayed Attempts it matches now and would match after the change; rules matching none are left out, those whose count changes first."`
	Examples []ReplayedAttempt `json:"examples" doc:"Up to 20 Attempts whose decision would change, newest first."`
}

// ReplayRule counts one rule's matches in a replay.
type ReplayRule struct {
	Rule  string `json:"rule" doc:"Rule name; empty for Attempts no rule matches (5xx and network then retry elsewhere, anything else fails the Request)."`
	Now   int    `json:"now" doc:"Attempts it matches under the rules in force."`
	After int    `json:"after" doc:"Attempts it would match after the change."`
}

// ReplayDecision is a rule and its outcome.
type ReplayDecision struct {
	Rule    string        `json:"rule"`
	Outcome rules.Outcome `json:"outcome"`
}

// ReplayedAttempt is one failed Attempt whose decision would change.
type ReplayedAttempt struct {
	RequestID   string         `json:"request_id" doc:"Read it whole with GET /api/requests/{request}."`
	Seq         int            `json:"seq"`
	StartedAt   time.Time      `json:"started_at"`
	Provider    string         `json:"provider"`
	UpstreamKey string         `json:"upstream_key"`
	Model       string         `json:"model"`
	Status      int            `json:"status" doc:"Upstream status; 0 when no response arrived."`
	Reason      string         `json:"reason" doc:"What the Provider answered, in one line."`
	Now         ReplayDecision `json:"now" doc:"What the rules in force decide."`
	After       ReplayDecision `json:"after" doc:"What the rules would decide after the change."`
}

// replay classifies the recent failed Attempts with both sets.
func replay(ctx context.Context, q queryer, now, after *rules.Set, at time.Time) (*Replay, error) {
	since := at.Add(-ReplayWindow)
	rows, err := q.QueryContext(ctx, `SELECT request_id, seq, started_at, provider_handle, endpoint_url, upstream_key_name, wire_model,
		status, error, reason, failure_headers, failure_body
		FROM attempts WHERE outcome != '' AND started_at >= ? ORDER BY started_at DESC, request_id DESC, seq DESC LIMIT ?`,
		store.Millis(since), ReplayLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := &Replay{Since: since, Rules: []ReplayRule{}, Examples: []ReplayedAttempt{}}
	counts := map[string]*ReplayRule{}
	var order []string
	count := func(name string) *ReplayRule {
		c, ok := counts[name]
		if !ok {
			c = &ReplayRule{Rule: name}
			counts[name] = c
			order = append(order, name)
		}
		return c
	}
	for rows.Next() {
		var a ReplayedAttempt
		var started int64
		var endpointURL, errText, headers, body string
		if err := rows.Scan(&a.RequestID, &a.Seq, &started, &a.Provider, &endpointURL, &a.UpstreamKey, &a.Model,
			&a.Status, &errText, &a.Reason, &headers, &body); err != nil {
			return nil, err
		}
		a.StartedAt = store.FromMillis(started)
		f := rules.Failure{Provider: a.Provider, Host: hosts.Of(endpointURL), Status: a.Status, Err: errText, Body: []byte(body),
			Timeout: a.Status == 0 && strings.HasPrefix(a.Reason, "timeout")}
		if headers != "" {
			var h map[string]string
			if json.Unmarshal([]byte(headers), &h) == nil {
				f.Header = http.Header{}
				for k, v := range h {
					f.Header.Set(k, v)
				}
			}
		}
		dn, da := now.Classify(f, at), after.Classify(f, at)
		a.Now = ReplayDecision{Rule: dn.Rule, Outcome: dn.Outcome}
		a.After = ReplayDecision{Rule: da.Rule, Outcome: da.Outcome}
		out.Attempts++
		count(dn.Rule).Now++
		count(da.Rule).After++
		if a.Now != a.After {
			out.Changed++
			if len(out.Examples) < replayShown {
				out.Examples = append(out.Examples, a)
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for _, name := range order {
		out.Rules = append(out.Rules, *counts[name])
	}
	slices.SortStableFunc(out.Rules, func(a, b ReplayRule) int {
		ca, cb := a.Now != a.After, b.Now != b.After
		switch {
		case ca && !cb:
			return -1
		case cb && !ca:
			return 1
		}
		return (b.After + b.Now) - (a.After + a.Now)
	})
	return out, nil
}
