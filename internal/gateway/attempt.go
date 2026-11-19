package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/usage"
)

// Operation paths appended to an Endpoint's base URL.
const opChat = "/chat/completions"

// maxUpstreamBody caps a buffered upstream answer.
const maxUpstreamBody = 256 << 20

// blockedHeaders are Caller headers never forwarded: credentials (a Gateway
// Key must never reach a Provider), hop-by-hop and transport headers, and
// headers that identify the Caller's network.
var blockedHeaders = map[string]bool{
	"authorization": true, "proxy-authorization": true, "x-api-key": true, "api-key": true, "x-goog-api-key": true,
	"cookie": true, "set-cookie": true,
	"connection": true, "keep-alive": true, "proxy-authenticate": true, "te": true, "trailer": true, "transfer-encoding": true,
	"upgrade": true, "expect": true, "host": true, "content-length": true, "accept-encoding": true,
	"origin": true, "referer": true, "via": true, "forwarded": true, "x-real-ip": true, "true-client-ip": true,
	"x-request-id": true, "x-correlation-id": true, "traceparent": true, "tracestate": true,
}

var blockedPrefixes = []string{"x-forwarded-", "iroha-", "cf-"}

func forwardable(name string) bool {
	n := strings.ToLower(name)
	if blockedHeaders[n] {
		return false
	}
	for _, p := range blockedPrefixes {
		if strings.HasPrefix(n, p) {
			return false
		}
	}
	return true
}

// outbound builds the upstream request of one Attempt: the Endpoint's URL
// plus op, the Caller's forwardable headers, the Endpoint's static headers,
// then the Upstream Key per the Endpoint's auth style.
func outbound(ctx context.Context, c planner.Candidate, in http.Header, body []byte, op string, stream bool) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.Endpoint.URL, "/")+op, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("the Endpoint URL does not make a request: %w", err)
	}
	for k, vs := range in {
		if forwardable(k) {
			req.Header[k] = append([]string(nil), vs...)
		}
	}
	if req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if req.Header.Get("Accept") == "" {
		if stream {
			req.Header.Set("Accept", "text/event-stream")
		} else {
			req.Header.Set("Accept", "application/json")
		}
	}
	for k, v := range c.Endpoint.StaticHeaders {
		req.Header.Set(k, v)
	}
	switch c.Endpoint.AuthStyle {
	case "", "bearer":
		if c.Key.Secret != "" {
			req.Header.Set("Authorization", "Bearer "+c.Key.Secret)
		}
	default: // the other styles arrive with ticket 09
		return nil, fmt.Errorf("Endpoint %s uses auth style %q, which this version of Iroha cannot apply", c.Endpoint.Name, c.Endpoint.AuthStyle)
	}
	return req, nil
}

// prepareChatBody returns the body to send upstream: the Caller's bytes,
// with the wire model when an Endpoint renames it, and on streams with
// stream_options.include_usage so usage can be recorded. injected reports
// that Iroha asked for usage the Caller did not.
func prepareChatBody(body []byte, cr chatRequest, wireModel string) (out []byte, injected bool) {
	out = body
	if wireModel != cr.bodyModel {
		out, _ = setField(out, "model", jsonString(wireModel))
	}
	if cr.stream && !cr.includeUsage {
		opts := map[string]any{}
		if raw, ok := field(out, "stream_options"); ok {
			if json.Unmarshal(raw, &opts) != nil || opts == nil {
				opts = map[string]any{}
			}
		}
		opts["include_usage"] = true
		b, _ := json.Marshal(opts)
		out, _ = setField(out, "stream_options", b)
		injected = true
	}
	return out, injected
}

// attemptChat makes one Attempt of a Chat Completions Request and relays
// the answer to the Caller.
func (x *exchange) attemptChat(seq int, c planner.Candidate, body []byte, cr chatRequest) {
	g := x.g
	started := g.clock.Now()
	a := requests.Attempt{Seq: seq, StartedAt: started.UTC(), ProviderID: c.Provider.ID, Provider: c.Provider.Handle,
		EndpointID: c.Endpoint.ID, Endpoint: c.Endpoint.Name, EndpointURL: c.Endpoint.URL,
		UpstreamKeyID: c.Key.ID, UpstreamKey: c.Key.Name, WireModel: c.WireModel, Shape: c.Endpoint.Shape}
	x.rec.ProviderID, x.rec.Provider = c.Provider.ID, c.Provider.Handle
	x.rec.EndpointID, x.rec.Endpoint = c.Endpoint.ID, c.Endpoint.Name
	x.rec.UpstreamKeyID, x.rec.UpstreamKey = c.Key.ID, c.Key.Name
	x.rec.WireModel, x.rec.ShapeOut = c.WireModel, c.Endpoint.Shape
	defer func() {
		a.DurationMs = ms(g.clock.Now().Sub(started))
		x.recordAttempt(a)
	}()
	handle := c.Provider.Handle

	out, injected := prepareChatBody(body, cr, c.WireModel)
	req, err := outbound(x.ctx, c, x.r.Header, out, opChat, cr.stream)
	if err != nil {
		a.Error = err.Error()
		x.fail(api.Errorf(http.StatusBadGateway, "endpoint_misconfigured",
			"Ask the Owner to fix the Endpoint (GET /api/providers/"+handle+"/endpoints).", "%s", a.Error))
		return
	}
	resp, err := g.http.Do(req)
	if err != nil {
		a.Error = transportError(err)
		if x.ctx.Err() != nil {
			x.callerGone()
			return
		}
		x.fail(api.Errorf(http.StatusBadGateway, "upstream_unreachable",
			"Retry in a moment; if it keeps failing, check the Endpoint URL with GET /api/providers/"+handle+"/endpoints.",
			"Provider %s could not be reached: %s", handle, a.Error))
		return
	}
	defer resp.Body.Close()
	a.Status = resp.StatusCode
	if err := g.providers.MarkKeyUsed(context.WithoutCancel(x.ctx), c.Key.ID); err != nil {
		g.log.Warn("marking an Upstream Key used failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		a.Error = fmt.Sprintf("redirected (%d)", resp.StatusCode)
		x.fail(api.Errorf(http.StatusBadGateway, "upstream_redirect",
			"Ask the Owner to set the Endpoint URL to where the Provider redirects; Iroha never follows redirects.",
			"Provider %s answered %d, a redirect.", handle, resp.StatusCode))
		return
	}

	t := &chatRelay{model: cr.model, dropUsageChunk: injected}
	var res relayResult
	if cr.stream && resp.StatusCode < 300 && isEventStream(resp.Header) {
		res = x.relayStream(resp, t.data)
	} else {
		res = x.relayBuffered(resp, t.body)
	}
	a.Error = res.err
	a.Usage, x.rec.Usage = t.usage, t.usage
	if !res.firstByte.IsZero() {
		a.FirstByteMs = ms(res.firstByte.Sub(started))
		x.rec.FirstByteMs = ms(res.firstByte.Sub(x.start))
	}
	if resp.StatusCode >= 400 && x.rec.Error == nil {
		x.rec.Error = &requests.Failure{Code: "upstream_error", Message: fmt.Sprintf("Provider %s answered %d.", handle, resp.StatusCode)}
	}
}

// recordAttempt stores a finished Attempt and logs it.
func (x *exchange) recordAttempt(a requests.Attempt) {
	x.rec.AttemptCount++
	if x.begun {
		if err := x.g.rec.Attempt(x.ctx, x.rec.ID, a); err != nil {
			x.g.log.Error("recording an Attempt failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
		}
	}
	attrs := []any{logs.Kind(KindAttempt), logs.Request(x.rec.ID), logs.Provider(a.Provider),
		"seq", a.Seq, "endpoint", a.Endpoint, "upstream_key", a.UpstreamKey, "wire_model", a.WireModel, "status", a.Status, "duration_ms", *a.DurationMs}
	if a.Error != "" {
		attrs = append(attrs, "error", a.Error)
	}
	x.g.log.Info("attempt finished", attrs...)
}

// callerGone records that the Caller went away before the answer ended.
func (x *exchange) callerGone() {
	if x.rec.Status == 0 {
		x.rec.Status = 499 // no status reached the Caller
	}
	x.rec.Error = &requests.Failure{Code: "caller_gone", Message: "The Caller closed the connection before the answer ended."}
}

// transportError describes a failed round trip without the URL (which, with
// query-parameter auth, could hold a secret).
func transportError(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return err.Error()
}

func isEventStream(h http.Header) bool {
	mt, _, err := mime.ParseMediaType(h.Get("Content-Type"))
	return err == nil && mt == "text/event-stream"
}

// relayResult is how relaying an answer went.
type relayResult struct {
	firstByte time.Time // when the first byte of the answer arrived
	err       string    // what broke, when the answer did not end cleanly
}

// writeHead sends the status line: the upstream status and content type
// (fallback def), plus Iroha's own headers. No other upstream header reaches
// the Caller.
func (x *exchange) writeHead(resp *http.Response, def string) {
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = def
	}
	x.w.Header().Set("Content-Type", ct)
	x.wrote = true
	x.rec.Status = resp.StatusCode
	x.w.WriteHeader(resp.StatusCode)
}

// relayBuffered reads the whole answer, lets transform adjust it and writes it.
func (x *exchange) relayBuffered(resp *http.Response, transform func(status int, body []byte) []byte) relayResult {
	res := relayResult{firstByte: x.g.clock.Now()}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
	if err != nil {
		res.err = "reading the answer: " + transportError(err)
		if x.ctx.Err() != nil {
			x.callerGone()
			return res
		}
		x.fail(api.Errorf(http.StatusBadGateway, "upstream_broken", "Retry; the Provider's connection broke mid-answer.",
			"Provider %s's answer broke off: %s", x.rec.Provider, res.err))
		return res
	}
	data = transform(resp.StatusCode, data)
	x.writeHead(resp, "application/json")
	if _, err := x.w.Write(data); err != nil {
		x.callerGone()
	}
	return res
}

// relayStream forwards a server-sent event stream event by event, flushing
// each as it arrives. transform sees each data payload and may change or
// drop its event.
func (x *exchange) relayStream(resp *http.Response, transform func(payload []byte) ([]byte, bool)) relayResult {
	var res relayResult
	x.w.Header().Set("Cache-Control", "no-cache")
	x.writeHead(resp, "text/event-stream")
	flusher, _ := x.w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}
	br := bufio.NewReaderSize(resp.Body, 32<<10)
	for {
		ev, err := readEvent(br)
		if len(ev) > 0 {
			if res.firstByte.IsZero() {
				res.firstByte = x.g.clock.Now()
			}
			if out := mapData(ev, transform); out != nil {
				if _, werr := x.w.Write(out); werr != nil {
					res.err = "the Caller went away mid-stream"
					x.callerGone()
					return res
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
		}
		if err == nil {
			continue
		}
		if !errors.Is(err, io.EOF) {
			if x.ctx.Err() != nil {
				res.err = "the Caller went away mid-stream"
				x.callerGone()
				return res
			}
			res.err = "the stream broke off: " + transportError(err)
			x.rec.Error = &requests.Failure{Code: "upstream_stream_broken", Message: fmt.Sprintf("Provider %s's stream broke off: %s", x.rec.Provider, transportError(err))}
		}
		return res
	}
}

// readEvent reads one server-sent event: lines up to and including a blank
// line. At the end of the body it returns what it has with the error.
func readEvent(br *bufio.Reader) ([]byte, error) {
	var ev []byte
	for {
		line, err := br.ReadBytes('\n')
		ev = append(ev, line...)
		if err != nil {
			return ev, err
		}
		if len(bytes.TrimRight(line, "\r\n")) == 0 {
			return ev, nil
		}
	}
}

// mapData applies f to every data line of an event. It returns ev itself
// when nothing changed and nil when f drops the event.
func mapData(ev []byte, f func([]byte) ([]byte, bool)) []byte {
	var out []byte
	changed := false
	for rest := ev; len(rest) > 0; {
		line := rest
		if i := bytes.IndexByte(rest, '\n'); i >= 0 {
			line, rest = rest[:i+1], rest[i+1:]
		} else {
			rest = nil
		}
		content := bytes.TrimRight(line, "\r\n")
		if bytes.HasPrefix(content, []byte("data:")) {
			payload := bytes.TrimPrefix(content[len("data:"):], []byte(" "))
			np, drop := f(payload)
			if drop {
				return nil
			}
			if !bytes.Equal(np, payload) {
				changed = true
				nl := append([]byte("data: "), np...)
				line = append(nl, line[len(content):]...)
			}
		}
		out = append(out, line...)
	}
	if !changed {
		return ev
	}
	return out
}

// chatRelay adjusts an OpenAI Chat Completions answer on its way to the
// Caller: the model echoes the Caller's name, usage is read, and a usage
// chunk the Caller did not ask for is dropped.
type chatRelay struct {
	model          string
	dropUsageChunk bool
	usage          *usage.Usage
}

func (c *chatRelay) body(status int, b []byte) []byte {
	if status >= 300 {
		return b
	}
	if u, ok := usage.FromOpenAIChat(b); ok {
		c.usage = &u
	}
	return echoModel(b, c.model)
}

func (c *chatRelay) data(p []byte) ([]byte, bool) {
	if len(p) == 0 || p[0] != '{' {
		return p, false
	}
	if bytes.Contains(p, []byte(`"usage"`)) {
		if u, ok := usage.FromOpenAIChat(p); ok {
			c.usage = &u
			if c.dropUsageChunk && noChoices(p) {
				return nil, true
			}
		}
	}
	return echoModel(p, c.model), false
}

func noChoices(p []byte) bool {
	var v struct {
		Choices []json.RawMessage `json:"choices"`
	}
	return json.Unmarshal(p, &v) == nil && len(v.Choices) == 0
}
