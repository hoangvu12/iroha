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
	"sync"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/translate"
	"github.com/hoangvu12/iroha/internal/usage"
)

// Operation paths appended to an Endpoint's base URL.
const (
	opChat     = "/chat/completions"
	opMessages = "/messages"
)

// opFor is the operation path of an inference call in Shape sh.
func opFor(sh shape.Shape) string {
	if sh == shape.AnthropicMessages {
		return opMessages
	}
	return opChat
}

// anthropicVersion is sent to Anthropic Endpoints when the Caller sends none.
const anthropicVersion = "2023-06-01"

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
// then the Upstream Key per the Endpoint's auth style. A key with an empty
// secret, or an Endpoint with auth style none, sends no credential at all;
// a Caller header in the auth slot is dropped either way.
func outbound(ctx context.Context, c planner.Candidate, in http.Header, body []byte, op string, stream bool) (*http.Request, error) {
	ep := c.Endpoint
	u, err := url.Parse(strings.TrimRight(ep.URL, "/") + op)
	if err != nil {
		return nil, fmt.Errorf("the Endpoint URL does not make a request: %w", err)
	}
	var slot, prefix string // the header the key goes in, and what precedes it
	switch ep.AuthStyle {
	case "", planner.AuthBearer:
		slot, prefix = "Authorization", "Bearer "
	case planner.AuthXAPIKey:
		slot = "X-Api-Key"
	case planner.AuthHeader:
		slot = ep.AuthParam
	case planner.AuthQuery, planner.AuthNone:
	default:
		return nil, fmt.Errorf("Endpoint %s uses auth style %q, which this version of Iroha cannot apply", ep.Name, ep.AuthStyle)
	}
	if (ep.AuthStyle == planner.AuthHeader || ep.AuthStyle == planner.AuthQuery) && ep.AuthParam == "" {
		return nil, fmt.Errorf("Endpoint %s uses auth style %s without auth_param", ep.Name, ep.AuthStyle)
	}
	send := !c.Key.Keyless(ep)
	if send && ep.AuthStyle == planner.AuthQuery {
		q := u.Query()
		q.Set(ep.AuthParam, c.Key.Secret)
		u.RawQuery = q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("the Endpoint URL does not make a request: %w", err)
	}
	for k, vs := range in {
		if forwardable(k) && !strings.EqualFold(k, slot) {
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
	for k, v := range ep.StaticHeaders {
		req.Header.Set(k, v)
	}
	if send && slot != "" {
		req.Header.Set(slot, prefix+c.Key.Secret)
	}
	return req, nil
}

// preparePassthrough returns the body to send to an Endpoint speaking the
// Caller's Shape: the Caller's bytes, with the wire model when an Endpoint
// renames it, and on OpenAI Chat streams with stream_options.include_usage
// so usage can be recorded. injected reports that Iroha asked for usage the
// Caller did not.
func preparePassthrough(body []byte, cr callerRequest, wireModel string) (out []byte, injected bool) {
	out = body
	if wireModel != cr.bodyModel {
		out, _ = setField(out, "model", jsonString(wireModel))
	}
	if cr.shape == shape.OpenAIChat && cr.stream && !cr.includeUsage {
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

// errFirstByte cancels an Attempt that reached the Request's first-byte deadline.
var errFirstByte = errors.New("no response within the Request's time budget")

// deadlineContext is parent, cancelled with errFirstByte when the clock
// reaches deadline unless disarm is called first. release frees it.
func deadlineContext(parent context.Context, c clock.Clock, deadline time.Time) (ctx context.Context, disarm, release func()) {
	ctx, cancel := context.WithCancelCause(parent)
	t := c.NewTimer(deadline.Sub(c.Now()))
	stop := make(chan struct{})
	var once sync.Once
	go func() {
		select {
		case <-t.C():
			cancel(errFirstByte)
		case <-stop:
			t.Stop()
		case <-ctx.Done():
			t.Stop()
		}
	}()
	disarm = func() { once.Do(func() { close(stop) }) }
	return ctx, disarm, func() { disarm(); cancel(context.Canceled) }
}

// upstreamCall is what one Attempt sends and how its answer reaches the
// Caller: passed through (the Endpoint speaks the Caller's Shape) or
// translated.
type upstreamCall struct {
	body   []byte
	header http.Header
	tr     *translate.Translation // nil on passthrough
	pass   *passRelay             // passthrough only
}

// prepare builds the upstream call of candidate c. A non-nil error answers
// the Caller: no other candidate would do better.
func (x *exchange) prepare(c planner.Candidate, body []byte, cr callerRequest) (upstreamCall, *api.Error) {
	ep := c.Endpoint.Shape
	call := upstreamCall{header: x.r.Header}
	if ep == shape.AnthropicMessages && call.header.Get("Anthropic-Version") == "" {
		call.header = call.header.Clone()
		call.header.Set("Anthropic-Version", anthropicVersion)
	}
	if ep == cr.shape {
		out, injected := preparePassthrough(body, cr, c.WireModel)
		call.body = out
		call.pass = &passRelay{shape: ep, model: cr.model, dropUsageChunk: injected}
		return call, nil
	}
	if ep != shape.AnthropicMessages && call.header.Get("Anthropic-Version")+call.header.Get("Anthropic-Beta") != "" {
		call.header = call.header.Clone() // the Caller's Anthropic headers mean nothing to another Shape
		call.header.Del("Anthropic-Version")
		call.header.Del("Anthropic-Beta")
	}
	tr, err := translate.New(cr.shape, ep, translate.Options{Model: cr.model, ID: x.rec.ID, Now: x.g.clock.Now()})
	if err != nil {
		return call, api.Errorf(http.StatusInternalServerError, "translation_failed", "Report this; the Request cannot be translated.", "%v", err)
	}
	out, err := tr.Request(x.ctx, body, c.WireModel)
	var te *translate.Error
	switch {
	case errors.As(err, &te):
		return call, api.Errorf(http.StatusBadRequest, "untranslatable_request",
			"Fix the request body; Iroha had to translate it for Provider "+c.Provider.Handle+", whose usable Endpoints speak "+string(ep)+".", "%s", te.Message)
	case err != nil:
		return call, api.Errorf(http.StatusInternalServerError, "translation_failed", "Report this with the Request ID; the request could not be translated.", "%v", err)
	}
	call.body, call.tr = out, tr
	return call, nil
}

// attempt makes one Attempt of a Request. A 2xx answer is relayed to the
// Caller (passed through or translated) and the Request is answered
// (failure is nil); so is a fault no other candidate can fix (a broken
// Endpoint, a redirect, a request that cannot be translated) or the Caller
// going away. Any other outcome returns the failure for the Failure Rules,
// with nothing sent to the Caller. The Attempt is returned for recording;
// the caller records it.
func (x *exchange) attempt(seq int, c planner.Candidate, body []byte, cr callerRequest, deadline time.Time) (a requests.Attempt, failure *rules.Failure) {
	g := x.g
	started := g.clock.Now()
	a = requests.Attempt{Seq: seq, StartedAt: started.UTC(), ProviderID: c.Provider.ID, Provider: c.Provider.Handle,
		EndpointID: c.Endpoint.ID, Endpoint: c.Endpoint.Name, EndpointURL: c.Endpoint.URL,
		UpstreamKeyID: c.Key.ID, UpstreamKey: c.Key.Name, WireModel: c.WireModel, Shape: c.Endpoint.Shape}
	x.rec.ProviderID, x.rec.Provider = c.Provider.ID, c.Provider.Handle
	x.rec.EndpointID, x.rec.Endpoint = c.Endpoint.ID, c.Endpoint.Name
	x.rec.UpstreamKeyID, x.rec.UpstreamKey = c.Key.ID, c.Key.Name
	x.rec.WireModel, x.rec.ShapeOut = c.WireModel, c.Endpoint.Shape
	defer func() { a.DurationMs = ms(g.clock.Now().Sub(started)) }()
	handle := c.Provider.Handle
	f := &rules.Failure{Provider: handle, Host: hostOf(c.Endpoint.URL)}

	call, perr := x.prepare(c, body, cr)
	if perr != nil {
		a.Error = perr.Message
		x.fail(perr)
		return a, nil
	}
	ctx, disarm, release := deadlineContext(x.ctx, g.clock, deadline)
	defer release()
	req, err := outbound(ctx, c, call.header, call.body, opFor(c.Endpoint.Shape), cr.stream)
	if err != nil {
		a.Error = err.Error()
		x.fail(api.Errorf(http.StatusBadGateway, "endpoint_misconfigured",
			"Ask the Owner to fix the Endpoint (GET /api/providers/"+handle+"/endpoints).", "%s", a.Error))
		return a, nil
	}
	resp, err := g.http.Do(req)
	if err != nil {
		a.Error = transportError(err)
		switch {
		case x.ctx.Err() != nil:
			x.stopped()
			return a, nil
		case context.Cause(ctx) == errFirstByte:
			a.Error = fmt.Sprintf("no response within the time budget (%s)", deadline.Sub(x.start).Round(time.Second))
			f.Timeout = true
		}
		f.Err = a.Error
		return a, f
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
		return a, nil
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// A failure: read it (within the budget) for the rules and the record.
		data, err := io.ReadAll(io.LimitReader(resp.Body, requests.MaxFailureBody))
		if err != nil {
			a.Error = "reading the error body: " + transportError(err)
		}
		f.Status, f.Header, f.Body = resp.StatusCode, resp.Header.Clone(), data
		a.FailureHeaders, a.FailureBody = failureHeaders(resp.Header), string(data)
		return a, f
	}
	disarm() // the first byte arrived: the answer may now take its time

	// Usage is read from the Provider's own answer, before any translation.
	ur := usage.NewReader(c.Endpoint.Shape)
	var res relayResult
	switch stream := cr.stream && isEventStream(resp.Header); {
	case call.tr == nil && stream:
		call.pass.usage = ur
		res = x.relayStream(resp, call.pass.data)
	case call.tr == nil:
		call.pass.usage = ur
		res = x.relayBuffered(resp, call.pass.body)
	case stream:
		res = x.relayTranslatedStream(resp, call.tr, cr, ur)
	default:
		res = x.relayBuffered(resp, translatedBody(x, call.tr, ur))
	}
	a.Error = res.err
	a.Usage, x.rec.Usage = ur.Usage(), ur.Usage()
	if !res.firstByte.IsZero() {
		a.FirstByteMs = ms(res.firstByte.Sub(started))
		x.rec.FirstByteMs = ms(res.firstByte.Sub(x.start))
	}
	return a, nil
}

// failureHeaders flattens response headers for the record, without cookies.
func failureHeaders(h http.Header) map[string]string {
	out := make(map[string]string, len(h))
	for k, vs := range h {
		if strings.EqualFold(k, "Set-Cookie") {
			continue
		}
		out[k] = strings.Join(vs, ", ")
	}
	return out
}

func hostOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return u.Hostname()
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
	if a.Outcome != "" {
		attrs = append(attrs, "rule", a.Rule, "outcome", a.Outcome, "reason", a.Reason, "action", a.Action)
	}
	x.g.log.Info("attempt finished", attrs...)
}

// stopped handles the end of x.ctx: the Caller went away, or Iroha is
// shutting down and the Request outlived the drain limit, which the Caller
// is told in its Shape (an error event when the stream is under way).
func (x *exchange) stopped() {
	if context.Cause(x.ctx) == ErrShuttingDown {
		x.fail(api.Errorf(http.StatusServiceUnavailable, "shutting_down",
			"Retry; Iroha is restarting and is usually back within seconds.",
			"Iroha shut down while this Request was in flight; it outlived the drain limit."))
		return
	}
	x.callerGone()
}

// callerGone records that the Caller went away before the answer ended.
func (x *exchange) callerGone() {
	if x.rec.Status == 0 && !x.isCommitted() {
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
// the Caller. When Iroha already committed the response (stream.go) the
// Caller has its 200 and stream headers: a stream carries on in them, and
// a non-stream answer cannot be sent, so writeHead reports false.
func (x *exchange) writeHead(resp *http.Response, def string, stream bool) bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	if x.committed {
		return stream
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = def
	}
	x.w.Header().Set("Content-Type", ct)
	if stream {
		x.w.Header().Set("Cache-Control", "no-cache")
	}
	x.wrote, x.streaming = true, stream
	x.rec.Status = resp.StatusCode
	x.w.WriteHeader(resp.StatusCode)
	if f, ok := x.w.(http.Flusher); stream && ok {
		f.Flush()
	}
	return true
}

// relayBuffered reads the whole answer, lets transform adjust it and writes
// it. An error from transform answers the Caller instead.
func (x *exchange) relayBuffered(resp *http.Response, transform func(status int, body []byte) ([]byte, *api.Error)) relayResult {
	res := relayResult{firstByte: x.g.clock.Now()}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
	if err != nil {
		res.err = "reading the answer: " + transportError(err)
		if x.ctx.Err() != nil {
			x.stopped()
			return res
		}
		x.fail(api.Errorf(http.StatusBadGateway, "upstream_broken", "Retry; the Provider's connection broke mid-answer.",
			"Provider %s's answer broke off: %s", x.rec.Provider, res.err))
		return res
	}
	data, terr := transform(resp.StatusCode, data)
	if terr != nil {
		res.err = terr.Message
		x.fail(terr)
		return res
	}
	if !x.writeHead(resp, "application/json", false) {
		res.err = "the Provider answered a stream request without a stream"
		x.fail(api.Errorf(http.StatusBadGateway, "upstream_not_streamed", "Retry without stream: true, or ask the Owner to check the Endpoint; the Provider answered this stream request with a single "+
			resp.Header.Get("Content-Type")+" body, which cannot follow the stream Iroha had already begun.",
			"Provider %s did not stream its answer.", x.rec.Provider))
		return res
	}
	if _, err := x.w.Write(data); err != nil {
		x.callerGone()
	}
	return res
}

// relayStream forwards a server-sent event stream event by event, flushing
// each as it arrives. transform sees each data payload and may change or
// drop its event. A stream that breaks off ends with an error event.
func (x *exchange) relayStream(resp *http.Response, transform func(payload []byte) ([]byte, bool)) relayResult {
	var res relayResult
	defer x.end()
	x.writeHead(resp, "text/event-stream", true)
	br := bufio.NewReaderSize(resp.Body, 32<<10)
	for {
		ev, err := readEvent(br)
		if len(ev) > 0 {
			if res.firstByte.IsZero() {
				res.firstByte = x.g.clock.Now()
			}
			if out := mapData(ev, transform); out != nil {
				if werr := x.send(out); werr != nil {
					res.err = "the Caller went away mid-stream"
					x.callerGone()
					return res
				}
			}
		}
		if err == nil {
			continue
		}
		if !errors.Is(err, io.EOF) {
			if x.ctx.Err() != nil {
				res.err = "the Caller went away mid-stream"
				if context.Cause(x.ctx) == ErrShuttingDown {
					res.err = "Iroha shut down mid-stream"
				}
				x.stopped()
				return res
			}
			res.err = "the stream broke off: " + transportError(err)
			x.fail(api.Errorf(http.StatusBadGateway, "upstream_stream_broken", "Retry; the Provider's stream broke off mid-answer. GET /api/requests/"+x.rec.ID+" (Admin Token) shows the Attempt.",
				"Provider %s's stream broke off: %s", x.rec.Provider, transportError(err)))
		}
		return res
	}
}

// end marks the answer complete, so the keeper writes nothing more.
func (x *exchange) end() {
	x.mu.Lock()
	x.ended = true
	x.mu.Unlock()
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

// passRelay adjusts a passed-through answer on its way to the Caller: the
// model echoes the Caller's name, usage is read, and an OpenAI Chat usage
// chunk the Caller did not ask for is dropped. Nothing else changes.
type passRelay struct {
	shape          shape.Shape
	model          string
	dropUsageChunk bool
	usage          *usage.Reader
}

func (c *passRelay) body(status int, b []byte) ([]byte, *api.Error) {
	if status >= 300 {
		return b, nil
	}
	c.usage.Body(b)
	return echoModel(b, c.model), nil
}

func (c *passRelay) data(p []byte) ([]byte, bool) {
	if len(p) == 0 || p[0] != '{' {
		return p, false
	}
	c.usage.Event(p)
	switch c.shape {
	case shape.OpenAIChat:
		if c.dropUsageChunk && bytes.Contains(p, []byte(`"usage"`)) && noChoices(p) {
			if _, ok := usage.FromOpenAIChat(p); ok {
				return nil, true
			}
		}
	case shape.AnthropicMessages:
		// Only message_start names the model, inside its message.
		if msg, ok := field(p, "message"); ok && bytes.Contains(p, []byte(`"message_start"`)) {
			if out, ok := setField(p, "message", echoModel(msg, c.model)); ok {
				return out, false
			}
		}
		return p, false
	}
	return echoModel(p, c.model), false
}

// translatedBody converts a whole translated answer for the Caller.
func translatedBody(x *exchange, tr *translate.Translation, ur *usage.Reader) func(int, []byte) ([]byte, *api.Error) {
	return func(status int, b []byte) ([]byte, *api.Error) {
		ur.Body(b)
		out, err := tr.Response(x.ctx, b)
		if err != nil {
			return nil, api.Errorf(http.StatusBadGateway, "translation_failed",
				"Retry, or use an Endpoint speaking your Shape; GET /api/requests/"+x.rec.ID+" (Admin Token) shows the Attempt.",
				"Provider %s's answer could not be translated: %v", x.rec.Provider, err)
		}
		return out, nil
	}
}

// relayTranslatedStream converts an upstream stream event by event into the
// Caller's Shape and sends each result as it is ready. An error event from
// the Provider, or a stream that ends before its answer did, ends the
// Caller's stream with the Shape's error event.
func (x *exchange) relayTranslatedStream(resp *http.Response, tr *translate.Translation, cr callerRequest, ur *usage.Reader) relayResult {
	var res relayResult
	defer x.end()
	x.writeHead(resp, "text/event-stream", true)
	st, err := tr.Stream(translate.StreamOptions{IncludeUsage: cr.includeUsage})
	if err != nil {
		res.err = err.Error()
		x.fail(api.Errorf(http.StatusInternalServerError, "translation_failed", "Report this with the Request ID.", "%v", err))
		return res
	}
	broken := func(code, msg string) {
		res.err = msg
		x.fail(api.Errorf(http.StatusBadGateway, code, "Retry; GET /api/requests/"+x.rec.ID+" (Admin Token) shows the Attempt.",
			"Provider %s's stream failed: %s", x.rec.Provider, msg))
	}
	br := bufio.NewReaderSize(resp.Body, 32<<10)
	for {
		ev, rerr := readEvent(br)
		if data, ok := eventData(ev); ok {
			if res.firstByte.IsZero() {
				res.firstByte = x.g.clock.Now()
			}
			ur.Event(data)
			out, terr := st.Event(x.ctx, data)
			var ue *translate.UpstreamError
			switch {
			case errors.As(terr, &ue):
				broken("upstream_stream_error", "the Provider reported an error mid-stream: "+ue.Error())
				return res
			case terr != nil:
				broken("translation_failed", terr.Error())
				return res
			}
			if len(out) > 0 {
				if werr := x.send(out); werr != nil {
					res.err = "the Caller went away mid-stream"
					x.callerGone()
					return res
				}
			}
		}
		if rerr == nil {
			continue
		}
		if !errors.Is(rerr, io.EOF) {
			if x.ctx.Err() != nil {
				res.err = "the Caller went away mid-stream"
				if context.Cause(x.ctx) == ErrShuttingDown {
					res.err = "Iroha shut down mid-stream"
				}
				x.stopped()
				return res
			}
			broken("upstream_stream_broken", "the stream broke off: "+transportError(rerr))
			return res
		}
		out, terr := st.End(x.ctx)
		if terr != nil {
			broken("upstream_stream_broken", terr.Error())
			return res
		}
		if werr := x.send(out); werr != nil {
			res.err = "the Caller went away mid-stream"
			x.callerGone()
		}
		return res
	}
}

// eventData returns the data of one server-sent event, multi-line data
// joined with newlines; ok is false for an event without data (a comment).
func eventData(ev []byte) (data []byte, ok bool) {
	for _, line := range bytes.Split(ev, []byte("\n")) {
		line = bytes.TrimRight(line, "\r")
		d, found := bytes.CutPrefix(line, []byte("data:"))
		if !found {
			continue
		}
		d = bytes.TrimPrefix(d, []byte(" "))
		if ok {
			data = append(data, '\n')
		}
		data, ok = append(data, d...), true
	}
	return data, ok
}

func noChoices(p []byte) bool {
	var v struct {
		Choices []json.RawMessage `json:"choices"`
	}
	return json.Unmarshal(p, &v) == nil && len(v.Choices) == 0
}
