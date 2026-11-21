package requests

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
	"github.com/hoangvu12/iroha/internal/usage"
)

const (
	StateInProgress  = "in_progress"
	StateCompleted   = "completed"
	StateInterrupted = "interrupted"
)

const (
	CallerGatewayKey = "gateway_key"
	CallerTest       = "test"
)

type Request struct {
	ID         string     `json:"id" doc:"Also returned to the Caller in the x-request-id header."`
	StartedAt  time.Time  `json:"started_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	State      string     `json:"state" enum:"in_progress,completed,interrupted" doc:"interrupted: Iroha stopped (crash or forced restart) before the Request finished; status, timings and usage may be missing."`
	Status     int        `json:"status" doc:"HTTP status the Caller received; 0 while in progress."`
	Error      *Failure   `json:"error,omitempty" doc:"Why the Request failed, when Iroha refused or failed it."`
	Summary    string     `json:"summary,omitempty" doc:"One line saying what happened at each Attempt, for Requests with a failed Attempt or more than one Attempt."`

	Caller Caller `json:"caller"`

	Route    string      `json:"route" doc:"The path the Caller used, e.g. /providers/acme/v1/chat/completions."`
	ShapeIn  shape.Shape `json:"shape_in" doc:"The Shape the Caller spoke."`
	ShapeOut shape.Shape `json:"shape_out,omitempty" doc:"The Shape of the serving Endpoint."`
	Model    string      `json:"model" doc:"The model as the Caller named it."`
	Pool     string      `json:"pool,omitempty" doc:"The Model Pool the Caller asked for, when the model named one."`
	Stream   bool        `json:"stream"`

	ProviderID    string `json:"provider_id,omitempty"`
	Provider      string `json:"provider,omitempty" doc:"Handle of the Provider of the last Attempt."`
	EndpointID    string `json:"endpoint_id,omitempty"`
	Endpoint      string `json:"endpoint,omitempty" doc:"Name of the Endpoint of the last Attempt."`
	UpstreamKeyID string `json:"upstream_key_id,omitempty"`
	UpstreamKey   string `json:"upstream_key,omitempty" doc:"Name of the Upstream Key of the last Attempt."`
	WireModel     string `json:"wire_model,omitempty" doc:"The model name sent upstream."`

	FirstByteMs  *int64       `json:"first_byte_ms,omitempty" doc:"Time from arrival to the first token: for streams, the first upstream event carrying text, reasoning or a tool call (not comments, pings or a role-only chunk; the first event when none does); for whole answers, when the body began arriving."`
	DurationMs   *int64       `json:"duration_ms,omitempty" doc:"Time from arrival to the end of the answer."`
	Usage        *usage.Usage `json:"usage,omitempty" doc:"Token usage, streamed answers included; absent when the Provider reported none."`
	AttemptCount int          `json:"attempt_count"`
	Captured     bool         `json:"captured" doc:"true when the prompt and response are stored: GET /api/requests/{request}/capture."`
	Attempts     []Attempt    `json:"attempts,omitempty" doc:"Every Attempt in order (on GET /api/requests/{request} only)."`
	Affinity     *Affinity    `json:"affinity,omitempty" doc:"How the Request's conversation chose its Upstream Key (conversation affinity); absent on Requests refused before planning and on Requests from before it existed."`

	rev int64
}

type Affinity struct {
	Source          string `json:"source" enum:"header,claude_code,codex,session_id,opencode,prompt_cache_key,prefix,none" doc:"Where the conversation was found: the Iroha-Session header, Claude Code's session (x-claude-code-session-id or metadata.user_id), codex: the session_id, session-id or thread-id header (sent by Codex and others, such as pi), x-session-id or a body session_id, opencode: the x-session-affinity header (sent by OpenCode and others, such as pi), the body's prompt_cache_key, a hash of the prompt's start (system prompt, tool names, first user message), or none (an empty prompt)."`
	Mode            string `json:"mode" enum:"on,off,control,none" doc:"on: the Provider's keys were ranked for the conversation; off: the Provider that served (or, when none did, the last Attempt's) has affinity off (round-robin); control: the conversation fell in the round-robin half of the affinity.experiment; none: no conversation (round-robin)."`
	PreferredServed *bool  `json:"preferred_served,omitempty" doc:"With mode on: true when the key the conversation ranks first gave the Caller a successful (2xx) answer; false when another key did (the first was cooling or failed), the answer was not a success, or none came."`
}

const (
	AffinityOn      = "on"
	AffinityOff     = "off"
	AffinityControl = "control"
	AffinityNone    = "none"
)

var AffinityModes = []string{AffinityOn, AffinityOff, AffinityControl, AffinityNone}

func affinityArgs(a *Affinity) (source, mode string, preferred any) {
	if a == nil {
		return "", "", nil
	}
	if a.PreferredServed != nil {
		preferred = *a.PreferredServed
	}
	return a.Source, a.Mode, preferred
}

func affinityOf(source, mode string, preferred sql.NullBool) *Affinity {
	if mode == "" {
		return nil
	}
	a := &Affinity{Source: source, Mode: mode}
	if preferred.Valid {
		v := preferred.Bool
		a.PreferredServed = &v
	}
	return a
}

type Failure struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Caller struct {
	Kind         string `json:"kind" enum:"gateway_key,test"`
	GatewayKeyID string `json:"gateway_key_id,omitempty"`
	Name         string `json:"name" doc:"Gateway Key name at the time of the Request; for test Requests \"Test\" or \"Test (as <Gateway Key name>)\"."`
}

type Attempt struct {
	Seq           int          `json:"seq" doc:"1 for the first Attempt of the Request, then 2, 3..."`
	StartedAt     time.Time    `json:"started_at"`
	ProviderID    string       `json:"provider_id"`
	Provider      string       `json:"provider" doc:"Provider handle."`
	EndpointID    string       `json:"endpoint_id"`
	Endpoint      string       `json:"endpoint" doc:"Endpoint name."`
	EndpointURL   string       `json:"endpoint_url"`
	UpstreamKeyID string       `json:"upstream_key_id"`
	UpstreamKey   string       `json:"upstream_key" doc:"Upstream Key name."`
	WireModel     string       `json:"wire_model"`
	ReportedModel string       `json:"reported_model,omitempty" doc:"The model the Provider's answer said served it (a dated snapshot, the model a router chose); absent when the answer named none. The Caller was answered with the model it asked for."`
	Shape         shape.Shape  `json:"shape" doc:"The Shape sent upstream."`
	Status        int          `json:"status" doc:"Upstream HTTP status; 0 when no response arrived."`
	Error         string       `json:"error,omitempty" doc:"What went wrong when there was no usable response."`
	FirstByteMs   *int64       `json:"first_byte_ms,omitempty"`
	DurationMs    *int64       `json:"duration_ms,omitempty"`
	Usage         *usage.Usage `json:"usage,omitempty"`

	Rule           string            `json:"rule,omitempty" doc:"The Failure Rule the failure matched; absent when none did."`
	Outcome        string            `json:"outcome,omitempty" enum:"invalid,cooling_key,cooling_key_model,model_gap,retry_elsewhere,fail_request" doc:"What the failure meant."`
	Reason         string            `json:"reason,omitempty" doc:"What the Provider answered, in one line."`
	Action         string            `json:"action,omitempty" doc:"What Iroha did about it (Key State change, next candidate)."`
	FailureHeaders map[string]string `json:"failure_headers,omitempty" doc:"The upstream response headers of a failed Attempt."`
	FailureBody    string            `json:"failure_body,omitempty" doc:"The upstream response body of a failed Attempt (at most 64 KiB)."`
}

const MaxFailureBody = 64 << 10

type Recorder struct {
	db *store.DB
}

func OpenRecorder(ctx context.Context, db *store.DB, log *slog.Logger) (*Recorder, error) {
	if err := closeInterrupted(ctx, db, log); err != nil {
		return nil, fmt.Errorf("closing interrupted Requests: %w", err)
	}
	return &Recorder{db: db}, nil
}

func (rc *Recorder) Begin(ctx context.Context, r *Request) error {
	ctx = context.WithoutCancel(ctx)
	r.State = StateInProgress
	return rc.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO requests (id, started_at, state, caller_kind, gateway_key_id, caller_name, route, shape_in, model, stream)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			r.ID, store.Millis(r.StartedAt), r.State, r.Caller.Kind, r.Caller.GatewayKeyID, r.Caller.Name, r.Route, string(r.ShapeIn), r.Model, r.Stream)
		return err
	})
}

func (rc *Recorder) Attempt(ctx context.Context, id string, a Attempt) error {
	ctx = context.WithoutCancel(ctx)
	in, out, cache, write, writeLong, reasoning := usageArgs(a.Usage)
	headers := ""
	if len(a.FailureHeaders) > 0 {
		b, _ := json.Marshal(a.FailureHeaders)
		headers = string(b)
	}
	body := a.FailureBody
	if len(body) > MaxFailureBody {
		body = body[:MaxFailureBody]
	}
	return rc.db.Tx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO attempts (request_id, seq, started_at, provider_id, provider_handle, endpoint_id, endpoint_name, endpoint_url,
			upstream_key_id, upstream_key_name, wire_model, shape, status, error, first_byte_ms, duration_ms, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens,
			rule, outcome, reason, action, failure_headers, failure_body, reported_model, cache_write_tokens, cache_write_long_tokens)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, a.Seq, store.Millis(a.StartedAt), a.ProviderID, a.Provider, a.EndpointID, a.Endpoint, a.EndpointURL,
			a.UpstreamKeyID, a.UpstreamKey, a.WireModel, string(a.Shape), a.Status, a.Error, a.FirstByteMs, a.DurationMs, in, out, cache, reasoning,
			a.Rule, a.Outcome, a.Reason, a.Action, headers, body, a.ReportedModel, write, writeLong); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `UPDATE requests SET attempt_count = attempt_count + 1 WHERE id = ?`, id)
		return err
	})
}

func (rc *Recorder) NoteProvider(ctx context.Context, id, providerID, handle, pool string) error {
	ctx = context.WithoutCancel(ctx)
	return rc.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE requests SET provider_id = ?, provider_handle = ?, pool = ? WHERE id = ?`, providerID, handle, pool, id)
		return err
	})
}

func (rc *Recorder) LastServedModel(ctx context.Context, providerID string) (string, error) {
	var m string
	err := rc.db.QueryRowContext(ctx, `SELECT model FROM requests WHERE provider_id = ? AND status >= 200 AND status < 300 AND model != ''
		ORDER BY started_at DESC, rowid DESC LIMIT 1`, providerID).Scan(&m)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return m, err
}

func (rc *Recorder) Finish(ctx context.Context, r *Request) error {
	ctx = context.WithoutCancel(ctx)
	r.State = StateCompleted
	var code, msg string
	if r.Error != nil {
		code, msg = r.Error.Code, r.Error.Message
	}
	var finished any
	if r.FinishedAt != nil {
		finished = store.Millis(*r.FinishedAt)
	}
	in, out, cache, write, writeLong, reasoning := usageArgs(r.Usage)
	affSource, affMode, affPreferred := affinityArgs(r.Affinity)
	return rc.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `UPDATE requests SET finished_at = ?, state = ?, status = ?, error_code = ?, error_message = ?,
			model = ?, stream = ?, shape_out = ?, provider_id = ?, provider_handle = ?, endpoint_id = ?, endpoint_name = ?,
			upstream_key_id = ?, upstream_key_name = ?, wire_model = ?, first_byte_ms = ?, duration_ms = ?,
			input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cache_write_long_tokens = ?, reasoning_tokens = ?,
			summary = ?, pool = ?, affinity_source = ?, affinity = ?, affinity_preferred = ? WHERE id = ?`,
			finished, r.State, r.Status, code, msg, r.Model, r.Stream, string(r.ShapeOut), r.ProviderID, r.Provider, r.EndpointID, r.Endpoint,
			r.UpstreamKeyID, r.UpstreamKey, r.WireModel, r.FirstByteMs, r.DurationMs, in, out, cache, write, writeLong, reasoning, r.Summary, r.Pool,
			affSource, affMode, affPreferred, r.ID)
		return err
	})
}

func usageArgs(u *usage.Usage) (in, out, cache, write, writeLong, reasoning any) {
	if u == nil {
		return nil, nil, nil, nil, nil, nil
	}
	return u.Input, u.Output, u.CacheRead, u.CacheWrite, u.CacheWriteLong, u.Reasoning
}

const usageColumns = `input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_long_tokens, reasoning_tokens`

type usageCounts struct{ in, out, cache, write, writeLong, reasoning sql.NullInt64 }

func (c *usageCounts) dest() []any {
	return []any{&c.in, &c.out, &c.cache, &c.write, &c.writeLong, &c.reasoning}
}

func (c usageCounts) usage() *usage.Usage {
	if !c.in.Valid && !c.out.Valid {
		return nil
	}
	return &usage.Usage{Input: c.in.Int64, Output: c.out.Int64, CacheRead: c.cache.Int64, CacheWrite: c.write.Int64,
		CacheWriteLong: c.writeLong.Int64, Reasoning: c.reasoning.Int64}
}

func msPtr(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	n := v.Int64
	return &n
}
