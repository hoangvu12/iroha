package requests

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/store"
)

// maxCaptured caps each captured body; the rest is dropped and the capture
// marked truncated.
const maxCaptured = 16 << 20

// Capture collects one Request's prompt and response exactly as the Caller
// sent and received them, for Gateway Keys with capture on. Wrap the
// Caller's body with Body and the response writer with Writer before
// anything reads or writes them; then SaveCapture.
type Capture struct {
	mu        sync.Mutex
	reqType   string
	req       limited
	status    int
	respType  string
	resp      limited
	createdAt time.Time
}

type limited struct {
	buf       bytes.Buffer
	truncated bool
}

func (l *limited) write(p []byte) {
	room := maxCaptured - l.buf.Len()
	if len(p) > room {
		p, l.truncated = p[:max(room, 0)], true
	}
	l.buf.Write(p)
}

// NewCapture starts a capture of a Request that started at start.
func NewCapture(start time.Time) *Capture { return &Capture{createdAt: start} }

// Body tees the Caller's request body into the capture.
func (c *Capture) Body(r *http.Request) io.ReadCloser {
	c.reqType = r.Header.Get("Content-Type")
	return &teeBody{c: c, rc: r.Body}
}

type teeBody struct {
	c  *Capture
	rc io.ReadCloser
}

func (t *teeBody) Read(p []byte) (int, error) {
	n, err := t.rc.Read(p)
	if n > 0 {
		t.c.mu.Lock()
		t.c.req.write(p[:n])
		t.c.mu.Unlock()
	}
	return n, err
}

func (t *teeBody) Close() error { return t.rc.Close() }

// Writer tees everything written to the Caller into the capture.
func (c *Capture) Writer(w http.ResponseWriter) http.ResponseWriter { return &teeWriter{c: c, w: w} }

type teeWriter struct {
	c *Capture
	w http.ResponseWriter
}

func (t *teeWriter) Header() http.Header { return t.w.Header() }

func (t *teeWriter) WriteHeader(status int) {
	t.c.mu.Lock()
	if t.c.status == 0 {
		t.c.status, t.c.respType = status, t.w.Header().Get("Content-Type")
	}
	t.c.mu.Unlock()
	t.w.WriteHeader(status)
}

func (t *teeWriter) Write(p []byte) (int, error) {
	t.c.mu.Lock()
	if t.c.status == 0 {
		t.c.status, t.c.respType = http.StatusOK, t.w.Header().Get("Content-Type")
	}
	t.c.resp.write(p)
	t.c.mu.Unlock()
	return t.w.Write(p)
}

func (t *teeWriter) Flush() {
	if f, ok := t.w.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap lets http.ResponseController reach the connection.
func (t *teeWriter) Unwrap() http.ResponseWriter { return t.w }

// SaveCapture stores the capture of Request id, whose Caller spoke sh.
// Streams are stored as sent and reassembled into one answer.
func (rc *Recorder) SaveCapture(ctx context.Context, id string, sh shape.Shape, c *Capture) error {
	ctx = context.WithoutCancel(ctx)
	c.mu.Lock()
	reqBody, respBody := bytes.Clone(c.req.buf.Bytes()), bytes.Clone(c.resp.buf.Bytes())
	reqTrunc, respTrunc, status, respType, reqType := c.req.truncated, c.resp.truncated, c.status, c.respType, c.reqType
	c.mu.Unlock()
	var stream []byte
	if isEventStream(respType) {
		stream, respBody = respBody, reassemble(sh, respBody)
	}
	return rc.db.Tx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO captures (request_id, created_at, request_content_type, request_body, request_truncated,
			response_status, response_content_type, response_body, response_stream, response_truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT (request_id) DO NOTHING`,
			id, store.Millis(c.createdAt), reqType, reqBody, reqTrunc, status, respType, respBody, stream, respTrunc)
		return err
	})
}

// Answer is the response captured so far: its status and body, a stream
// reassembled into one answer of Shape sh (as SaveCapture stores it).
func (c *Capture) Answer(sh shape.Shape) (int, []byte) {
	c.mu.Lock()
	body, status, respType := bytes.Clone(c.resp.buf.Bytes()), c.status, c.respType
	c.mu.Unlock()
	if isEventStream(respType) {
		body = reassemble(sh, body)
	}
	return status, body
}

func isEventStream(contentType string) bool {
	mt, _, err := mime.ParseMediaType(contentType)
	return err == nil && mt == "text/event-stream"
}

// reassemblers turn the event payloads of a stream in one Shape into the
// whole answer that Shape would have given; ok is false when the stream
// does not parse.
var reassemblers = map[shape.Shape]func(payloads [][]byte) (b []byte, ok bool){
	shape.OpenAIChat:        reassembleChat,
	shape.AnthropicMessages: reassembleAnthropic,
	shape.OpenAIResponses:   reassembleResponses, // capture_responses.go
	shape.Gemini:            reassembleGemini,    // capture_gemini.go
}

// reassemble turns a streamed answer into one answer in the Shape's own
// form, otherwise the list of event payloads.
func reassemble(sh shape.Shape, stream []byte) []byte {
	payloads := eventPayloads(stream)
	if f := reassemblers[sh]; f != nil {
		if b, ok := f(payloads); ok {
			return b
		}
	}
	list := make([]json.RawMessage, 0, len(payloads))
	for _, p := range payloads {
		if json.Valid(p) {
			list = append(list, p)
		} else {
			s, _ := json.Marshal(string(p))
			list = append(list, s)
		}
	}
	b, _ := json.Marshal(list)
	return b
}

// eventPayloads returns the data of every server-sent event, multi-line
// data joined with newlines, without the [DONE] terminator.
func eventPayloads(stream []byte) [][]byte {
	var out [][]byte
	var cur []byte
	has := false
	flush := func() {
		if has && string(cur) != "[DONE]" {
			out = append(out, cur)
		}
		cur, has = nil, false
	}
	sc := bufio.NewScanner(bytes.NewReader(stream))
	sc.Buffer(make([]byte, 64<<10), maxCaptured)
	for sc.Scan() {
		line := bytes.TrimRight(sc.Bytes(), "\r")
		if len(line) == 0 {
			flush()
			continue
		}
		if data, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			data = bytes.TrimPrefix(data, []byte(" "))
			if has {
				cur = append(cur, '\n')
			}
			cur, has = append(cur, data...), true
		}
	}
	flush()
	return out
}

// reassembleChat merges chat.completion.chunk payloads into one
// chat.completion: text fields of each choice's delta concatenated, tool
// calls merged by index, the last finish_reason and usage kept.
func reassembleChat(payloads [][]byte) ([]byte, bool) {
	out := map[string]any{}
	type choice struct {
		index   float64
		message map[string]any
		tools   []map[string]any
		rest    map[string]any
	}
	var choices []*choice
	byIndex := map[float64]*choice{}
	for _, p := range payloads {
		var chunk map[string]any
		if json.Unmarshal(p, &chunk) != nil {
			return nil, false
		}
		for k, v := range chunk {
			if k != "choices" && k != "object" && v != nil {
				out[k] = v
			}
		}
		list, _ := chunk["choices"].([]any)
		for _, item := range list {
			cm, ok := item.(map[string]any)
			if !ok {
				continue
			}
			idx, _ := cm["index"].(float64)
			ch := byIndex[idx]
			if ch == nil {
				ch = &choice{index: idx, message: map[string]any{}, rest: map[string]any{}}
				byIndex[idx] = ch
				choices = append(choices, ch)
			}
			for k, v := range cm {
				if k != "delta" && k != "index" && v != nil {
					ch.rest[k] = v
				}
			}
			delta, _ := cm["delta"].(map[string]any)
			for k, v := range delta {
				if k == "tool_calls" {
					calls, _ := v.([]any)
					for _, call := range calls {
						if cm, ok := call.(map[string]any); ok {
							ch.tools = mergeToolCall(ch.tools, cm)
						}
					}
					continue
				}
				mergeField(ch.message, k, v)
			}
		}
	}
	list := make([]any, 0, len(choices))
	for _, ch := range choices {
		if ch.message["role"] == nil {
			ch.message["role"] = "assistant"
		}
		if len(ch.tools) > 0 {
			calls := make([]any, len(ch.tools))
			for i, t := range ch.tools {
				calls[i] = t
			}
			ch.message["tool_calls"] = calls
		}
		c := map[string]any{"index": ch.index, "message": ch.message}
		for k, v := range ch.rest {
			c[k] = v
		}
		list = append(list, c)
	}
	out["object"] = "chat.completion"
	out["choices"] = list
	b, err := json.Marshal(out)
	return b, err == nil
}

// reassembleAnthropic merges Anthropic Messages events into one message:
// message_start's message, each content block with its deltas applied
// (text, thinking and signature continued, tool input parsed from its JSON
// fragments), message_delta's stop reason and usage.
func reassembleAnthropic(payloads [][]byte) ([]byte, bool) {
	var msg map[string]any
	var blocks []map[string]any
	partial := map[int]string{} // tool input JSON per block
	for _, p := range payloads {
		var ev struct {
			Type         string          `json:"type"`
			Index        int             `json:"index"`
			Message      map[string]any  `json:"message"`
			ContentBlock map[string]any  `json:"content_block"`
			Delta        map[string]any  `json:"delta"`
			Usage        map[string]any  `json:"usage"`
			Error        json.RawMessage `json:"error"`
		}
		if json.Unmarshal(p, &ev) != nil {
			return nil, false
		}
		switch ev.Type {
		case "message_start":
			msg = ev.Message
		case "content_block_start":
			for len(blocks) <= ev.Index {
				blocks = append(blocks, nil)
			}
			blocks[ev.Index] = ev.ContentBlock
		case "content_block_delta":
			if ev.Index >= len(blocks) || blocks[ev.Index] == nil {
				return nil, false
			}
			b := blocks[ev.Index]
			switch ev.Delta["type"] {
			case "text_delta":
				b["text"] = str(b["text"]) + str(ev.Delta["text"])
			case "thinking_delta":
				b["thinking"] = str(b["thinking"]) + str(ev.Delta["thinking"])
			case "signature_delta":
				b["signature"] = str(b["signature"]) + str(ev.Delta["signature"])
			case "input_json_delta":
				partial[ev.Index] += str(ev.Delta["partial_json"])
			}
		case "message_delta":
			if msg == nil {
				return nil, false
			}
			for k, v := range ev.Delta {
				msg[k] = v
			}
			if u, ok := msg["usage"].(map[string]any); ok {
				for k, v := range ev.Usage {
					if v != nil {
						u[k] = v
					}
				}
			} else if ev.Usage != nil {
				msg["usage"] = ev.Usage
			}
		case "error":
			if msg == nil {
				msg = map[string]any{}
			}
			msg["error"] = ev.Error
		}
	}
	if msg == nil {
		return nil, false
	}
	content := make([]any, 0, len(blocks))
	for i, b := range blocks {
		if b == nil {
			continue
		}
		if js, ok := partial[i]; ok {
			var input any
			if js == "" {
				input = map[string]any{}
			} else if json.Unmarshal([]byte(js), &input) != nil {
				input = js // cut off mid-JSON: keep what came
			}
			b["input"] = input
		}
		content = append(content, b)
	}
	msg["content"] = content
	b, err := json.Marshal(msg)
	return b, err == nil
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// firstWins are identifying fields that repeat across chunks rather than continue.
var firstWins = map[string]bool{"role": true, "id": true, "type": true, "name": true}

// mergeField folds one delta field into m: text continues, identifiers keep
// their first value, anything else takes the latest value.
func mergeField(m map[string]any, k string, v any) {
	if v == nil {
		return
	}
	prev, had := m[k]
	switch {
	case !had || prev == nil:
		m[k] = v
	case firstWins[k]:
	default:
		ps, ok1 := prev.(string)
		vs, ok2 := v.(string)
		if ok1 && ok2 {
			m[k] = ps + vs
			return
		}
		pm, ok1 := prev.(map[string]any)
		vm, ok2 := v.(map[string]any)
		if ok1 && ok2 {
			for kk, vv := range vm {
				mergeField(pm, kk, vv)
			}
			return
		}
		m[k] = v
	}
}

func mergeToolCall(calls []map[string]any, delta map[string]any) []map[string]any {
	idx, _ := delta["index"].(float64)
	for _, c := range calls {
		if c["index"] == idx {
			for k, v := range delta {
				if k != "index" {
					mergeField(c, k, v)
				}
			}
			return calls
		}
	}
	c := map[string]any{}
	for k, v := range delta {
		c[k] = v
	}
	c["index"] = idx
	return append(calls, c)
}

// CapturedBody is a captured request or response body. Body is the JSON
// itself when the body was JSON, else a JSON string of the text.
type CapturedBody struct {
	ContentType string          `json:"content_type,omitempty"`
	Body        json.RawMessage `json:"body" doc:"The body: the JSON value itself when it was JSON (whitespace not kept), otherwise a string."`
	Truncated   bool            `json:"truncated,omitempty" doc:"true when the body passed 16 MiB and only its start was kept."`
}

// CapturedResponse is what the Caller received.
type CapturedResponse struct {
	Status int `json:"status"`
	CapturedBody
	Stream string `json:"stream,omitempty" doc:"For streamed answers: the server-sent events exactly as sent. body then holds them reassembled into one answer."`
}

// CaptureView is the response of GET /api/requests/{request}/capture.
type CaptureView struct {
	RequestID  string           `json:"request_id"`
	CapturedAt time.Time        `json:"captured_at"`
	Request    CapturedBody     `json:"request" doc:"The body the Caller sent."`
	Response   CapturedResponse `json:"response" doc:"The answer the Caller received (after Iroha's changes, such as the echoed model)."`
}

func bodyJSON(b []byte) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("null")
	}
	if json.Valid(b) {
		return b
	}
	s, _ := json.Marshal(string(b))
	return s
}

func readCapture(ctx context.Context, db *store.DB, id string) (CaptureView, error) {
	var v CaptureView
	var created int64
	var reqBody, respBody, stream []byte
	err := db.QueryRowContext(ctx, `SELECT request_id, created_at, request_content_type, request_body, request_truncated,
		response_status, response_content_type, response_body, response_stream, response_truncated FROM captures WHERE request_id = ?`, id).
		Scan(&v.RequestID, &created, &v.Request.ContentType, &reqBody, &v.Request.Truncated,
			&v.Response.Status, &v.Response.ContentType, &respBody, &stream, &v.Response.Truncated)
	if errors.Is(err, sql.ErrNoRows) {
		var exists bool
		if err := db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM requests WHERE id = ?)`, id).Scan(&exists); err != nil {
			return v, err
		}
		if !exists {
			return v, requestNotFound(id)
		}
		return v, api.Errorf(http.StatusNotFound, "capture_not_found",
			`Turn capture on for the Gateway Key (PATCH /api/gateway-keys/{key} with {"capture": true}); later Requests are captured. Captures are kept for retention.captures_days (GET /api/settings).`,
			"Request %s has no capture: its Gateway Key had capture off, or the capture expired.", id)
	}
	if err != nil {
		return v, err
	}
	v.CapturedAt = store.FromMillis(created)
	v.Request.Body, v.Response.Body = bodyJSON(reqBody), bodyJSON(respBody)
	v.Response.Stream = string(stream)
	return v, nil
}

func requestNotFound(id string) *api.Error {
	return api.NotFound("List Requests with GET /api/requests; the ID is the x-request-id header the Caller received.", "No Request has the ID %q.", id)
}
