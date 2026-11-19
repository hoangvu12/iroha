package rules

// Builtin are the Failure Rules that ship with Iroha, tried in this order
// after any rule limited to a Provider or host. Provider quirks (ticket 07)
// are added here as more entries with Provider or Host set; generic
// fallbacks stay last. Each entry is data: a match and an outcome.
var Builtin = []Rule{
	{
		Name: "unauthorized", Status: []string{"401"}, Outcome: Invalid,
		Description: "401: the Provider does not accept the key. It stays out until a test passes or its secret changes.",
	},
	{
		Name: "forbidden-model", Status: []string{"403"}, Body: `\bmodels?\b`, Outcome: ModelGap,
		Description: "403 naming a model: this key may not use this model; it keeps serving others.",
	},
	{
		Name: "forbidden-account", Status: []string{"403"}, Outcome: Invalid,
		Body:        `api.?key|credential|verif|profile|account|suspend|banned|deactivat|disabled|revoked|expired`,
		Description: "403 naming an account condition (suspended, unverified, revoked): the key itself is refused.",
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
		Name: "rate-limited", Status: []string{"429"}, Outcome: CoolingKeyModel,
		Description: "429: cool the key for this model until Retry-After (else 60 s, doubling on repeats up to 1 h). Three models within 5 minutes cool the whole key.",
	},
	{
		Name: "upstream-timeout", Status: []string{"408", "timeout"}, Outcome: RetryElsewhere,
		Description: "No answer in time: try the next key. An Attempt that used up its time is never replayed on the same key.",
	},
	{
		Name: "server-error", Status: []string{"5xx"}, Outcome: RetryElsewhere,
		Description: "5xx: the Provider failed; try the next key without changing this one.",
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

// Default is the compiled built-in Set.
var Default = MustCompile(Builtin)
