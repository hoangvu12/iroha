package rules_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/rules"
)

var now = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func hdr(kv ...string) http.Header {
	h := http.Header{}
	for i := 0; i+1 < len(kv); i += 2 {
		h.Set(kv[i], kv[i+1])
	}
	return h
}

func openAIError(code, message string) []byte {
	return []byte(`{"error":{"message":"` + message + `","type":"x","param":null,"code":"` + code + `"}}`)
}

func TestBuiltinRulesClassifyTheGenericFailures(t *testing.T) {
	cases := []struct {
		name    string
		f       rules.Failure
		rule    string
		outcome rules.Outcome
		reason  string
		reset   time.Duration // 0: none
	}{
		{"401", rules.Failure{Status: 401, Body: openAIError("invalid_api_key", "Incorrect API key provided")},
			"unauthorized", rules.Invalid, "401 invalid_api_key: Incorrect API key provided", 0},
		{"403 account", rules.Failure{Status: 403, Body: []byte(`{"error":{"message":"Please complete your profile via email verification"}}`)},
			"forbidden-account", rules.Invalid, "403: Please complete your profile via email verification", 0},
		{"403 model", rules.Failure{Status: 403, Body: []byte(`{"error":{"message":"Your key has no access to model gpt-x"}}`)},
			"forbidden-model", rules.ModelGap, "", 0},
		{"403 plain text", rules.Failure{Status: 403, Body: []byte("Forbidden")},
			"forbidden", rules.CoolingKeyModel, "403: Forbidden", 0},
		// FAIL-49: a JSON body is read by its error fields, never by fields it echoes.
		{"403 account echoing the model field", rules.Failure{Status: 403, Body: []byte(`{"error":{"message":"Your account is suspended"},"model":"gpt-x"}`)},
			"forbidden-account", rules.Invalid, "403: Your account is suspended", 0},
		{"403 with a quota field and a plain message", rules.Failure{Status: 403, Body: []byte(`{"error":{"message":"Forbidden","param":null},"quota":{"used":3},"model":"gpt-x"}`)},
			"forbidden", rules.CoolingKeyModel, "403: Forbidden", 0},
		{"403 plain text naming a model", rules.Failure{Status: 403, Body: []byte("This key cannot use the model gpt-x")},
			"forbidden-model", rules.ModelGap, "", 0},
		{"403 flat envelope naming a model in its message", rules.Failure{Status: 403, Body: []byte(`{"message":"Your key may not use this model","model":"gpt-x"}`)},
			"forbidden-model", rules.ModelGap, "403: Your key may not use this model", 0},
		{"402", rules.Failure{Status: 402, Body: []byte(`{"error":"Insufficient credits"}`)},
			"payment-required", rules.CoolingKey, "402: Insufficient credits", 0},
		{"404 model", rules.Failure{Status: 404, Body: openAIError("model_not_found", "The model `x` does not exist")},
			"model-not-found", rules.ModelGap, "", 0},
		{"404 other", rules.Failure{Status: 404, Body: []byte("not here")},
			"bad-request", rules.FailRequest, "404: not here", 0},
		// Ticket 42: refusals of one Endpoint, not of the request.
		{"404 page not found", rules.Failure{Status: 404, Body: []byte("404 page not found\n")},
			"endpoint-path-not-found", rules.RetryElsewhere, "404: 404 page not found", 0},
		{"404 nginx page", rules.Failure{Status: 404, Body: []byte("<html>\r\n<head><title>404 Not Found</title></head>\r\n<body><center><h1>404 Not Found</h1></center></body></html>")},
			"endpoint-path-not-found", rules.RetryElsewhere, "", 0},
		{"404 text naming a model", rules.Failure{Status: 404, Body: []byte("404 page not found: no such model")},
			"model-not-found", rules.ModelGap, "", 0},
		{"404 page not found in a JSON message", rules.Failure{Status: 404, Body: []byte(`{"error":{"message":"404 page not found"}}`)},
			"endpoint-path-not-found", rules.RetryElsewhere, "", 0},
		{"413 nginx page", rules.Failure{Status: 413, Body: []byte("<html><head><title>413 Request Entity Too Large</title></head><body><center>nginx</center></body></html>")},
			"endpoint-body-too-large", rules.RetryElsewhere, "", 0},
		{"413 anthropic request_too_large", rules.Failure{Status: 413, Body: []byte(`{"type":"error","error":{"type":"request_too_large","message":"Request exceeds the maximum allowed number of bytes."}}`)},
			"endpoint-body-too-large", rules.RetryElsewhere, "", 0},
		{"429 retry-after seconds", rules.Failure{Status: 429, Header: hdr("Retry-After", "30"), Body: openAIError("rate_limit_exceeded", "Slow down")},
			"rate-limited", rules.CoolingKeyModel, "429 rate_limit_exceeded: Slow down", 30 * time.Second},
		{"429 retry-after date", rules.Failure{Status: 429, Header: hdr("Retry-After", now.Add(2*time.Minute).Format(http.TimeFormat))},
			"rate-limited", rules.CoolingKeyModel, "429", 2 * time.Minute},
		{"429 retry-after-ms wins", rules.Failure{Status: 429, Header: hdr("Retry-After", "30", "Retry-After-Ms", "1500")},
			"rate-limited", rules.CoolingKeyModel, "", 1500 * time.Millisecond},
		{"429 nonsense retry-after", rules.Failure{Status: 429, Header: hdr("Retry-After", "soon")},
			"rate-limited", rules.CoolingKeyModel, "", 0},
		{"500", rules.Failure{Status: 500, Body: []byte(`{"error":{"message":"boom"}}`)},
			"server-error", rules.RetryElsewhere, "500: boom", 0},
		{"529 anthropic", rules.Failure{Status: 529, Body: []byte(`{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`)},
			"server-error", rules.RetryElsewhere, "529 overloaded_error: Overloaded", 0},
		{"network", rules.Failure{Err: "connection refused"},
			"network", rules.RetryElsewhere, "network: connection refused", 0},
		{"timeout", rules.Failure{Timeout: true, Err: "no response within 60 s"},
			"upstream-timeout", rules.RetryElsewhere, "timeout: no response within 60 s", 0},
		{"408", rules.Failure{Status: 408}, "upstream-timeout", rules.RetryElsewhere, "408", 0},
		{"400", rules.Failure{Status: 400, Body: openAIError("invalid_value", "temperature must be at most 2")},
			"bad-request", rules.FailRequest, "400 invalid_value: temperature must be at most 2", 0},
		{"gemini array body", rules.Failure{Status: 429, Body: []byte(`[{"error":{"code":429,"message":"Quota exceeded","status":"RESOURCE_EXHAUSTED"}}]`)},
			"rate-limited", rules.CoolingKeyModel, "429 resource_exhausted: Quota exceeded", 0},
		{"302 matches nothing", rules.Failure{Status: 302}, "", rules.FailRequest, "302", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := rules.Default.Classify(tc.f, now)
			if d.Rule != tc.rule || d.Outcome != tc.outcome {
				t.Fatalf("got %s/%s, want %s/%s", d.Rule, d.Outcome, tc.rule, tc.outcome)
			}
			if tc.reason != "" && d.Reason != tc.reason {
				t.Errorf("reason = %q, want %q", d.Reason, tc.reason)
			}
			var gotReset time.Duration
			if !d.ResetAt.IsZero() {
				gotReset = d.ResetAt.Sub(now)
			}
			if gotReset != tc.reset {
				t.Errorf("reset in %v, want %v", gotReset, tc.reset)
			}
		})
	}
}

func TestRulesMatchOnEveryConditionAndScopedRulesComeFirst(t *testing.T) {
	quirks := []rules.Rule{
		{Name: "zai-window", Provider: "zai", Status: []string{"429"}, Code: []string{"1308", "1310"}, Outcome: rules.CoolingKey,
			Reset: []string{"json:error.next_flush_time"}},
		{Name: "dashscope-arrears", Host: "aliyuncs.com", Code: []string{"Arrearage"}, Outcome: rules.CoolingKey, CoolingSeconds: 900},
		{Name: "header-flag", Header: map[string]string{"X-Account-State": "^closed$"}, Outcome: rules.Invalid},
		{Name: "header-present", Status: []string{"5xx"}, Header: map[string]string{"X-Should-Fail": ""}, Outcome: rules.FailRequest},
	}
	set, err := rules.Compile(rules.Merge(quirks, rules.Builtin))
	if err != nil {
		t.Fatal(err)
	}
	flush := now.Add(3 * time.Hour)
	cases := []struct {
		name    string
		f       rules.Failure
		rule    string
		resetAt time.Time
		cooling time.Duration
	}{
		{"code as number, scoped to provider", rules.Failure{Provider: "zai", Status: 429,
			Body: []byte(`{"error":{"code":1308,"message":"5h limit","next_flush_time":` + itoa(flush.UnixMilli()) + `}}`)},
			"zai-window", flush, 0},
		{"other provider gets the generic rule", rules.Failure{Provider: "acme", Status: 429, Body: []byte(`{"error":{"code":1308}}`)},
			"rate-limited", time.Time{}, 0},
		{"code mismatch", rules.Failure{Provider: "zai", Status: 429, Body: []byte(`{"error":{"code":"1302"}}`)},
			"rate-limited", time.Time{}, 0},
		{"host suffix and code without case", rules.Failure{Host: "dashscope-intl.aliyuncs.com", Status: 400, Body: []byte(`{"code":"arrearage","message":"Access denied"}`)},
			"dashscope-arrears", time.Time{}, 900 * time.Second},
		{"host must be a domain boundary", rules.Failure{Host: "notaliyuncs.com", Status: 400, Body: []byte(`{"code":"Arrearage"}`)},
			"bad-request", time.Time{}, 0},
		{"header regexp", rules.Failure{Status: 200, Header: hdr("X-Account-State", "Closed")}, "header-flag", time.Time{}, 0},
		{"header presence", rules.Failure{Status: 503, Header: hdr("X-Should-Fail", "1")}, "header-present", time.Time{}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := set.Classify(tc.f, now)
			if d.Rule != tc.rule || !d.ResetAt.Equal(tc.resetAt) || d.Cooling != tc.cooling {
				t.Fatalf("got rule %s reset %v cooling %v; want %s %v %v", d.Rule, d.ResetAt, d.Cooling, tc.rule, tc.resetAt, tc.cooling)
			}
		})
	}
}

func itoa(n int64) string {
	var b [20]byte
	i := len(b)
	for {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
		if n == 0 {
			return string(b[i:])
		}
	}
}

func TestOwnerRulesOverrideBuiltinsByName(t *testing.T) {
	owner := []rules.Rule{
		{Name: "rate-limited", Status: []string{"429"}, Outcome: rules.CoolingKey, CoolingSeconds: 120},
		{Name: "teapot", Status: []string{"418"}, Outcome: rules.RetryElsewhere},
	}
	merged := rules.Merge(owner, rules.Builtin)
	if len(merged) != len(rules.Builtin)+1 || merged[0].Name != "teapot" {
		t.Fatalf("merged = %+v", merged)
	}
	set := rules.MustCompile(merged)
	if d := set.Classify(rules.Failure{Status: 429}, now); d.Outcome != rules.CoolingKey || d.Cooling != 2*time.Minute {
		t.Fatalf("override: %+v", d)
	}
	if d := set.Classify(rules.Failure{Status: 418}, now); d.Rule != "teapot" {
		t.Fatalf("added: %+v", d)
	}
}

func TestInvalidRulesAreRefusedWithTheReason(t *testing.T) {
	cases := map[string]rules.Rule{
		"no name":           {Status: []string{"429"}, Outcome: rules.Invalid},
		"bad outcome":       {Name: "x", Status: []string{"429"}, Outcome: "explode"},
		"nothing to match":  {Name: "x", Outcome: rules.Invalid},
		"bad status":        {Name: "x", Status: []string{"6xx"}, Outcome: rules.Invalid},
		"bad body regexp":   {Name: "x", Body: "(", Outcome: rules.Invalid},
		"bad header regexp": {Name: "x", Header: map[string]string{"X-A": "["}, Outcome: rules.Invalid},
		"cooling on retry":  {Name: "x", Status: []string{"500"}, Outcome: rules.RetryElsewhere, CoolingSeconds: 5},
		"bad reset source":  {Name: "x", Status: []string{"429"}, Outcome: rules.CoolingKey, Reset: []string{"body:x"}},
	}
	for name, r := range cases {
		if err := rules.Validate(r); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := rules.Compile([]rules.Rule{{Name: "a", Status: []string{"500"}, Outcome: rules.RetryElsewhere}, {Name: "a", Status: []string{"429"}, Outcome: rules.Invalid}}); err == nil ||
		!strings.Contains(err.Error(), "two rules") {
		t.Fatalf("duplicate names: %v", err)
	}
	for _, r := range rules.Builtin {
		if r.Description == "" {
			t.Errorf("built-in rule %s has no description", r.Name)
		}
	}
}

func TestResetTimesAreReadInEveryCommonForm(t *testing.T) {
	cases := map[string]time.Duration{
		"30":                                 30 * time.Second,
		"1.5":                                1500 * time.Millisecond,
		itoa(now.Add(time.Hour).Unix()):      time.Hour,
		itoa(now.Add(time.Hour).UnixMilli()): time.Hour,
		now.Add(5 * time.Minute).Format(time.RFC3339):          5 * time.Minute,
		now.Add(5 * time.Minute).Format("2006-01-02 15:04:05"): 5 * time.Minute,
		"6m0s":                                   6 * time.Minute,
		"0":                                      0,
		now.Add(-time.Hour).Format(time.RFC3339): 0,              // past: now
		"99999999":                               rules.MaxReset, // capped
	}
	for in, want := range cases {
		got, ok := rules.ParseReset(in, now)
		if !ok || got.Sub(now) != want {
			t.Errorf("%q: %v %v, want +%v", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "soon", "-5"} {
		if _, ok := rules.ParseReset(bad, now); ok {
			t.Errorf("%q accepted", bad)
		}
	}
}
