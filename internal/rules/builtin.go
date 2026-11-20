package rules

// Builtin are the Failure Rules that ship with Iroha. Compile tries the rules
// limited to a Provider or host first, then the others, each group in this
// order. Each entry is data: a match and an outcome.
//
// How a built-in targets one Provider. Provider handles are the Owner's
// choice, so a built-in never names one. A rule for one Provider's quirk is
// limited by Host to the domains that Provider's service answers on
// (aliyuncs.com matches dashscope.aliyuncs.com, dashscope-intl.aliyuncs.com
// and coding.dashscope.aliyuncs.com): the Endpoint URL is a fact of the
// configuration, needs no extra setting, and a Provider created under any
// handle gets its quirks. The Owner who reaches a service through a relay
// overrides the rule by name with the relay's host added
// ("host": "aliyuncs.com,relay.example.com"). Rules matching an error code
// no other service uses with another meaning, and that relays commonly pass
// on unchanged, are global instead (OpenAI's insufficient_quota, Anthropic's
// credit balance, DeepAI's pool codes, whose Endpoint is the Owner's own
// proxy).
//
// Billing refusals cool the whole key for 15 minutes (BillingCooling): the
// account usually stays refused until the Owner pays, a key test does not
// prove otherwise (GET /models answers 200 for accounts out of credit), and
// one Attempt every 15 minutes notices a top-up.
//
// Cases from docs/research/v1-case-catalog.md each rule covers are named in
// its comment; builtin_test.go holds a recorded body for every rule.
var Builtin = []Rule{
	// --- DashScope (Alibaba Model Studio, Qwen) ---------------------------
	{
		// FAIL-01: an overdue account answers 400 Arrearage.
		Name: "dashscope-arrearage", Host: hostDashScope, Code: []string{"Arrearage"},
		Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "DashScope Arrearage (\"make sure your account is in good standing\"): the account is overdue. Cool the key 15 min; it serves again once the Owner pays.",
	},
	{
		// FAIL-02: a free-tier-only key whose allowance is spent answers 403.
		Name: "dashscope-free-tier-spent", Host: hostDashScope, Code: []string{"AllocationQuota.FreeTierOnly"},
		Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "DashScope AllocationQuota.FreeTierOnly: the free quota is spent and paid use is off. Billing, not a refused key: cool the key 15 min.",
	},
	{
		// FAIL-10: arrears on some regions read only in the message text.
		Name: "dashscope-account-standing", Host: hostDashScope, Status: []string{"400", "403"},
		Body:    `good standing|arrear|overdue|add funds`,
		Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "DashScope 400/403 whose message names arrears (\"good standing\", \"overdue\", \"add funds\"): billing. Cool the key 15 min.",
	},
	{
		// FAIL-03, FAIL-06: the key's tier does not include the model.
		Name: "dashscope-model-refused", Host: hostDashScope,
		Code:        []string{"model_not_found", "model_not_supported", "Model.AccessDenied"},
		Outcome:     ModelGap,
		Description: "DashScope model_not_found, model_not_supported or Model.AccessDenied: this key's tier cannot use this model, even when its own model list shows it. Record a Model Gap; the key keeps serving other models.",
	},
	{
		// FAIL-03, FAIL-04: invalid_parameter_error is a model refusal only
		// with this message; any other parameter error is the request's fault.
		Name: "dashscope-model-unsupported", Host: hostDashScope, Status: []string{"400"},
		Code: []string{"invalid_parameter_error"}, Body: "model `[^`]*` is not supported",
		Outcome:     ModelGap,
		Description: "DashScope 400 invalid_parameter_error saying \"model `X` is not supported\": the key's tier lacks the model. Other invalid_parameter_error answers (a bad temperature) still fail the Request.",
	},
	{
		// FAIL-05: access_denied names a model here; "Access denied by
		// API-Key restrictions." is the key and falls to forbidden-account.
		Name: "dashscope-model-access-denied", Host: hostDashScope, Code: []string{"access_denied"},
		Body: `model access denied`, Outcome: ModelGap,
		Description: "DashScope access_denied saying \"Model access denied\": this key may not use this model. (access_denied about the key's own restrictions is left to the generic 403 rules.)",
	},
	{
		// FAIL-07: content moderation; another key or region may pass it.
		Name: "dashscope-data-inspection", Host: hostDashScope, Code: []string{"data_inspection_failed"},
		Outcome:     RetryElsewhere,
		Description: "DashScope data_inspection_failed (content moderation): try the next candidate, another key or region may accept it; the key is fine.",
	},

	// --- Z.ai / BigModel (GLM) --------------------------------------------
	// Z.ai answers 429 for ten meanings; its numeric error.code decides
	// (FAIL-12). The rules match the code alone, so a code sent as an error
	// event in a 200 stream reads the same.
	{
		// FAIL-13
		Name: "zai-plan-billing", Host: hostZai, Code: []string{"1113", "1309", "1314"},
		Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "Z.ai 1113 (no balance or resource package), 1309 (coding plan expired), 1314 (enterprise plan expired): billing. Cool the key 15 min.",
	},
	{
		// FAIL-14, FAIL-15: usage windows with a reset time.
		Name: "zai-usage-window", Host: hostZai,
		Code:    []string{"1308", "1310", "1316", "1317", "1318", "1319", "1320", "1321"},
		Outcome: CoolingKey, Reset: []string{"json:error.next_flush_time"},
		Description: "Z.ai 1308 (5-hour), 1310 (weekly/monthly), 1316-1321 (5-hour/7-day overage) usage windows: cool the key until error.next_flush_time (Unix ms or a date), else Retry-After, else the default.",
	},
	{
		// FAIL-14: throttles without a reset time.
		Name: "zai-rate-limit", Host: hostZai, Code: []string{"1302", "1304"},
		Outcome:     CoolingKey,
		Description: "Z.ai 1302 (rate limit) and 1304 (daily call limit): the limit is the key's, not one model's. Cool the key (60 s, doubling on repeats).",
	},
	{
		// FAIL-14, FAIL-21: fair use needs a request to Z.ai to lift.
		Name: "zai-fair-use", Host: hostZai, Code: []string{"1313"},
		Outcome: CoolingKey, CoolingSeconds: 3600,
		Description: "Z.ai 1313 fair-use restriction: lifted only on request to Z.ai, and the quota endpoint does not show it. Cool the key 1 h instead of wasting an Attempt on every Request.",
	},
	{
		// FAIL-16
		Name: "zai-overloaded", Host: hostZai, Code: []string{"1305"},
		Outcome:     RetryElsewhere,
		Description: "Z.ai 1305: the service or model is overloaded. Try the next candidate; the key is fine.",
	},
	{
		// FAIL-17
		Name: "zai-model-not-in-plan", Host: hostZai, Code: []string{"1311"},
		Outcome:     ModelGap,
		Description: "Z.ai 1311: this key's plan does not include the model. Record a Model Gap and try a key whose plan may differ.",
	},
	{
		// FAIL-18
		Name: "zai-wrong-product", Host: hostZai, Code: []string{"1315"},
		Outcome:     Invalid,
		Description: "Z.ai 1315: the key belongs to another Z.ai product (such as an enterprise coding key on this Endpoint). It never works here until the Owner replaces it or restricts it to the right Endpoint.",
	},

	// --- MiniMax ----------------------------------------------------------
	{
		// FAIL-23 (test/fixtures/minimax/inference-402.json)
		Name: "minimax-insufficient-balance", Host: hostMiniMax, Status: []string{"402"},
		Code:    []string{"insufficient_balance", "insufficient_balance_error", "billing_error", "payment_required"},
		Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "MiniMax 402 insufficient_balance: the account is out of credit. Cool the key 15 min.",
	},
	{
		// FAIL-24 (test/fixtures/minimax/inference-429.json)
		Name: "minimax-rate-limit", Host: hostMiniMax, Status: []string{"429"},
		Code:        []string{"rate_limit_exceeded", "rate_limit_error"},
		Outcome:     CoolingKey,
		Description: "MiniMax 429 rate_limit_error: the key's window is spent for every model. Cool the key until Retry-After (else the default).",
	},
	{
		// FAIL-27: base_resp.status_code inside a 200 answer.
		Name: "minimax-base-resp-balance", Host: hostMiniMax, Code: []string{"1008"},
		Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "MiniMax base_resp.status_code 1008 (insufficient balance), sent inside a 200 answer: billing. Cool the key 15 min.",
	},
	{
		// FAIL-27
		Name: "minimax-base-resp-rate-limit", Host: hostMiniMax, Code: []string{"1002", "1039"},
		Outcome:     CoolingKey,
		Description: "MiniMax base_resp.status_code 1002 (requests per minute) or 1039 (tokens per minute), sent inside a 200 answer: cool the key.",
	},
	{
		// FAIL-27
		Name: "minimax-base-resp-auth", Host: hostMiniMax, Code: []string{"1004", "2049"},
		Outcome:     Invalid,
		Description: "MiniMax base_resp.status_code 1004 (authentication failed) or 2049 (invalid API key), sent inside a 200 answer: the key is refused.",
	},
	{
		// FAIL-27
		Name: "minimax-base-resp-request", Host: hostMiniMax, Code: []string{"1026", "1027", "2013"},
		Outcome:     FailRequest,
		Description: "MiniMax base_resp.status_code 1026/1027 (sensitive input or output) or 2013 (invalid parameters), sent inside a 200 answer: the request itself is refused.",
	},

	// --- Mistral ----------------------------------------------------------
	{
		// FAIL-29, FAIL-30, FAIL-31: flat envelope, billing_ family on 402 only.
		Name: "mistral-billing", Host: hostMistral, Status: []string{"402"}, Code: []string{"billing_*"},
		Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "Mistral 402 with a billing_ type (billing_customer_monthly_spending_limit_reached, code 2300): the monthly spending limit is reached. Cool the key 15 min instead of spending the first Attempt of every Request on it.",
	},

	// --- Nous Research ----------------------------------------------------
	{
		// FAIL-34, FAIL-35, FAIL-36: billing dressed as a 404.
		Name: "nous-insufficient-credits", Host: hostNous, Status: []string{"404"},
		Code: []string{"insufficient_credits_for_paid_model"}, Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "Nous Research 404 insufficient_credits_for_paid_model: the account has no credits. Not a missing model: cool the whole key 15 min (free models are given up with it, as v1 chose).",
	},

	// --- OpenRouter -------------------------------------------------------
	{
		// FAIL-45: a moderated model refusing flagged input names "model",
		// which would otherwise read as a Model Gap.
		Name: "openrouter-moderation", Host: hostOpenRouter, Status: []string{"403"}, Body: `flagged|moderation`,
		Outcome:     FailRequest,
		Description: "OpenRouter 403 \"requires moderation ... input was flagged\": the content was refused, not the key or the model. Fail the Request with the Provider's message.",
	},

	// --- Global rules for codes no other service uses differently ---------
	{
		// FAIL-45: OpenAI (and relays) report spent credit as a 429.
		Name: "insufficient-quota", Code: []string{"insufficient_quota"},
		Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "insufficient_quota (OpenAI's \"You exceeded your current quota\", usually a 429): billing, not a rate limit. Cool the key 15 min.",
	},
	{
		// FAIL-43: Anthropic's empty account is a 400 invalid_request_error.
		Name: "credit-balance-too-low", Status: []string{"400", "402", "403"}, Body: `credit balance is too low`,
		Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Description: "\"Your credit balance is too low\" (Anthropic answers it as a 400): billing, not a bad request. Cool the key 15 min and try another.",
	},
	{
		// USE-21: DeepAI's daily Theos are used up. That is a different thing from
		// the request being too big: the account has nothing left to spend today, and
		// the message names the time the allowance comes back. Without a rule it falls
		// through to the generic 403 and the key is tried again every minute until
		// tomorrow.
		Name: "deepai-theos-exhausted", Code: []string{"theos_exhausted"},
		Outcome:     CoolingKeyModel,
		Reset:       []string{`body:They refresh at\s+(\d{4}-\d\d-\d\d[t ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:z|[+-]\d\d:?\d\d)?)`},
		Description: "DeepAI theos_exhausted (\"You've used today's Theos. They refresh at <time>\"): the account's daily allowance is spent. Cool the key for this model until the time the message names, so the router stops trying it before the allowance comes back.",
	},
	{
		// USE-19: the deepai-proxy answers a request the account's Theos cannot pay
		// for with a code of its own, so the router can tell "this request is too big
		// for this key" from "this key is spent". The key is healthy and only this
		// request is too large, so the request moves to another key and this one is
		// left as it is. Without this rule the generic 4xx rule would call it a bad
		// request and fail it.
		Name: "deepai-request-too-large", Code: []string{"theos_request_too_large"},
		Outcome:     RetryElsewhere,
		Description: "theos_request_too_large (the deepai-proxy's own answer: the request's prompt costs more than the Theos left on this key): the key is healthy, the request is too big. Try the next key and leave this one as it is.",
	},
	{
		// USE-20: a Cloudflare block is about the request, not about the key. The
		// site's edge refused the client's browser signature ("The site owner has
		// blocked access based on your browser's signature"), which happens when the
		// caller sends a User-Agent the site bans — Iroha forwards the Caller's
		// headers. No other key would fare better, and cooling keys for it empties
		// the pool for nothing.
		Name: "edge-blocked-request", Status: []string{"403"},
		Body:        `blocked access based on your browser's signature|browser_signature_banned|Error 1010`,
		Outcome:     FailRequest,
		Description: "A Cloudflare 1010 (\"The site owner has blocked access based on your browser's signature\"): the edge refused the request, not the key. Fail the Request with the edge's message; another key would be refused the same way.",
	},
	{
		// FAIL-38, USE-17: DeepAI's daily Theos cannot cover the request; the
		// message names the time the allowance refills. The deepai-proxy passes
		// the upstream refusal through unchanged, so the code is the upstream's
		// "theos_insufficient" and the message reads "wait for your Theos to
		// refresh at <time>"; the proxy's own wording, "try again at <time>",
		// is accepted too.
		Name: "deepai-pool-spent", Code: []string{"theos_insufficient", "network_bound"},
		Outcome:     CoolingKeyModel,
		Reset:       []string{`body:(?:try again at|wait for your Theos to refresh at)\s+(\d{4}-\d\d-\d\d[t ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:z|[+-]\d\d:?\d\d)?)`},
		Description: "DeepAI's daily Theos cannot cover this request (\"You do not have enough Theos left for this request. Start a new conversation, or wait for your Theos to refresh at <time>\"): the request is too big for the account's daily allowance, or the allowance is spent. Cool the key for this model until the time the message names, so the router moves on to a key whose allowance can cover the request.",
	},
	{
		// FAIL-39, USE-18: a refused check-in says nothing about the key.
		Name: "deepai-check-in-refused", Code: []string{"check_in_refused"},
		Outcome:     RetryElsewhere,
		Description: "DeepAI check_in_refused (check-in restarted too often today): the balance is unknown, not spent. Try the next candidate and leave the key as it is.",
	},

	// --- Generic fallbacks ------------------------------------------------
	{
		Name: "unauthorized", Status: []string{"401"}, Outcome: Invalid,
		Description: "401: the Provider does not accept the key. It stays out until a test passes or its secret changes.",
	},
	{
		Name: "forbidden-model", Status: []string{"403"}, Body: `\bmodels?\b`, Outcome: ModelGap,
		Description: "403 naming a model: this key may not use this model; it keeps serving others.",
	},
	{
		Name: "forbidden-billing", Status: []string{"403"}, Outcome: CoolingKey, CoolingSeconds: BillingCooling,
		Body:        `billing|balance|credit\b|credits|quota|payment|arrear|overdue|add funds|subscription`,
		Description: "403 naming billing (balance, credit, quota, payment, subscription): the account cannot pay. Cool the key 15 min rather than marking it invalid; it serves again once the Owner pays.",
	},
	{
		Name: "forbidden-account", Status: []string{"403"}, Outcome: Invalid,
		Body:        `api.?key|credential|verif|profile|account|suspend|banned|deactivat|disabled|revoked|expired`,
		Description: "403 naming an account condition (suspended, unverified such as ModelScope's \"complete your profile via email verification\", revoked): the key itself is refused.",
	},
	{
		Name: "forbidden", Status: []string{"403"}, Outcome: CoolingKeyModel,
		Description: "Any other 403: cool the key for this model and try another key.",
	},
	{
		Name: "payment-required", Status: []string{"402"}, Outcome: CoolingKey,
		Description: "402: the account behind the key cannot pay; cool the whole key and try another.",
	},
	{
		Name: "model-not-found", Status: []string{"404"}, Body: `\bmodels?\b`, Outcome: ModelGap,
		Description: "404 naming a model: this key cannot serve this model; try another key.",
	},
	{
		// After model-not-found, so a 404 naming a model stays a Model Gap.
		Name: "endpoint-path-not-found", Status: []string{"404"}, Body: `^\s*404 page not found\s*$|<title>\s*404`, Outcome: RetryElsewhere,
		Description: "404 that is a web server's page (\"404 page not found\" as plain text, or an HTML page titled 404): the Endpoint's path is wrong, not the request. Try the next candidate (another Endpoint or key); the key is fine.",
	},
	{
		Name: "endpoint-body-too-large", Status: []string{"413"}, Outcome: RetryElsewhere,
		Description: "413: a proxy in front of this Endpoint limits the body size; another Endpoint may take the request. Try the next candidate; the key is fine.",
	},
	{
		Name: "rate-limited", Status: []string{"429"}, Outcome: CoolingKeyModel,
		Description: "429: cool the key for this model until Retry-After (else 60 s, doubling on repeats up to 1 h). Three models within 5 minutes cool the whole key.",
	},
	{
		Name: "upstream-timeout", Status: []string{"408", "timeout"}, Outcome: RetryElsewhere,
		Description: "No answer in time: try the next key. An Attempt that used up its time is never replayed on the same key.",
	},
	{
		Name: "server-error", Status: []string{"5xx"}, Outcome: RetryElsewhere,
		Description: "5xx (Anthropic's 529 overloaded included): the Provider failed; try the next key without changing this one.",
	},
	{
		Name: "network", Status: []string{"network"}, Outcome: RetryElsewhere,
		Description: "No response at all (connection refused or broken): try the next key.",
	},
	{
		Name: "bad-request", Status: []string{"4xx"}, Outcome: FailRequest,
		Description: "Any other 4xx: the request itself was refused, so another key would fail the same way; the Caller gets the Provider's message.",
	},
}

// BillingCooling is how long built-in billing rules cool a key, in seconds.
const BillingCooling = 900

// Hosts of the Providers whose quirks have built-in rules.
const (
	hostDashScope  = "aliyuncs.com"
	hostZai        = "z.ai,bigmodel.cn"
	hostMiniMax    = "minimax.io,minimaxi.com,minimax.chat"
	hostMistral    = "mistral.ai"
	hostNous       = "nousresearch.com"
	hostOpenRouter = "openrouter.ai"
)

// Default is the compiled built-in Set.
var Default = MustCompile(Builtin)
