package gateway

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/hoangvu12/iroha/internal/api"
	"github.com/hoangvu12/iroha/internal/clock"
	"github.com/hoangvu12/iroha/internal/hosts"
	"github.com/hoangvu12/iroha/internal/logs"
	"github.com/hoangvu12/iroha/internal/normalise"
	"github.com/hoangvu12/iroha/internal/planner"
	"github.com/hoangvu12/iroha/internal/requests"
	"github.com/hoangvu12/iroha/internal/rules"
	"github.com/hoangvu12/iroha/internal/shape"
	"github.com/hoangvu12/iroha/internal/translate"
	"github.com/hoangvu12/iroha/internal/usage"
)

const (
	opChat     = "/chat/completions"
	opMessages = "/messages"
)

const idempotencyHeader = "Idempotency-Key"

const maxUpstreamBody = 256 << 20

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

func outbound(ctx context.Context, c planner.Candidate, in http.Header, body []byte, op string, stream bool) (*http.Request, error) {
	ep := c.Endpoint
	if err := ep.CheckAuth(); err != nil {
		return nil, err
	}
	u, err := url.Parse(strings.TrimRight(ep.URL, "/") + op)
	if err != nil {
		return nil, fmt.Errorf("the Endpoint URL does not make a request: %w", err)
	}
	h := http.Header{}
	for k, vs := range in {
		if forwardable(k) {
			h[k] = append([]string(nil), vs...)
		}
	}
	if h.Get("Content-Type") == "" {
		h.Set("Content-Type", "application/json")
	}
	if h.Get("Accept") == "" {
		if stream {
			h.Set("Accept", "text/event-stream")
		} else {
			h.Set("Accept", "application/json")
		}
	}
	ep.Authorize(h, u, c.Key)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("the Endpoint URL does not make a request: %w", err)
	}
	req.Header = h
	return req, nil
}

func preparePassthrough(body []byte, cr callerRequest, wireModel string) (out []byte, injected bool) {
	out = body
	if wireModel != cr.modelAsWritten && cr.shape != shape.Gemini { // Gemini's model is in the URL
		out, _ = setField(out, "model", jsonString(wireModel))
	}
	// OpenAI Chat streams report usage only with stream_options.include_usage,
	// in a last chunk whose choices are empty.
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

var errFirstByte = errors.New("no response within the Request's time budget")

func deadlineContext(parent context.Context, c clock.Clock, deadline time.Time) (ctx context.Context, disarm, release func()) {
	ctx, cancel := context.WithCancelCause(parent)
	timeUp := newAlarm(c, deadline.Sub(c.Now()), func() { cancel(errFirstByte) })
	return ctx, timeUp.stop, func() { timeUp.stop(); cancel(context.Canceled) }
}

type upstreamCall struct {
	body   []byte
	header http.Header
	tr     *translate.Translation
	pass   *passRelay
	norm   normalise.Set
	added  cacheAdditions
}

func (x *exchange) prepare(s step, body []byte, cr callerRequest) (upstreamCall, *api.Error) {
	c := s.c
	ep := c.Endpoint.Shape
	call := upstreamCall{header: x.sessionHeaders(c, x.r.Header), norm: normalise.For(c.Endpoint.URL, ep)}
	if ep == shape.AnthropicMessages && call.header.Get("Anthropic-Version") == "" {
		call.header = call.header.Clone()
		call.header.Set("Anthropic-Version", shape.AnthropicVersion)
	}
	if ep == cr.shape {
		out, injected := preparePassthrough(body, cr, c.WireModel)
		out, call.added = x.passthroughCaching(c, out, s.withoutCacheAdditions)
		call.body = call.norm.RequestBody(out)
		call.pass = &passRelay{shape: ep, model: cr.model, dropUsageChunk: injected}
		return call, nil
	}
	if ep != shape.AnthropicMessages && call.header.Get("Anthropic-Version")+call.header.Get("Anthropic-Beta") != "" {
		call.header = call.header.Clone()
		call.header.Del("Anthropic-Version")
		call.header.Del("Anthropic-Beta")
	}
	tr, err := translate.New(cr.shape, ep, translate.Options{Model: cr.model, ID: x.rec.ID, Now: x.g.clock.Now(), Stream: cr.stream,
		Caching: x.cachingFor(c, s.withoutCacheAdditions)})
	if err != nil {
		return call, api.Errorf(http.StatusInternalServerError, "translation_failed", "Report this; the Request cannot be translated.", "%v", err)
	}
	out, err := tr.Request(x.ctx, body, c.WireModel)
	var te *translate.Error
	switch {
	case errors.As(err, &te):
		hint := te.Hint
		if hint == "" {
			hint = "Fix the request body"
		}
		return call, api.Errorf(http.StatusBadRequest, "untranslatable_request",
			hint+"; Iroha had to translate it for Provider "+c.Provider.Handle+", whose usable Endpoints speak "+string(ep)+".", "%s", te.Message)
	case err != nil:
		return call, api.Errorf(http.StatusInternalServerError, "translation_failed", "Report this with the Request ID; the request could not be translated.", "%v", err)
	}
	call.body, call.tr = call.norm.RequestBody(out), tr
	call.added = cacheAdditions{fields: tr.Added}
	return call, nil
}

func (x *exchange) attempt(s step, body []byte, cr callerRequest) (a requests.Attempt, failure *rules.Failure, added cacheAdditions) {
	g := x.g
	c, deadline := s.c, s.deadline
	started := g.clock.Now()
	a = requests.Attempt{Seq: s.seq, StartedAt: started.UTC(), ProviderID: c.Provider.ID, Provider: c.Provider.Handle,
		EndpointID: c.Endpoint.ID, Endpoint: c.Endpoint.Name, EndpointURL: c.Endpoint.URL,
		UpstreamKeyID: c.Key.ID, UpstreamKey: c.Key.Name, WireModel: c.WireModel, Shape: c.Endpoint.Shape}
	x.rec.ProviderID, x.rec.Provider = c.Provider.ID, c.Provider.Handle
	x.rec.EndpointID, x.rec.Endpoint = c.Endpoint.ID, c.Endpoint.Name
	x.rec.UpstreamKeyID, x.rec.UpstreamKey = c.Key.ID, c.Key.Name
	x.rec.WireModel, x.rec.ShapeOut = c.WireModel, c.Endpoint.Shape
	defer func() { a.DurationMs = ms(g.clock.Now().Sub(started)) }()
	handle := c.Provider.Handle
	f := &rules.Failure{Provider: handle, Host: hosts.Of(c.Endpoint.URL)}

	call, perr := x.prepare(s, body, cr)
	if perr != nil {
		a.Error = perr.Message
		x.fail(perr)
		return a, nil, call.added
	}
	ctx, disarm, release := deadlineContext(x.ctx, g.clock, deadline)
	defer release()
	req, err := outbound(ctx, c, call.header, call.body, opFor(c.Endpoint.Shape, c.WireModel, cr.stream), cr.stream)
	if err != nil {
		a.Error = err.Error()
		x.fail(api.Errorf(http.StatusBadGateway, "endpoint_misconfigured",
			"Ask the Owner to fix the Endpoint (GET /api/providers/"+handle+"/endpoints).", "%s", a.Error))
		return a, nil, call.added
	}
	if req.Header.Get(idempotencyHeader) == "" {
		req.Header.Set(idempotencyHeader, x.idempotencyKey)
	}
	resp, err := g.http.Do(req)
	if err != nil {
		a.Error = transportError(err)
		switch {
		case x.ctx.Err() != nil:
			x.stopped()
			return a, nil, call.added
		case context.Cause(ctx) == errFirstByte:
			a.Error = fmt.Sprintf("no response within the time budget (%s)", deadline.Sub(x.start).Round(time.Second))
			f.Timeout = true
		}
		f.Err = a.Error
		return a, f, call.added
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
		return a, nil, call.added
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, err := failureBody(resp)
		if err != nil {
			a.Error = "reading the error body: " + transportError(err)
		}
		f.Status, f.Header, f.Body = resp.StatusCode, resp.Header.Clone(), data
		a.FailureHeaders, a.FailureBody = failureHeaders(resp.Header), string(data)
		return a, f, call.added
	}
	disarm()
	if !cr.stream {
		x.answerBegan()
		defer x.out.answerEnded()
	}

	if body, _ := answerFailure(resp, cr.stream, call.norm, call.tr != nil); body != nil {
		f.Status, f.Header, f.Body = resp.StatusCode, resp.Header.Clone(), body
		a.FailureHeaders, a.FailureBody = failureHeaders(resp.Header), string(body)
		return a, f, call.added
	}

	stream := cr.stream && isEventStream(resp.Header)

	ur := usage.NewReader(c.Endpoint.Shape)
	rm := &reportedModel{shape: c.Endpoint.Shape}
	var res relayResult
	switch {
	case call.tr == nil && stream:
		call.pass.usage, call.pass.reported = ur, rm
		res = x.relayStream(resp, c.Endpoint.Shape, call.pass.data, call.norm.Stream())
	case call.tr == nil:
		call.pass.usage, call.pass.reported = ur, rm
		res = x.relayBuffered(resp, call.pass.body)
	case stream:
		res = x.relayTranslatedStream(resp, call.tr, cr, ur, rm, call.norm.Stream())
	default:
		res = x.relayBuffered(resp, translatedBody(x, call.tr, ur, rm))
	}
	a.Error = res.err
	a.ReportedModel = rm.Model()
	a.Usage, x.rec.Usage = ur.Usage(), ur.Usage()
	if t := res.ttft(); !t.IsZero() {
		a.FirstByteMs = ms(t.Sub(started))
		x.rec.FirstByteMs = ms(t.Sub(x.start))
	}
	return a, nil, call.added
}

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

func (x *exchange) recordAttempt(a requests.Attempt) {
	x.rec.AttemptCount++
	if x.recorded {
		if err := x.g.rec.Attempt(x.ctx, x.rec.ID, a); err != nil {
			x.g.log.Error("recording an Attempt failed", logs.Kind(logs.KindGeneric), logs.Request(x.rec.ID), "err", err.Error())
		}
	}
	attrs := []any{logs.Kind(KindAttempt), logs.Request(x.rec.ID), logs.Provider(a.Provider),
		"seq", a.Seq, "endpoint", a.Endpoint, "upstream_key", a.UpstreamKey, "wire_model", a.WireModel, "status", a.Status, "duration_ms", *a.DurationMs}
	if a.Error != "" {
		attrs = append(attrs, "error", a.Error)
	}
	if a.ReportedModel != "" && a.ReportedModel != a.WireModel {
		attrs = append(attrs, "reported_model", a.ReportedModel)
	}
	if a.Outcome != "" {
		attrs = append(attrs, "rule", a.Rule, "outcome", a.Outcome, "reason", a.Reason, "action", a.Action)
	}
	x.g.log.Info("attempt finished", attrs...)
}

func (x *exchange) stopped() {
	if context.Cause(x.ctx) == ErrShuttingDown {
		x.fail(api.Errorf(http.StatusServiceUnavailable, "shutting_down",
			"Retry; Iroha is restarting and is usually back within seconds.",
			"Iroha shut down while this Request was in flight; it outlived the drain limit."))
		return
	}
	x.callerGone()
}

const statusClientClosedRequest = 499

func (x *exchange) callerGone() {
	if x.rec.Status == 0 && !x.out.isCommitted() {
		x.rec.Status = statusClientClosedRequest
	}
	x.rec.Error = &requests.Failure{Code: "caller_gone", Message: "The Caller closed the connection before the answer ended."}
}

// A *url.Error's message includes the URL, which holds the key under
// query-parameter auth.
func transportError(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		err = ue.Err
	}
	return err.Error()
}

func isEventStream(h http.Header) bool { return requests.IsEventStream(h.Get("Content-Type")) }

type relayResult struct {
	firstByte  time.Time
	firstToken time.Time
	err        string
}

func (r *relayResult) sawEvent(sh shape.Shape, ev []byte, now time.Time) {
	if r.firstByte.IsZero() {
		r.firstByte = now
	}
	if r.firstToken.IsZero() {
		if data, ok := eventData(ev); ok && carriesContent(sh, data) {
			r.firstToken = now
		}
	}
}

func (r relayResult) ttft() time.Time {
	if !r.firstToken.IsZero() {
		return r.firstToken
	}
	return r.firstByte
}

func (x *exchange) startAnswer(resp *http.Response, defaultType string, stream bool) (answerFits bool) {
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = defaultType
	}
	sent, answerFits := x.out.writeHead(resp.StatusCode, ct, stream)
	if sent {
		x.rec.Status = resp.StatusCode
	}
	return answerFits
}

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
	if !x.startAnswer(resp, "application/json", false) {
		res.err = "the Provider answered a stream request without a stream"
		x.fail(api.Errorf(http.StatusBadGateway, "upstream_not_streamed", "Retry without stream: true, or ask the Owner to check the Endpoint; the Provider answered this stream request with a single "+
			resp.Header.Get("Content-Type")+" body, which cannot follow the stream Iroha had already begun.",
			"Provider %s did not stream its answer.", x.rec.Provider))
		return res
	}
	if err := x.out.send(data); err != nil {
		x.callerGone()
	}
	x.out.end()
	return res
}

func (x *exchange) relayStream(resp *http.Response, sh shape.Shape, transform func(payload []byte) ([]byte, bool), ns *normalise.Stream) relayResult {
	var res relayResult
	defer x.out.end()
	x.startAnswer(resp, "text/event-stream", true)
	send := func(out []byte) bool {
		if out == nil {
			return true
		}
		if werr := x.out.send(out); werr != nil {
			res.err = "the Caller went away mid-stream"
			x.callerGone()
			return false
		}
		return true
	}
	br := bufio.NewReaderSize(resp.Body, 32<<10)
	for {
		ev, err := readEvent(br)
		if len(ev) > 0 {
			res.sawEvent(sh, ev, x.g.clock.Now())
			out, nerr := normaliseEvent(ev, ns, transform)
			if nerr != nil {
				res.err = "the Provider reported a failure mid-stream: " + nerr.Error()
				x.fail(api.Errorf(http.StatusBadGateway, "upstream_stream_error", "Retry; GET /api/requests/"+x.rec.ID+" (Admin Token) shows the Attempt.",
					"Provider %s's stream failed: %s", x.rec.Provider, nerr.Error()))
				return res
			}
			if !send(out) {
				return res
			}
		}
		if err == nil {
			continue
		}
		if errors.Is(err, io.EOF) && ns != nil {
			for _, p := range ns.End() {
				if out, drop := transform(p); !drop && !send(frameData(out)) {
					return res
				}
			}
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

// A server-sent event ends at a blank line.
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

// OpenAI Chat streams name no events, so rewritten events go out data-only.
func normaliseEvent(ev []byte, ns *normalise.Stream, transform func([]byte) ([]byte, bool)) ([]byte, error) {
	data, ok := eventData(ev)
	if ns == nil || !ok {
		return mapData(ev, transform), nil
	}
	payloads, err := ns.Event(data)
	if err != nil {
		return nil, err
	}
	if len(payloads) == 1 && bytes.Equal(payloads[0], data) {
		return mapData(ev, transform), nil
	}
	var out []byte
	for _, p := range payloads {
		if np, drop := transform(p); !drop {
			out = append(out, frameData(np)...)
		}
	}
	return out, nil
}

func frameData(p []byte) []byte {
	return append(append([]byte("data: "), p...), "\n\n"...)
}

func normaliserFailure(resp *http.Response, norm normalise.Set) []byte {
	if norm.Empty() {
		return nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamBody))
	if err == nil {
		out, nerr := norm.Body(data)
		var nf *normalise.Failure
		if errors.As(nerr, &nf) {
			return capFailure(data)
		}
		data = out
	}
	var rest io.Reader = bytes.NewReader(data)
	if err != nil {
		rest = io.MultiReader(rest, errReader{err})
	} else {
		rest = io.MultiReader(rest, resp.Body)
	}
	resp.Body = readCloser{rest, resp.Body}
	return nil
}

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

type passRelay struct {
	shape          shape.Shape
	model          string
	dropUsageChunk bool
	usage          *usage.Reader
	reported       *reportedModel
}

func (c *passRelay) body(status int, b []byte) ([]byte, *api.Error) {
	if status >= 300 {
		return b, nil
	}
	c.usage.Body(b)
	c.reported.read(b)
	return specOrChat(c.shape).echoBody(b, c.model), nil
}

func (c *passRelay) data(p []byte) ([]byte, bool) {
	if len(p) == 0 || p[0] != '{' {
		return p, false
	}
	c.usage.Event(p)
	c.reported.read(p)
	if c.shape == shape.OpenAIChat && c.dropUsageChunk && bytes.Contains(p, []byte(`"usage"`)) && noChoices(p) {
		if _, ok := usage.FromOpenAIChat(p); ok {
			return nil, true
		}
	}
	return specOrChat(c.shape).echoEvent(p, c.model), false
}

func translatedBody(x *exchange, tr *translate.Translation, ur *usage.Reader, rm *reportedModel) func(int, []byte) ([]byte, *api.Error) {
	return func(status int, b []byte) ([]byte, *api.Error) {
		ur.Body(b)
		rm.read(b)
		out, err := tr.Response(x.ctx, b)
		if err != nil {
			return nil, api.Errorf(http.StatusBadGateway, "translation_failed",
				"Retry, or use an Endpoint speaking your Shape; GET /api/requests/"+x.rec.ID+" (Admin Token) shows the Attempt.",
				"Provider %s's answer could not be translated: %v", x.rec.Provider, err)
		}
		return out, nil
	}
}

func (x *exchange) relayTranslatedStream(resp *http.Response, tr *translate.Translation, cr callerRequest, ur *usage.Reader, rm *reportedModel, ns *normalise.Stream) relayResult {
	var res relayResult
	defer x.out.end()
	x.startAnswer(resp, "text/event-stream", true)
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
	feed := func(data []byte) bool {
		ur.Event(data)
		rm.read(data)
		out, terr := st.Event(x.ctx, data)
		var ue *translate.UpstreamError
		switch {
		case errors.As(terr, &ue):
			broken("upstream_stream_error", "the Provider reported an error mid-stream: "+ue.Error())
			return false
		case terr != nil:
			broken("translation_failed", terr.Error())
			return false
		}
		if len(out) > 0 {
			if werr := x.out.send(out); werr != nil {
				res.err = "the Caller went away mid-stream"
				x.callerGone()
				return false
			}
		}
		return true
	}
	br := bufio.NewReaderSize(resp.Body, 32<<10)
	for {
		ev, rerr := readEvent(br)
		if data, ok := eventData(ev); ok {
			res.sawEvent(rm.shape, ev, x.g.clock.Now())
			payloads := [][]byte{data}
			if ns != nil {
				var nerr error
				if payloads, nerr = ns.Event(data); nerr != nil {
					broken("upstream_stream_error", "the Provider reported a failure mid-stream: "+nerr.Error())
					return res
				}
			}
			for _, p := range payloads {
				if !feed(p) {
					return res
				}
			}
		}
		if rerr == nil {
			continue
		}
		if errors.Is(rerr, io.EOF) && ns != nil {
			for _, p := range ns.End() {
				if !feed(p) {
					return res
				}
			}
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
		if werr := x.out.send(out); werr != nil {
			res.err = "the Caller went away mid-stream"
			x.callerGone()
		}
		return res
	}
}

// SSE joins an event's data lines with newlines; a comment carries no data.
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
