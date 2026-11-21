package rules_test

import (
	"slices"
	"strconv"
	"testing"
	"time"

	"github.com/hoangvu12/iroha/internal/rules"
)

const (
	dashscopeArrearage = `{"error":{"code":"Arrearage","type":"Arrearage","param":null,"message":"Access denied, please make sure your account is in good standing."}}`
	// DashScope's native (non-compatible-mode) envelope is flat.
	dashscopeArrearageFlat = `{"code":"Arrearage","message":"Access denied, please make sure your account is in good standing.","request_id":"5f1d8e5c-0000-0000-0000-000000000000"}`
	dashscopeFreeTier      = `{"error":{"code":"AllocationQuota.FreeTierOnly","type":"AllocationQuota.FreeTierOnly","param":null,"message":"Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the \"use free tier only\" mode in the management console."}}`
	dashscopeOverdue       = `{"error":{"code":"AccessDenied","message":"Your account is overdue. Please add funds and try again.","type":"AccessDenied"}}`
	minimax402             = `{"error":{"code":"insufficient_balance","type":"payment_required","message":"sensitive provider text must not cross the adapter seam"}}`
	minimax429             = `{"error":{"code":"rate_limit_exceeded","type":"rate_limit_error","message":"arbitrary provider text"}}`
	mistral402             = `{"object":"error","message":"You have reached your monthly spending limit.","type":"billing_customer_monthly_spending_limit_reached","param":null,"code":"2300","raw_status_code":402}`
	mistral422             = `{"object":"error","message":{"detail":[{"type":"extra_forbidden","loc":["body","store"],"msg":"Extra inputs are not permitted","input":false}]},"type":"invalid_request_message_error","param":null,"code":null}`
	nousCredits            = `{"status":404,"message":"Model requires available credits. Your account balance is too low to use paid models.","code":"insufficient_credits_for_paid_model"}`
	anthropicCredit        = `{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}`
	anthropicOverloaded    = `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`
	openaiQuota            = `{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","param":null,"code":"insufficient_quota"}}`
	openrouterModeration   = `{"error":{"code":403,"message":"anthropic/claude-3-opus requires moderation on OpenAI. Your input was flagged for \"violence\". No credits were charged.","metadata":{"reasons":["violence"],"provider_name":"OpenAI"}}}`
	openrouterStreamError  = `{"id":"gen-1","object":"chat.completion.chunk","created":1767225600,"model":"x/y","error":{"code":"server_error","message":"Provider disconnected"},"choices":[{"index":0,"delta":{"content":""},"finish_reason":"error"}]}`
	deepaiSpent            = `{"error":{"message":"Free daily Theos are not available right now. Try again at 2026-01-01T12:01:30+00:00.","type":"network_bound","code":"network_bound"}}`
	deepaiTheosShort       = `{"error":{"message":"You do not have enough Theos left for this request. Start a new conversation, or wait for your Theos to refresh at 2026-01-01T09:30:00+00:00.","type":"theos_insufficient","code":"theos_insufficient"}}`
	deepaiCheckIn          = `{"error":{"message":"DeepAI models are temporarily unavailable. Try again later.","type":"check_in_refused","code":"check_in_refused"}}`
	deepaiTooLarge         = `{"error":{"message":"This request needs about 21.10 Theos and this key has 8.20 left. Shorten the context or use another model.","code":"theos_request_too_large"}}`
	cloudflareBlocked      = `{"type":"https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1010/","title":"Error 1010: Access denied","status":403,"detail":"The site owner has blocked access based on your browser's signature.","error_code":1010,"error_name":"browser_signature_banned","owner_action_required":true}`
	deepaiExhausted        = `{"error":{"message":"You've used today's Theos. They refresh at 2026-01-01T23:43:51+00:00.","type":"theos_exhausted","code":"theos_exhausted"}}`
)

func zai(code string, extra ...string) []byte {
	b := `{"error":{"code":"` + code + `","message":"recorded Z.ai message"`
	for _, e := range extra {
		b += "," + e
	}
	return []byte(b + "}}")
}

func dashscope(code, message, typ string) []byte {
	return []byte(`{"error":{"code":"` + code + `","message":"` + message + `","param":null,"type":"` + typ + `"}}`)
}

func sse(payload string) []byte { return []byte("data: " + payload + "\n\n") }

const (
	dsHost   = "dashscope-intl.aliyuncs.com"
	zaiHost  = "api.z.ai"
	mmHost   = "api.minimax.io"
	misHost  = "api.mistral.ai"
	nousHost = "inference-api.nousresearch.com"
	orHost   = "openrouter.ai"
	anyHost  = "api.example.com"
)

type quirkCase struct {
	name    string
	ids     string
	f       rules.Failure
	rule    string
	outcome rules.Outcome
	reset   time.Duration
	cooling time.Duration
	status  int
}

var billing = rules.BillingCooling * time.Second

var quirkCases = []quirkCase{
	{"arrearage", "FAIL-01", rules.Failure{Host: dsHost, Status: 400, Body: []byte(dashscopeArrearage)}, "dashscope-arrearage", rules.CoolingKey, 0, billing, 0},
	{"arrearage flat envelope, CN region", "FAIL-01", rules.Failure{Host: "dashscope.aliyuncs.com", Status: 400, Body: []byte(dashscopeArrearageFlat)}, "dashscope-arrearage", rules.CoolingKey, 0, billing, 0},
	{"arrearage on a host that is not DashScope", "FAIL-01", rules.Failure{Host: anyHost, Status: 400, Body: []byte(dashscopeArrearage)}, "bad-request", rules.FailRequest, 0, 0, 0},
	{"arrearage as an event-stream body", "FAIL-01, FAIL-79", rules.Failure{Host: dsHost, Status: 400, Body: sse(dashscopeArrearage)}, "dashscope-arrearage", rules.CoolingKey, 0, billing, 0},
	{"arrearage as the first event of a 200 stream", "FAIL-01, FAIL-79", rules.Failure{Host: dsHost, Status: 200, Body: sse(dashscopeArrearage)}, "dashscope-arrearage", rules.CoolingKey, 0, billing, 502},
	{"free tier spent", "FAIL-02", rules.Failure{Host: "coding-intl.dashscope.aliyuncs.com", Status: 403, Body: []byte(dashscopeFreeTier)}, "dashscope-free-tier-spent", rules.CoolingKey, 0, billing, 0},
	{"overdue in the message only", "FAIL-10", rules.Failure{Host: dsHost, Status: 403, Body: []byte(dashscopeOverdue)}, "dashscope-account-standing", rules.CoolingKey, 0, billing, 0},
	{"400 model not supported", "FAIL-03", rules.Failure{Host: dsHost, Status: 400, Body: dashscope("invalid_parameter_error", "model `deepseek-v3.2` is not supported.", "invalid_request_error")}, "dashscope-model-unsupported", rules.ModelGap, 0, 0, 0},
	{"404 model_not_found", "FAIL-03", rules.Failure{Host: dsHost, Status: 404, Body: dashscope("model_not_found", "The model `MiniMax-M2.5` does not exist or you do not have access to it.", "invalid_request_error")}, "dashscope-model-refused", rules.ModelGap, 0, 0, 0},
	{"404 model_not_supported", "FAIL-03", rules.Failure{Host: dsHost, Status: 404, Body: dashscope("model_not_supported", "Unsupported model `text-embedding-v3` for OpenAI compatibility mode.", "invalid_request_error")}, "dashscope-model-refused", rules.ModelGap, 0, 0, 0},
	{"403 Model.AccessDenied on a listed model", "FAIL-03, FAIL-06", rules.Failure{Host: dsHost, Status: 403, Body: dashscope("Model.AccessDenied", "Model access denied.", "Model.AccessDenied")}, "dashscope-model-refused", rules.ModelGap, 0, 0, 0},
	{"403 access_denied naming the model", "FAIL-05", rules.Failure{Host: dsHost, Status: 403, Body: dashscope("access_denied", "Model access denied", "access_denied")}, "dashscope-model-access-denied", rules.ModelGap, 0, 0, 0},
	{"403 access_denied by key restrictions", "FAIL-05", rules.Failure{Host: dsHost, Status: 403, Body: dashscope("access_denied", "Access denied by API-Key restrictions.", "access_denied")}, "forbidden-account", rules.Invalid, 0, 0, 0},
	{"400 invalid_parameter_error for a bad temperature", "FAIL-04", rules.Failure{Host: dsHost, Status: 400, Body: []byte(`{"error":{"code":"invalid_parameter_error","message":"The value of temperature must be in [0, 2)."}}`)}, "bad-request", rules.FailRequest, 0, 0, 0},
	{"data inspection failed", "FAIL-07", rules.Failure{Host: dsHost, Status: 400, Body: dashscope("data_inspection_failed", "Input data may contain inappropriate content.", "data_inspection_failed")}, "dashscope-data-inspection", rules.RetryElsewhere, 0, 0, 0},

	{"1113 no balance", "FAIL-13", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1113")}, "zai-plan-billing", rules.CoolingKey, 0, billing, 0},
	{"1309 coding plan expired", "FAIL-13", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1309")}, "zai-plan-billing", rules.CoolingKey, 0, billing, 0},
	{"1314 enterprise plan expired, BigModel", "FAIL-13", rules.Failure{Host: "open.bigmodel.cn", Status: 429, Body: zai("1314")}, "zai-plan-billing", rules.CoolingKey, 0, billing, 0},
	{"1308 with next_flush_time as a date", "FAIL-14, FAIL-15", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1308", `"next_flush_time":"2026-01-01T05:00:00.000Z"`)}, "zai-usage-window", rules.CoolingKey, 5 * time.Hour, 0, 0},
	{"1310 with next_flush_time in Unix ms, numeric code", "FAIL-14, FAIL-15", rules.Failure{Host: zaiHost, Status: 429,
		Body: []byte(`{"error":{"code":1310,"message":"weekly","next_flush_time":` + strconv.FormatInt(now.Add(72*time.Hour).UnixMilli(), 10) + `}}`)}, "zai-usage-window", rules.CoolingKey, 72 * time.Hour, 0, 0},
	{"1316 without a reset time", "FAIL-14", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1316")}, "zai-usage-window", rules.CoolingKey, 0, 0, 0},
	{"1308 as an error event in a 200 stream", "FAIL-15, FAIL-79", rules.Failure{Host: zaiHost, Status: 200, Body: sse(string(zai("1308", `"next_flush_time":"2026-01-01T01:00:00Z"`)))}, "zai-usage-window", rules.CoolingKey, time.Hour, 0, 502},
	{"1302 rate limit", "FAIL-14", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1302")}, "zai-rate-limit", rules.CoolingKey, 0, 0, 0},
	{"1304 daily limit", "FAIL-14", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1304")}, "zai-rate-limit", rules.CoolingKey, 0, 0, 0},
	{"1313 fair use", "FAIL-14, FAIL-21", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1313")}, "zai-fair-use", rules.CoolingKey, 0, time.Hour, 0},
	{"1305 overloaded", "FAIL-16", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1305")}, "zai-overloaded", rules.RetryElsewhere, 0, 0, 0},
	{"1311 model not in plan", "FAIL-17", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1311")}, "zai-model-not-in-plan", rules.ModelGap, 0, 0, 0},
	{"1315 wrong product", "FAIL-18", rules.Failure{Host: zaiHost, Status: 429, Body: zai("1315")}, "zai-wrong-product", rules.Invalid, 0, 0, 0},
	{"1301 unsafe content", "FAIL-19", rules.Failure{Host: zaiHost, Status: 400, Body: zai("1301")}, "bad-request", rules.FailRequest, 0, 0, 0},
	{"1001 auth", "FAIL-20", rules.Failure{Host: zaiHost, Status: 401, Body: zai("1001")}, "unauthorized", rules.Invalid, 0, 0, 0},
	{"1234 network error", "FAIL-20", rules.Failure{Host: zaiHost, Status: 500, Body: zai("1234")}, "server-error", rules.RetryElsewhere, 0, 0, 0},
	{"Z.ai code elsewhere is a plain 429", "FAIL-12", rules.Failure{Host: anyHost, Status: 429, Body: zai("1113")}, "rate-limited", rules.CoolingKeyModel, 0, 0, 0},

	{"402 insufficient balance", "FAIL-23", rules.Failure{Host: mmHost, Status: 402, Body: []byte(minimax402)}, "minimax-insufficient-balance", rules.CoolingKey, 0, billing, 0},
	{"429 rate limit with Retry-After", "FAIL-24", rules.Failure{Host: mmHost, Status: 429, Header: hdr("Retry-After", "45"), Body: []byte(minimax429)}, "minimax-rate-limit", rules.CoolingKey, 45 * time.Second, 0, 0},
	{"bare 402", "FAIL-25", rules.Failure{Host: mmHost, Status: 402, Body: []byte("not-json")}, "payment-required", rules.CoolingKey, 0, 0, 0},
	{"empty 429", "FAIL-25", rules.Failure{Host: mmHost, Status: 429, Body: []byte("{}")}, "rate-limited", rules.CoolingKeyModel, 0, 0, 0},
	{"402 envelope on a 400", "FAIL-25", rules.Failure{Host: "api.minimaxi.com", Status: 400, Body: []byte(minimax402)}, "bad-request", rules.FailRequest, 0, 0, 0},
	{"base_resp 1008 in a 200 answer", "FAIL-27", rules.Failure{Host: mmHost, Status: 200,
		Body: []byte(`{"id":"","choices":null,"created":0,"model":"MiniMax-M2","object":"chat.completion","base_resp":{"status_code":1008,"status_msg":"insufficient balance"}}`)}, "minimax-base-resp-balance", rules.CoolingKey, 0, billing, 502},
	{"base_resp 1002 in a 200 answer", "FAIL-27", rules.Failure{Host: mmHost, Status: 200, Body: []byte(`{"base_resp":{"status_code":1002,"status_msg":"rate limit exceeded(RPM)"}}`)}, "minimax-base-resp-rate-limit", rules.CoolingKey, 0, 0, 502},
	{"base_resp 2049 in a 200 answer", "FAIL-27", rules.Failure{Host: mmHost, Status: 200, Body: []byte(`{"base_resp":{"status_code":2049,"status_msg":"invalid api key"}}`)}, "minimax-base-resp-auth", rules.Invalid, 0, 0, 502},
	{"base_resp 1027 in a 200 answer", "FAIL-27", rules.Failure{Host: mmHost, Status: 200, Body: []byte(`{"base_resp":{"status_code":1027,"status_msg":"output new_sensitive"}}`)}, "minimax-base-resp-request", rules.FailRequest, 0, 0, 502},

	{"402 monthly spending limit", "FAIL-29, FAIL-30", rules.Failure{Host: misHost, Status: 402, Body: []byte(mistral402)}, "mistral-billing", rules.CoolingKey, 0, billing, 0},
	{"402 spending limit as a 200 error body", "FAIL-30, FAIL-79", rules.Failure{Host: misHost, Status: 200, Body: []byte(mistral402)}, "mistral-billing", rules.CoolingKey, 0, billing, 402},
	{"bare 402", "FAIL-31", rules.Failure{Host: misHost, Status: 402, Body: []byte(`{"object":"error","message":"Payment required","type":"payment_required","param":null,"code":null}`)}, "payment-required", rules.CoolingKey, 0, 0, 0},
	{"billing type on a 429", "FAIL-31", rules.Failure{Host: misHost, Status: 429, Body: []byte(`{"object":"error","message":"x","type":"billing_customer_monthly_spending_limit_reached","code":"2300"}`)}, "rate-limited", rules.CoolingKeyModel, 0, 0, 0},
	{"per-model 429", "FAIL-32", rules.Failure{Host: misHost, Status: 429, Body: []byte(`{"object":"error","message":"Requests rate limit exceeded","type":"rate_limited","param":null,"code":"1300"}`)}, "rate-limited", rules.CoolingKeyModel, 0, 0, 0},
	{"422 extra_forbidden", "FAIL-33", rules.Failure{Host: misHost, Status: 422, Body: []byte(mistral422)}, "bad-request", rules.FailRequest, 0, 0, 0},
	{"400 invalid_model", "FAIL-33", rules.Failure{Host: misHost, Status: 400, Body: []byte(`{"object":"error","message":"Invalid model: mistral-x","type":"invalid_model","param":null,"code":"1500"}`)}, "bad-request", rules.FailRequest, 0, 0, 0},

	{"404 insufficient credits", "FAIL-34, FAIL-35", rules.Failure{Host: nousHost, Status: 404, Body: []byte(nousCredits)}, "nous-insufficient-credits", rules.CoolingKey, 0, billing, 0},
	{"404 insufficient credits in a 200 stream", "FAIL-34, FAIL-79", rules.Failure{Host: nousHost, Status: 200, Body: sse(nousCredits)}, "nous-insufficient-credits", rules.CoolingKey, 0, billing, 404},
	{"404 model_not_found", "FAIL-36", rules.Failure{Host: nousHost, Status: 404, Body: []byte(`{"status":404,"message":"Model not found","code":"model_not_found"}`)}, "model-not-found", rules.ModelGap, 0, 0, 0},
	{"credits code on a 429", "FAIL-36", rules.Failure{Host: nousHost, Status: 429, Body: []byte(`{"status":429,"message":"slow down","code":"insufficient_credits_for_paid_model"}`)}, "rate-limited", rules.CoolingKeyModel, 0, 0, 0},
	{"bare 404", "FAIL-36", rules.Failure{Host: nousHost, Status: 404, Body: []byte(`{"status":404,"message":"Not found"}`)}, "bad-request", rules.FailRequest, 0, 0, 0},

	{"pool spent with refill time", "FAIL-38", rules.Failure{Host: "deepai.internal", Status: 403, Body: []byte(deepaiSpent)}, "deepai-pool-spent", rules.CoolingKeyModel, 12*time.Hour + 90*time.Second, 0, 0},
	{"theos cannot cover the request", "FAIL-38", rules.Failure{Host: "deepai.internal", Status: 403, Body: []byte(deepaiTheosShort)}, "deepai-pool-spent", rules.CoolingKeyModel, 9*time.Hour + 30*time.Minute, 0, 0},
	{"check-in refused", "FAIL-39", rules.Failure{Host: "deepai.internal", Status: 403, Body: []byte(deepaiCheckIn)}, "deepai-check-in-refused", rules.RetryElsewhere, 0, 0, 0},
	{"the proxy says the request is too big for the key", "USE-19", rules.Failure{Host: "deepai.internal", Status: 400, Body: []byte(deepaiTooLarge)}, "deepai-request-too-large", rules.RetryElsewhere, 0, 0, 0},
	{"Cloudflare blocked the request's signature", "USE-20", rules.Failure{Host: "deepai.internal", Status: 403, Body: []byte(cloudflareBlocked)}, "edge-blocked-request", rules.FailRequest, 0, 0, 0},
	{"the day's Theos are used up", "USE-21", rules.Failure{Host: "deepai.internal", Status: 403, Body: []byte(deepaiExhausted)}, "deepai-theos-exhausted", rules.CoolingKeyModel, 23*time.Hour + 43*time.Minute + 51*time.Second, 0, 0},

	{"400 credit balance too low", "FAIL-43", rules.Failure{Host: "api.anthropic.com", Status: 400, Body: []byte(anthropicCredit)}, "credit-balance-too-low", rules.CoolingKey, 0, billing, 0},
	{"402 billing_error", "FAIL-40, FAIL-43", rules.Failure{Host: "api.anthropic.com", Status: 402, Body: []byte(`{"type":"error","error":{"type":"billing_error","message":"Billing issue"}}`)}, "payment-required", rules.CoolingKey, 0, 0, 0},
	{"529 overloaded", "FAIL-42", rules.Failure{Host: "api.anthropic.com", Status: 529, Body: []byte(anthropicOverloaded)}, "server-error", rules.RetryElsewhere, 0, 0, 0},
	{"overloaded error event in a 200 stream", "FAIL-40, FAIL-41", rules.Failure{Host: "api.anthropic.com", Status: 200, Body: []byte("event: error\ndata: " + anthropicOverloaded + "\n\n")}, "server-error", rules.RetryElsewhere, 0, 0, 529},
	{"rate_limit_error inside a 200 answer", "FAIL-40, FAIL-41", rules.Failure{Host: "relay.example.com", Status: 200, Header: hdr("Retry-After", "20"),
		Body: []byte(`{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}`)}, "rate-limited", rules.CoolingKeyModel, 20 * time.Second, 0, 429},

	{"429 insufficient_quota", "FAIL-45", rules.Failure{Host: "api.openai.com", Status: 429, Body: []byte(openaiQuota)}, "insufficient-quota", rules.CoolingKey, 0, billing, 0},
	{"OpenRouter 403 moderation", "FAIL-45", rules.Failure{Host: orHost, Status: 403, Body: []byte(openrouterModeration)}, "openrouter-moderation", rules.FailRequest, 0, 0, 0},
	{"OpenRouter 402 credits", "FAIL-45", rules.Failure{Host: orHost, Status: 402, Body: []byte(`{"error":{"code":402,"message":"This request requires more credits, or fewer max_tokens."}}`)}, "payment-required", rules.CoolingKey, 0, 0, 0},
	{"OpenRouter error chunk before content", "FAIL-45, FAIL-79", rules.Failure{Host: orHost, Status: 200, Body: sse(openrouterStreamError)}, "server-error", rules.RetryElsewhere, 0, 0, 500},
	{"ModelScope 403 email verification", "FAIL-47", rules.Failure{Host: "api-inference.modelscope.cn", Status: 403,
		Body: []byte(`{"errors":{"message":"Please complete your profile via email verification before using API-Inference."}}`)}, "forbidden-account", rules.Invalid, 0, 0, 0},
	{"403 naming the balance", "FAIL-47", rules.Failure{Host: anyHost, Status: 403, Body: []byte(`{"error":{"message":"Your account balance is insufficient."}}`)}, "forbidden-billing", rules.CoolingKey, 0, billing, 0},
	{"error with no status inside a 200 answer", "FAIL-41", rules.Failure{Host: anyHost, Status: 200, Body: []byte(`{"error":{"message":"upstream exploded"}}`)}, "server-error", rules.RetryElsewhere, 0, 0, 502},
}

func TestBuiltinQuirkRulesClassifyTheRecordedBodies(t *testing.T) {
	for _, tc := range quirkCases {
		t.Run(tc.name, func(t *testing.T) {
			d := rules.Default.Classify(tc.f, now)
			if d.Rule != tc.rule || d.Outcome != tc.outcome {
				t.Fatalf("%s: got %s/%s, want %s/%s (reason %q)", tc.ids, d.Rule, d.Outcome, tc.rule, tc.outcome, d.Reason)
			}
			var gotReset time.Duration
			if !d.ResetAt.IsZero() {
				gotReset = d.ResetAt.Sub(now)
			}
			if gotReset != tc.reset || d.Cooling != tc.cooling {
				t.Errorf("reset in %v cooling %v, want %v and %v", gotReset, d.Cooling, tc.reset, tc.cooling)
			}
			want := tc.status
			if want == 0 {
				want = tc.f.Status
			}
			if d.Status != want {
				t.Errorf("read as status %d, want %d", d.Status, want)
			}
		})
	}
}

func TestEveryBuiltinRuleHasARecordedCase(t *testing.T) {
	covered := map[string]bool{}
	for _, tc := range quirkCases {
		covered[tc.rule] = true
	}
	for _, n := range []string{"unauthorized", "forbidden-model", "forbidden", "model-not-found", "endpoint-path-not-found", "endpoint-body-too-large", "rate-limited", "upstream-timeout", "network", "bad-request"} {
		covered[n] = true
	}
	for _, r := range rules.Builtin {
		if !covered[r.Name] {
			t.Errorf("built-in rule %s has no case in quirkCases", r.Name)
		}
	}
}

func TestEmbeddedErrorsAreToldFromAnswers(t *testing.T) {
	errs := []string{anthropicOverloaded, mistral402, openrouterStreamError, `{"error":"boom"}`, `{"base_resp":{"status_code":1008}}`}
	answers := []string{
		`{"id":"x","choices":[{"index":0,"delta":{"content":"hi"}}]}`,
		`{"id":"x","choices":[{"index":0,"message":{"content":"hi"}}],"base_resp":{"status_code":0,"status_msg":""}}`,
		`{"id":"x","choices":[],"error":null}`,
		`{"type":"message_start","message":{}}`,
		`[DONE]`, ``,
	}
	for _, e := range errs {
		if !rules.EmbeddedError([]byte(e)) {
			t.Errorf("not an error: %s", e)
		}
	}
	for _, a := range answers {
		if rules.EmbeddedError([]byte(a)) {
			t.Errorf("read as an error: %s", a)
		}
	}
}

func TestHostListsPrefixCodesAndBodyResets(t *testing.T) {
	over := rules.Builtin[slices.IndexFunc(rules.Builtin, func(r rules.Rule) bool { return r.Name == "dashscope-arrearage" })]
	over.Host = "aliyuncs.com, relay.example.com."
	set := rules.MustCompile(rules.Merge([]rules.Rule{over}, rules.Builtin))
	for host, want := range map[string]string{"relay.example.com": "dashscope-arrearage", "eu.relay.example.com": "dashscope-arrearage",
		"dashscope.aliyuncs.com": "dashscope-arrearage", "example.com": "bad-request"} {
		if d := set.Classify(rules.Failure{Host: host, Status: 400, Body: []byte(dashscopeArrearage)}, now); d.Rule != want {
			t.Errorf("%s: %s, want %s", host, d.Rule, want)
		}
	}
	if !over.MatchesHost("RELAY.example.com") || over.MatchesHost("") || !(rules.Rule{}).MatchesHost("anything") {
		t.Error("MatchesHost")
	}

	custom := rules.MustCompile([]rules.Rule{
		{Name: "prefix", Code: []string{"quota_*"}, Outcome: rules.CoolingKey, Reset: []string{`body:retry in (\d+) seconds`}},
	})
	d := custom.Classify(rules.Failure{Status: 429, Body: []byte(`{"error":{"code":"quota_daily","message":"Retry in 90 seconds."}}`)}, now)
	if d.Rule != "prefix" || !d.ResetAt.Equal(now.Add(90*time.Second)) {
		t.Fatalf("prefix/body reset: %+v", d)
	}
	for _, bad := range []rules.Rule{
		{Name: "x", Status: []string{"429"}, Outcome: rules.CoolingKey, Reset: []string{"body:no group"}},
		{Name: "x", Status: []string{"429"}, Outcome: rules.CoolingKey, Reset: []string{"body:("}},
		{Name: "x", Status: []string{"429"}, Outcome: rules.CoolingKey, Host: "https://api.example.com/v1"},
	} {
		if rules.Validate(bad) == nil {
			t.Errorf("accepted %+v", bad)
		}
	}
}
