// Package rules is the Failure Rule engine, a deep pure module: given a
// failed Attempt (status or network failure, headers, body, Provider and
// Endpoint host) and the time, it says which Failure Rule matched and what
// that means for the Upstream Key, the model and the Request. It does no I/O.
//
// Rules are data (ADR-0005). The built-in ones are entries in builtin.go;
// rules agents add through the admin API (ticket 06) are the same Rule
// values, merged over the built-ins by name (Merge) and compiled into a Set.
// Adding a built-in rule for a provider quirk is adding one Rule literal.
package rules

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Outcome is what a matched rule decides.
type Outcome string

// Outcomes. The Gateway acts on each: invalid and the cooling outcomes
// change the Upstream Key's Key State, model_gap records a Model Gap
// (ticket 08), and all but fail_request try the next candidate.
const (
	// Invalid: the Provider refused the key itself (revoked, account
	// closed). The key stays out until a test passes or its secret changes.
	Invalid Outcome = "invalid"
	// CoolingKey: the key is refused for every model until a reset time.
	CoolingKey Outcome = "cooling_key"
	// CoolingKeyModel: the key is refused for this model until a reset
	// time; it keeps serving other models. Three distinct models within
	// five minutes escalate to CoolingKey.
	CoolingKeyModel Outcome = "cooling_key_model"
	// ModelGap: the key cannot serve this model at all (entitlement).
	ModelGap Outcome = "model_gap"
	// RetryElsewhere: a passing failure (5xx, network); try the next
	// candidate and change nothing.
	RetryElsewhere Outcome = "retry_elsewhere"
	// FailRequest: the request itself is at fault (400); trying another key
	// would fail the same way, so the Caller gets the Provider's answer.
	FailRequest Outcome = "fail_request"
)

// Outcomes lists every Outcome, for validation and documentation.
var Outcomes = []Outcome{Invalid, CoolingKey, CoolingKeyModel, ModelGap, RetryElsewhere, FailRequest}

// OutcomeEnum is the enum tag value for API documents.
const OutcomeEnum = "invalid,cooling_key,cooling_key_model,model_gap,retry_elsewhere,fail_request"

// Cools reports whether the outcome puts the key (or the key for one model)
// into Cooling.
func (o Outcome) Cools() bool { return o == CoolingKey || o == CoolingKeyModel }

// Retries reports whether the Request moves on to the next candidate.
func (o Outcome) Retries() bool { return o != FailRequest }

// Rule is one Failure Rule. Every condition given must hold; a rule needs
// at least one of Status, Code, Body or Header.
type Rule struct {
	Name           string            `json:"name" doc:"Unique name. A rule added with the name of a built-in rule overrides it."`
	Description    string            `json:"description,omitempty" doc:"What the rule recognises and why it decides as it does."`
	Provider       string            `json:"provider,omitempty" doc:"Handle of the only Provider the rule applies to; empty for every Provider."`
	Host           string            `json:"host,omitempty" doc:"Endpoint hosts the rule applies to, separated by commas, each matching itself and its subdomains (aliyuncs.com matches dashscope-intl.aliyuncs.com); empty for any host. Built-in rules for one Provider's quirks are limited this way."`
	Status         []string          `json:"status,omitempty" doc:"Upstream statuses, any of which matches: exact (429), a class (5xx), network (no response at all) or timeout (no response within the time budget). An error inside a 200 answer or at the start of a stream counts as the status it stands for (error.code 429, error.type overloaded_error is 529; 502 when it names none)."`
	Code           []string          `json:"code,omitempty" doc:"Provider error codes, any of which matches, compared without case against error.code, error.type, error.status, code, type and base_resp.status_code of the JSON body (numbers as text). A code ending in * matches by prefix (billing_*)."`
	Body           string            `json:"body,omitempty" doc:"Regular expression, case-insensitive, that must match somewhere in the response body."`
	Header         map[string]string `json:"header,omitempty" doc:"Response headers that must be present, each with a case-insensitive regular expression its value must match (empty: any value)."`
	Outcome        Outcome           `json:"outcome" enum:"invalid,cooling_key,cooling_key_model,model_gap,retry_elsewhere,fail_request" doc:"What the failure means; see the Key States section of /skill.md."`
	CoolingSeconds int               `json:"cooling_seconds,omitempty" doc:"For cooling outcomes: how long to cool when the response names no reset time. Default 60 s, doubling on each repeat up to 1 h."`
	Reset          []string          `json:"reset,omitempty" doc:"For cooling outcomes: where the response names its reset time, tried in order before the Retry-After header: header:<name>, json:<dotted.path>, or body:<regexp> whose first group captures it from the body text. Values may be seconds to wait, a Unix time (seconds or milliseconds), an RFC 3339 or HTTP date, or a duration such as 6m0s."`
}

// Scoped reports whether the rule is limited to a Provider or a host.
func (r Rule) Scoped() bool { return r.Provider != "" || r.Host != "" }

// Failure is one failed Attempt as the engine sees it.
type Failure struct {
	Provider string // handle of the Provider
	Host     string // host of the Endpoint URL
	// Status is the upstream HTTP status; 0 when no response arrived. A 2xx
	// status with an error body (see EmbeddedError) is read as the status
	// the error stands for.
	Status  int
	Timeout bool        // no response arrived within the Request's time budget
	Err     string      // what went wrong when no response arrived
	Header  http.Header // response headers
	Body    []byte      // response body (the engine reads at most MaxBody bytes)
}

// Decision is what the engine decided about a Failure.
type Decision struct {
	Rule    string  // name of the matched rule; "" when none matched
	Outcome Outcome // what to do
	// Reason is one line saying what the Provider answered, such as
	// "429 rate_limit_exceeded: Slow down" or "timeout: no response in 60 s".
	Reason string
	// ResetAt is when a cooling ends, read from the response; zero when the
	// response names no reset time.
	ResetAt time.Time
	// Cooling is the rule's fixed cooling duration; zero for the default.
	Cooling time.Duration
	// Status is the status the failure was read as: the upstream status, or
	// for an error inside a 2xx answer the status that error stands for; 0
	// when no response arrived.
	Status int
}

// MaxBody is how much of a failure body the engine reads.
const MaxBody = 16 << 10

// MaxReset caps a reset time read from a response.
const MaxReset = 7 * 24 * time.Hour

// Set is a compiled list of rules in the order they are tried. It is
// immutable and safe for concurrent use.
type Set struct {
	rules []compiled
}

type compiled struct {
	Rule
	status []statusPattern
	codes  []string
	body   *regexp.Regexp
	header []headerCond
	reset  []resetSource
}

// resetSource is one place a response may name its reset time.
type resetSource struct {
	kind, arg string         // header, json or body
	re        *regexp.Regexp // body: the first group captures the time
}

type statusPattern struct {
	exact   int
	class   int // 1..5 for "1xx".."5xx"
	network bool
	timeout bool
}

type headerCond struct {
	name string
	re   *regexp.Regexp // nil: presence is enough
}

// Compile validates rules and orders them: rules limited to a Provider or
// host first, then the others, each group in the order given. The first
// matching rule decides.
func Compile(rules []Rule) (*Set, error) {
	seen := map[string]bool{}
	var scoped, global []compiled
	for _, r := range rules {
		c, err := compile(r)
		if err != nil {
			return nil, err
		}
		if seen[r.Name] {
			return nil, fmt.Errorf("rule %q: two rules have this name", r.Name)
		}
		seen[r.Name] = true
		if r.Scoped() {
			scoped = append(scoped, c)
		} else {
			global = append(global, c)
		}
	}
	return &Set{rules: append(scoped, global...)}, nil
}

// MustCompile is Compile for rules known to be valid (the built-ins).
func MustCompile(rules []Rule) *Set {
	s, err := Compile(rules)
	if err != nil {
		panic(err)
	}
	return s
}

// Validate checks one rule without compiling a Set.
func Validate(r Rule) error {
	_, err := compile(r)
	return err
}

func compile(r Rule) (compiled, error) {
	c := compiled{Rule: r}
	fail := func(format string, args ...any) (compiled, error) {
		return compiled{}, fmt.Errorf("rule %q: %s", r.Name, fmt.Sprintf(format, args...))
	}
	if strings.TrimSpace(r.Name) == "" {
		return compiled{}, fmt.Errorf("a rule has no name")
	}
	if !slices.Contains(Outcomes, r.Outcome) {
		return fail("outcome %q is not one of %s", r.Outcome, OutcomeEnum)
	}
	if len(r.Status)+len(r.Code)+len(r.Header) == 0 && r.Body == "" {
		return fail("give at least one of status, code, body or header to match on")
	}
	if r.CoolingSeconds < 0 {
		return fail("cooling_seconds is negative")
	}
	if (r.CoolingSeconds != 0 || len(r.Reset) > 0) && !r.Outcome.Cools() {
		return fail("cooling_seconds and reset apply only to the cooling outcomes")
	}
	for _, s := range r.Status {
		p, ok := parseStatus(s)
		if !ok {
			return fail("status %q is not a status (429), a class (5xx), network or timeout", s)
		}
		c.status = append(c.status, p)
	}
	for _, code := range r.Code {
		c.codes = append(c.codes, strings.ToLower(strings.TrimSpace(code)))
	}
	if r.Body != "" {
		re, err := regexp.Compile("(?i)" + r.Body)
		if err != nil {
			return fail("body is not a regular expression: %v", err)
		}
		c.body = re
	}
	names := make([]string, 0, len(r.Header))
	for name := range r.Header {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		h := headerCond{name: http.CanonicalHeaderKey(strings.TrimSpace(name))}
		if h.name == "" {
			return fail("a header condition has no header name")
		}
		if v := r.Header[name]; v != "" {
			re, err := regexp.Compile("(?i)" + v)
			if err != nil {
				return fail("header %s is not a regular expression: %v", name, err)
			}
			h.re = re
		}
		c.header = append(c.header, h)
	}
	for _, src := range r.Reset {
		kind, arg, ok := strings.Cut(src, ":")
		if !ok || arg == "" || (kind != "header" && kind != "json" && kind != "body") {
			return fail("reset %q is not header:<name>, json:<dotted.path> or body:<regexp>", src)
		}
		rs := resetSource{kind: kind, arg: arg}
		if kind == "body" {
			re, err := regexp.Compile("(?i)" + arg)
			if err != nil {
				return fail("reset %q is not a regular expression: %v", src, err)
			}
			if re.NumSubexp() == 0 {
				return fail("reset %q needs a group, such as (\\S+), capturing the time", src)
			}
			rs.re = re
		}
		c.reset = append(c.reset, rs)
	}
	for _, h := range hostList(r.Host) {
		if strings.ContainsAny(h, "/:@ ") {
			return fail("host %q is not a host name (give dashscope.aliyuncs.com, not a URL)", h)
		}
	}
	return c, nil
}

func parseStatus(s string) (statusPattern, bool) {
	s = strings.ToLower(strings.TrimSpace(s))
	switch s {
	case "network":
		return statusPattern{network: true}, true
	case "timeout":
		return statusPattern{timeout: true}, true
	}
	if len(s) == 3 && strings.HasSuffix(s, "xx") && s[0] >= '1' && s[0] <= '5' {
		return statusPattern{class: int(s[0] - '0')}, true
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 100 || n > 599 {
		return statusPattern{}, false
	}
	return statusPattern{exact: n}, true
}

// Rules returns the rules in the order they are tried.
func (s *Set) Rules() []Rule {
	out := make([]Rule, len(s.rules))
	for i, c := range s.rules {
		out[i] = c.Rule
	}
	return out
}

// Classify finds the first rule matching f and returns its decision. When
// no rule matches, network failures and 5xx retry elsewhere and anything
// else fails the Request.
//
// An error that arrived inside a 2xx answer (an error event at the start of a
// stream, or an error object in a 200 body) is read as the status it stands
// for (EmbeddedStatus), so it matches the same rules as the plain answer.
// A body that is a server-sent event stream is read by its first JSON data
// payload.
func (s *Set) Classify(f Failure, now time.Time) Decision {
	in := newInput(f)
	embedded := f.Status >= 200 && f.Status < 300
	if embedded {
		f.Status = embeddedStatus(in.doc)
	}
	for i := range s.rules {
		c := &s.rules[i]
		if c.matches(f, in) {
			d := Decision{Rule: c.Name, Outcome: c.Outcome, Reason: in.reason(f, embedded), Status: f.Status}
			if c.Outcome.Cools() {
				d.ResetAt = resetTime(c.reset, f.Header, in, now)
				d.Cooling = time.Duration(c.CoolingSeconds) * time.Second
			}
			return d
		}
	}
	d := Decision{Outcome: FailRequest, Reason: in.reason(f, embedded), Status: f.Status}
	if f.Status == 0 || f.Status >= 500 {
		d.Outcome = RetryElsewhere
	}
	return d
}

// EmbeddedError reports whether a 2xx body, or one data payload of a stream,
// is an error rather than an answer: a JSON object with type "error"
// (Anthropic) or object "error" (Mistral), a non-empty error member (OpenAI,
// OpenRouter, most others; OpenRouter adds choices with finish_reason
// "error"), or a non-zero base_resp.status_code (MiniMax) with no choices.
func EmbeddedError(payload []byte) bool {
	payload = bytes.TrimSpace(payload)
	if len(payload) == 0 || payload[0] != '{' {
		return false
	}
	var doc map[string]any
	if json.Unmarshal(payload, &doc) != nil {
		return false
	}
	return isEmbeddedError(doc)
}

func isEmbeddedError(obj map[string]any) bool {
	if obj == nil {
		return false
	}
	if obj["type"] == "error" || obj["object"] == "error" { // Anthropic; Mistral's flat envelope
		return true
	}
	switch e := obj["error"].(type) {
	case map[string]any:
		return len(e) > 0
	case string:
		return e != ""
	}
	if choices, _ := obj["choices"].([]any); len(choices) > 0 {
		return false
	}
	return baseRespCode(obj) != ""
}

// baseRespCode is MiniMax's base_resp.status_code when it is not 0.
func baseRespCode(obj map[string]any) string {
	br, _ := obj["base_resp"].(map[string]any)
	if c := scalar(br["status_code"]); c != "" && c != "0" {
		return c
	}
	return ""
}

// embeddedStatus is the HTTP status an error inside a 2xx answer stands for:
// a numeric error code or status in 400..599, else the status its error type
// or code names (Anthropic's error types, OpenAI's codes, Google's statuses),
// else 502, a failure of the Provider.
func embeddedStatus(doc any) int {
	obj := rootObject(doc)
	if obj == nil {
		return http.StatusBadGateway
	}
	e, _ := obj["error"].(map[string]any)
	for _, v := range []any{e["code"], e["status"], obj["status"], obj["raw_status_code"], obj["code"]} {
		if n, err := strconv.Atoi(scalar(v)); err == nil && n >= 400 && n <= 599 {
			return n
		}
	}
	for _, v := range []any{e["type"], e["code"], e["status"], obj["code"]} {
		if n, ok := statusOfType[strings.ToLower(scalar(v))]; ok {
			return n
		}
	}
	return http.StatusBadGateway
}

var statusOfType = map[string]int{
	// Anthropic error types
	"invalid_request_error": 400, "authentication_error": 401, "billing_error": 402, "permission_error": 403,
	"not_found_error": 404, "request_too_large": 413, "rate_limit_error": 429, "api_error": 500,
	"timeout_error": 504, "overloaded_error": 529,
	// OpenAI-style codes
	"invalid_api_key": 401, "rate_limit_exceeded": 429, "insufficient_quota": 429, "server_error": 500,
	"model_not_found": 404, "payment_required": 402, "insufficient_balance": 402,
	// Google statuses
	"invalid_argument": 400, "unauthenticated": 401, "permission_denied": 403, "not_found": 404,
	"resource_exhausted": 429, "internal": 500, "unavailable": 503, "deadline_exceeded": 504,
}

// rootObject is the JSON object of a body (the first element when the body
// is an array, as Gemini sometimes sends).
func rootObject(doc any) map[string]any {
	if arr, ok := doc.([]any); ok && len(arr) > 0 {
		doc = arr[0]
	}
	obj, _ := doc.(map[string]any)
	return obj
}

// input is what matching reads of a Failure, parsed once.
type input struct {
	body    []byte
	doc     any // the body as JSON (a stream's first JSON data payload), nil when it is not JSON
	codes   []string
	message string
}

func newInput(f Failure) *input {
	in := &input{body: f.Body}
	if len(in.body) > MaxBody {
		in.body = in.body[:MaxBody]
	}
	trimmed := bytes.TrimSpace(in.body)
	if p := firstDataJSON(trimmed); p != nil {
		trimmed = p
	}
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[') {
		if json.Unmarshal(trimmed, &in.doc) != nil {
			in.doc = nil
		}
	}
	obj := rootObject(in.doc)
	if obj != nil {
		objs := []map[string]any{}
		switch e := obj["error"].(type) {
		case map[string]any:
			objs = append(objs, e)
		case string:
			in.codes = append(in.codes, strings.ToLower(e))
			in.message = e
		}
		if c := baseRespCode(obj); c != "" {
			in.codes = append(in.codes, c)
			if br, _ := obj["base_resp"].(map[string]any); in.message == "" {
				in.message, _ = br["status_msg"].(string)
			}
		}
		objs = append(objs, obj)
		for _, o := range objs {
			for _, k := range []string{"code", "type", "status"} {
				if v := scalar(o[k]); v != "" {
					in.codes = append(in.codes, strings.ToLower(v))
				}
			}
			if in.message == "" {
				for _, k := range []string{"message", "detail", "msg"} {
					if v, ok := o[k].(string); ok && v != "" {
						in.message = v
						break
					}
				}
			}
		}
	}
	if in.message == "" && in.doc == nil {
		in.message = strings.TrimSpace(string(trimmed))
	}
	return in
}

// scalar renders a JSON string or number as text.
func scalar(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(x)
	}
	return ""
}

func (c *compiled) matches(f Failure, in *input) bool {
	if c.Provider != "" && c.Provider != f.Provider {
		return false
	}
	if !c.MatchesHost(f.Host) {
		return false
	}
	if len(c.status) > 0 && !slices.ContainsFunc(c.status, func(p statusPattern) bool { return p.matches(f) }) {
		return false
	}
	if len(c.codes) > 0 && !slices.ContainsFunc(c.codes, in.hasCode) {
		return false
	}
	if c.body != nil && !c.body.Match(in.body) {
		return false
	}
	for _, h := range c.header {
		vs, ok := f.Header[h.name]
		if !ok {
			return false
		}
		if h.re != nil && !slices.ContainsFunc(vs, h.re.MatchString) {
			return false
		}
	}
	return true
}

// hasCode reports whether the body names code; a code ending in * matches
// every code it begins.
func (in *input) hasCode(code string) bool {
	if prefix, ok := strings.CutSuffix(code, "*"); ok {
		return slices.ContainsFunc(in.codes, func(c string) bool { return strings.HasPrefix(c, prefix) })
	}
	return slices.Contains(in.codes, code)
}

// MatchesHost reports whether the rule applies to an Endpoint on host: it
// names no host, or host is one of its hosts or a subdomain of one.
func (r Rule) MatchesHost(host string) bool {
	if strings.TrimSpace(r.Host) == "" {
		return true
	}
	host = strings.ToLower(host)
	for _, domain := range hostList(r.Host) {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return true
		}
	}
	return false
}

// hostList splits a rule's comma-separated hosts.
func hostList(s string) []string {
	var out []string
	for _, h := range strings.Split(s, ",") {
		if h = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(h), ".")); h != "" {
			out = append(out, h)
		}
	}
	return out
}

// firstDataJSON is the first data payload that is a JSON object of a body
// written as server-sent events (some Providers answer a stream request's
// failure that way); nil when body is not an event stream.
func firstDataJSON(body []byte) []byte {
	if !bytes.HasPrefix(body, []byte("data:")) && !bytes.HasPrefix(body, []byte("event:")) && !bytes.HasPrefix(body, []byte(":")) {
		return nil
	}
	for _, line := range bytes.Split(body, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if p, ok := bytes.CutPrefix(line, []byte("data:")); ok {
			if p = bytes.TrimSpace(p); len(p) > 0 && p[0] == '{' {
				return p
			}
		}
	}
	return nil
}

func (p statusPattern) matches(f Failure) bool {
	switch {
	case p.timeout:
		return f.Status == 0 && f.Timeout
	case p.network:
		return f.Status == 0
	case p.class > 0:
		return f.Status/100 == p.class
	}
	return f.Status == p.exact
}

// reason is the one-line description of what the Provider answered. f.Status
// is the status the failure is read as; embedded says the Provider sent the
// error inside a 2xx answer.
func (in *input) reason(f Failure, embedded bool) string {
	s := in.statusReason(f)
	if embedded {
		s += " (sent inside a 2xx answer)"
	}
	return s
}

func (in *input) statusReason(f Failure) string {
	if f.Status == 0 {
		what := "network"
		if f.Timeout {
			what = "timeout"
		}
		if f.Err != "" {
			return what + ": " + clip(f.Err, 200)
		}
		return what
	}
	s := strconv.Itoa(f.Status)
	for _, c := range in.codes {
		if c != s && c != strings.ToLower(in.message) {
			s += " " + c
			break
		}
	}
	if in.message != "" {
		s += ": " + clip(in.message, 200)
	}
	return s
}

func clip(s string, n int) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= n {
		return s
	}
	cut := n
	for cut > 0 && !utf8Start(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
}

func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// resetTime reads the reset time from the rule's sources, then Retry-After.
func resetTime(sources []resetSource, h http.Header, in *input, now time.Time) time.Time {
	all := append(slices.Clone(sources), resetSource{kind: "header", arg: "retry-after-ms"}, resetSource{kind: "header", arg: "retry-after"})
	for _, src := range all {
		var v string
		switch src.kind {
		case "header":
			v = h.Get(src.arg)
			if strings.EqualFold(src.arg, "retry-after-ms") && v != "" {
				if n, err := strconv.ParseFloat(strings.TrimSpace(v), 64); err == nil && n >= 0 {
					return capReset(now.Add(time.Duration(n*float64(time.Millisecond))), now)
				}
				continue
			}
		case "json":
			v = scalar(lookup(in.doc, src.arg))
		case "body":
			if m := src.re.FindSubmatch(in.body); m != nil {
				v = string(m[1])
			}
		}
		if t, ok := ParseReset(v, now); ok {
			return t
		}
	}
	return time.Time{}
}

// lookup follows a dotted path through JSON objects (and array indexes).
func lookup(doc any, path string) any {
	cur := doc
	if arr, ok := cur.([]any); ok && len(arr) > 0 && !strings.HasPrefix(path, "0") {
		if _, isObj := arr[0].(map[string]any); isObj {
			cur = arr[0]
		}
	}
	for _, part := range strings.Split(path, ".") {
		switch x := cur.(type) {
		case map[string]any:
			cur = x[part]
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(x) {
				return nil
			}
			cur = x[i]
		default:
			return nil
		}
	}
	return cur
}

// ParseReset reads a reset time: seconds to wait (30, 1.5), a Unix time in
// seconds or milliseconds, an RFC 3339 or HTTP date, or a Go duration
// (6m0s, 20ms). Times in the past mean now. ok is false when v is none of
// these.
func ParseReset(v string, now time.Time) (time.Time, bool) {
	v = strings.TrimSpace(v)
	if v == "" {
		return time.Time{}, false
	}
	if n, err := strconv.ParseFloat(v, 64); err == nil {
		switch {
		case n < 0:
			return time.Time{}, false
		case n >= 1e12: // Unix milliseconds
			return capReset(time.UnixMilli(int64(n)), now), true
		case n >= 1e9: // Unix seconds
			return capReset(time.Unix(int64(n), 0), now), true
		}
		return capReset(now.Add(time.Duration(n*float64(time.Second))), now), true
	}
	if t, err := time.Parse(time.RFC3339Nano, v); err == nil {
		return capReset(t, now), true
	}
	if t, err := time.Parse("2006-01-02 15:04:05", v); err == nil { // common in provider bodies; read as UTC
		return capReset(t, now), true
	}
	if t, err := http.ParseTime(v); err == nil {
		return capReset(t, now), true
	}
	if d, err := time.ParseDuration(v); err == nil && d >= 0 {
		return capReset(now.Add(d), now), true
	}
	return time.Time{}, false
}

func capReset(t, now time.Time) time.Time {
	if t.Before(now) {
		return now.UTC()
	}
	if t.After(now.Add(MaxReset)) {
		return now.Add(MaxReset).UTC()
	}
	return t.UTC()
}

// Merge returns the rules to compile: owner rules that override a built-in
// by name take its place; other owner rules come before the built-ins.
func Merge(owner, builtin []Rule) []Rule {
	byName := map[string]Rule{}
	for _, r := range owner {
		byName[r.Name] = r
	}
	used := map[string]bool{}
	var tail []Rule
	for _, r := range builtin {
		if o, ok := byName[r.Name]; ok {
			tail = append(tail, o)
			used[r.Name] = true
			continue
		}
		tail = append(tail, r)
	}
	var head []Rule
	for _, r := range owner {
		if !used[r.Name] {
			head = append(head, r)
		}
	}
	return append(head, tail...)
}
