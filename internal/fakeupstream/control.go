package fakeupstream

import (
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// ControlPath is where a fake started with EnableControl takes orders over
// HTTP, for a process that cannot call its Go methods (an agent driving
// cmd/iroha-dev with curl). The routes are listed by GET ControlPath/ and in
// ControlHelp.
const ControlPath = "/_fake"

// Replies are the names ReplyNamed knows, for help texts. Any HTTP status
// from 400 to 599 also names the Shape's error envelope with that status.
var Replies = map[string]string{
	"ok":     "a short text answer in the fake's Shape (streamed when the request asks)",
	"429":    "429 with Retry-After (retry_after seconds, default 30): the key goes cooling",
	"401":    "401: the key goes invalid",
	"404":    "404 model not found: a Model Gap for the key and model",
	"400":    "400 invalid request: fails the Request (passthrough with a conversation gets one free retry without prompt_cache_key)",
	"500":    "500 (also 502, 503, 529, any 4xx/5xx): retried on the next candidate",
	"slow":   "the ok answer after ms milliseconds (default 5000)",
	"cut":    "a stream that drops the connection after its first two events",
	"hang":   "never answers; the Request ends at its first-byte deadline",
	"drop":   "closes the connection with no response",
	"html":   "200 with an HTML page instead of JSON",
	"stream": "a streamed answer even when the request did not ask for one",
}

// EnableControl makes the fake answer ControlPath routes and refuse
// Upstream Keys whose secret holds "fail<status>" (for example
// sk-demo-fail401) with that status, before any queued reply.
func (u *Upstream) EnableControl() { u.ctl.Store(true) }

// ControlURL is the base of the control routes.
func (u *Upstream) ControlURL() string { return u.srv.URL + ControlPath }

// ControlHelp describes the control routes, relative to ControlURL.
var ControlHelp = map[string]string{
	"GET /":                    "this help, the fake's Shape, queued replies and requests received",
	"POST /next?reply=NAME":    "queue a reply for the next inference request; count=N queues it N times; status, message, code, ms, retry_after tune it",
	"POST /default?reply=NAME": "answer every inference request with it once the queue is empty (reply=ok restores the default)",
	"GET /requests":            "what the fake received, oldest first: method, path, query, headers, body (parsed JSON), raw (the bytes as sent), model, stream; last=N keeps the latest N",
	"POST /usage?input=I&output=O&cache_read=C": "token usage of later ok answers",
	"POST /reset": "empty the queue, drop the default and forget the requests received",
}

var failMarker = regexp.MustCompile(`fail([45]\d\d)`)

// credential is the Upstream Key the request carried, in any auth style.
func credential(r *Received) string {
	if b := r.Bearer(); b != "" {
		return b
	}
	for _, h := range []string{"x-api-key", "x-goog-api-key", "api-key"} {
		if v := r.Header.Get(h); v != "" {
			return v
		}
	}
	return r.Query.Get("key")
}

// markedFailure is the reply for a key whose secret holds fail<status>.
func (u *Upstream) markedFailure(r *Received) (Responder, bool) {
	m := failMarker.FindStringSubmatch(credential(r))
	if m == nil {
		return nil, false
	}
	status, _ := strconv.Atoi(m[1])
	rs := u.errorReply(status, "", fmt.Sprintf("fake %s upstream: this key is marked to fail with %d", u.Shape, status))
	if status == http.StatusTooManyRequests {
		rs = rs.Header("Retry-After", "1800")
	}
	return rs, true
}

// ReplyNamed builds the Responder a control request names; q holds the
// tuning parameters (status, message, code, ms, retry_after).
func (u *Upstream) ReplyNamed(name string, q interface{ Get(string) string }) (Responder, error) {
	msg := q.Get("message")
	ms := func(def int) time.Duration {
		if v, err := strconv.Atoi(q.Get("ms")); err == nil && v >= 0 {
			return time.Duration(v) * time.Millisecond
		}
		return time.Duration(def) * time.Millisecond
	}
	switch name {
	case "", "ok":
		return u.text("Hello from the fake " + string(u.Shape) + " upstream."), nil
	case "stream":
		return u.Stream("Hello", " from", " the", " fake."), nil
	case "slow":
		return u.text("Hello from the slow fake.").After(ms(5000)), nil
	case "cut":
		return u.Stream("Hello", " from", " the", " fake.").ThenCut(2), nil
	case "hang":
		return Hang(), nil
	case "drop":
		return Drop(), nil
	case "html":
		return Raw(200, "text/html", "<!doctype html><html><body><h1>Just a moment...</h1></body></html>"), nil
	case "error":
		name = q.Get("status")
	}
	status, err := strconv.Atoi(name)
	if err != nil || status < 400 || status > 599 {
		names := make([]string, 0, len(Replies))
		for n := range Replies {
			names = append(names, n)
		}
		sort.Strings(names)
		return nil, fmt.Errorf("unknown reply %q: use one of %s, or an HTTP status from 400 to 599", name, strings.Join(names, ", "))
	}
	if msg == "" {
		msg = fmt.Sprintf("fake %s upstream: %d as asked", u.Shape, status)
	}
	rs := u.errorReply(status, q.Get("code"), msg)
	if status == http.StatusTooManyRequests {
		ra := q.Get("retry_after")
		if ra == "" {
			ra = "30"
		}
		rs = rs.Header("Retry-After", ra)
	}
	if d := ms(0); d > 0 {
		rs = rs.After(d)
	}
	return rs, nil
}

// ThenCut returns a Responder that keeps the first n chunks of its stream
// and then drops the connection, so the stream ends without its terminator.
func (rs Responder) ThenCut(n int) Responder {
	return func(r *Received) Reply {
		rep := rs(r)
		if n < len(rep.Chunks) {
			rep.Chunks = rep.Chunks[:n]
		}
		rep.Disconnect = true
		return rep
	}
}

// ReceivedView is a received request as GET /_fake/requests shows it.
type ReceivedView struct {
	Seq    int               `json:"seq"`
	At     time.Time         `json:"at"`
	Method string            `json:"method"`
	Path   string            `json:"path"`
	Query  string            `json:"query,omitempty"`
	Header map[string]string `json:"headers"`
	Model  string            `json:"model,omitempty"`
	Stream bool              `json:"stream"`
	// Body is the JSON body (re-encoded compactly), or a string when it is
	// not JSON; Raw is the body byte for byte as sent.
	Body json.RawMessage `json:"body,omitempty"`
	Raw  string          `json:"raw,omitempty"`
}

func viewOf(r *Received) ReceivedView {
	v := ReceivedView{Seq: r.Seq, At: r.At, Method: r.Method, Path: r.Path, Query: r.Query.Encode(), Header: map[string]string{}, Model: r.Model, Stream: r.Stream, Raw: string(r.Body)}
	for k, vs := range r.Header {
		v.Header[strings.ToLower(k)] = strings.Join(vs, ", ")
	}
	switch {
	case len(r.Body) == 0:
	case json.Valid(r.Body):
		v.Body = r.Body
	default:
		v.Body, _ = json.Marshal(string(r.Body))
	}
	return v
}

func (u *Upstream) control(w http.ResponseWriter, req *http.Request) {
	q := req.URL.Query()
	reply := func(status int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		enc := json.NewEncoder(w) // compact: bodies stay byte for byte as received
		enc.SetEscapeHTML(false)
		_ = enc.Encode(v)
	}
	fail := func(status int, msg string) { reply(status, map[string]string{"error": msg}) }
	route := req.Method + " " + strings.TrimPrefix(req.URL.Path, ControlPath)
	switch route {
	case "GET /":
		reply(200, map[string]any{"shape": u.Shape, "url": u.URL(), "queued": u.Queued(), "received": u.Count(), "routes": ControlHelp, "replies": Replies,
			"key_markers": "an Upstream Key whose secret holds fail<status> (sk-demo-fail401, sk-demo-fail429) always gets that status"})
	case "POST /next", "POST /default":
		rs, err := u.ReplyNamed(q.Get("reply"), q)
		if err != nil {
			fail(400, err.Error())
			return
		}
		if route == "POST /default" {
			if q.Get("reply") == "ok" || q.Get("reply") == "" {
				rs = nil
			}
			u.Default(rs)
			reply(200, map[string]any{"default": q.Get("reply")})
			return
		}
		n := 1
		if c := q.Get("count"); c != "" {
			if n, err = strconv.Atoi(c); err != nil || n < 1 || n > 1000 {
				fail(400, "count must be a whole number from 1 to 1000")
				return
			}
		}
		for i := 0; i < n; i++ {
			u.Enqueue(rs)
		}
		reply(200, map[string]any{"queued": u.Queued()})
	case "GET /requests":
		all := u.Requests()
		if n, err := strconv.Atoi(q.Get("last")); err == nil && n >= 0 && n < len(all) {
			all = all[len(all)-n:]
		}
		out := make([]ReceivedView, 0, len(all))
		for _, r := range all {
			out = append(out, viewOf(r))
		}
		reply(200, map[string]any{"requests": out})
	case "POST /usage":
		var us Usage
		for name, p := range map[string]*int{"input": &us.Input, "output": &us.Output, "cache_read": &us.CacheRead} {
			if v := q.Get(name); v != "" {
				n, err := strconv.Atoi(v)
				if err != nil || n < 0 {
					fail(400, name+" must be a whole number of tokens")
					return
				}
				*p = n
			}
		}
		u.SetUsageWith(us)
		reply(200, map[string]any{"usage": map[string]int{"input": us.Input, "output": us.Output, "cache_read": us.CacheRead}})
	case "POST /reset":
		u.Reset()
		reply(200, map[string]any{"reset": true})
	default:
		fail(404, "no control route "+route+"; GET "+ControlPath+"/ lists them")
	}
}
