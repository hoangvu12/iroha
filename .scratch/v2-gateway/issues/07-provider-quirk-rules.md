# 07: Built-in rules for every known provider quirk

**What to build:** Port every provider-quirk failure behaviour listed in `docs/research/v1-case-catalog.md` into built-in Failure Rules: DashScope entitlement and billing codes (splitting its two-meaning codes by message text), Z.ai quota codes where only chat-relevant limits count, Mistral billing 402 and per-model 429, Nous credit 404 read as billing, ModelScope email verification, DeepAI pool-spent and check-in refusals, OpenRouter, Anthropic overload, and the rest. Each rule has a test using a recorded upstream response.

**Blocked by:** 06

**Status:** done

- [x] Every provider-quirk failure case in the catalog maps to a rule and a test, or is marked not applicable with a reason
- [x] Streamed error bodies are classified the same as non-streamed ones

## Comments

**Built.** 27 new built-in rules in `internal/rules/builtin.go` (DashScope 7, Z.ai 7, MiniMax 6, Mistral 1, Nous 1, OpenRouter 1, global 4: `insufficient-quota`, `credit-balance-too-low`, `deepai-pool-spent`, `deepai-check-in-refused`) plus one generic, `forbidden-billing` (a 403 naming balance/credit/quota/payment cools the key 15 min instead of marking it invalid). Billing refusals cool the whole key for 15 min (`rules.BillingCooling`, v1's recheck interval).

**How a built-in targets a Provider.** By Endpoint host, never by handle: a rule for one service's quirk has `host` set to that service's domains (`aliyuncs.com`; `z.ai,bigmodel.cn`; `minimax.io,minimaxi.com,minimax.chat`; `mistral.ai`; `nousresearch.com`; `openrouter.ai`), matching subdomains. The Endpoint URL is configuration that already exists, so a Provider created under any handle gets its quirks with no extra setting (this removes v1's template-binding problem, FAIL-136). An Owner reaching a service through a relay overrides the rule by name with the relay host added (`host` is now a comma-separated list). Rules whose codes nothing else uses differently and that relays pass on are global; DeepAI's are global because its Endpoint is the Owner's own deepai-proxy. The models.dev brand (ticket 11) was considered, but it does not exist yet and is optional metadata; it could be added later as another match field without changing these rules.

**Engine additions** (`internal/rules/rules.go`): `host` lists; `code` prefix match (`billing_*`); `base_resp.status_code` read as a code; reset source `body:<regexp>` (DeepAI names its refill time only in the message); `Decision.Status`; `EmbeddedError` and reading a 2xx failure as the status its error stands for (Anthropic error types, OpenAI codes, Google statuses, numeric codes; else 502); an event-stream failure body is read by its first JSON data payload.

**Streamed errors** (`internal/gateway/embedded.go`, one call in `attemptChat` after the first-byte deadline is disarmed, before any relay). `embeddedError(resp, stream)` reads a stream up to its first data event (past at most 16 comment-only events) or a 2xx buffered body whole; an error there fails the Attempt (status 200 recorded, event in `failure_body`) and the budget loop moves on, otherwise the bytes are put back in front of `resp.Body`. Ticket 17's keeper (merged before this) keeps committing and sending keep-alives while the peek waits, since nothing has been written yet; if it already committed, the next candidate's stream continues in the committed response. `budget.go` now uses `decision.Status` for the Caller's status on `fail_request` and for the 5xx replay. Errors after the first chunk reached the Caller remain 17's.

**Tests.** `internal/rules/builtin_test.go`: `TestBuiltinQuirkRulesClassifyTheRecordedBodies` (67 recorded bodies, each tagged with its catalog IDs; plain, event-stream and in-a-200 forms), `TestEveryBuiltinRuleHasARecordedCase` (fails when a built-in has no case), `TestEmbeddedErrorsAreToldFromAnswers`, `TestHostListsPrefixCodesAndBodyResets`. End to end with fake upstreams on real host names (`testkit` `up.Client()` + `up.URLAt(host)`), `internal/gateway/quirks_test.go`: `TestDashScopeQuirksApplyByEndpointHostWhateverTheHandle`, `TestBillingRefusalsCoolTheWholeKeyNotTheModel`, `TestStreamedErrorBodiesAreClassifiedLikeBufferedOnes`. Below, "T:" names a subtest of `TestBuiltinQuirkRulesClassifyTheRecordedBodies`; "G:" the generic table `TestBuiltinRulesClassifyTheGenericFailures` (rules_test.go).

### Mapping: catalog case → rule / test

| Case | Rule | Test, or n/a with reason |
|---|---|---|
| FAIL-01 | `dashscope-arrearage` | T: arrearage, arrearage flat envelope, arrearage on a host that is not DashScope, both stream forms; `TestDashScopeQuirksApply...` |
| FAIL-02 | `dashscope-free-tier-spent` | T: free tier spent |
| FAIL-03 | `dashscope-model-refused`, `dashscope-model-unsupported` | T: 400 model not supported, 404 model_not_found, 404 model_not_supported, 403 Model.AccessDenied; `TestDashScopeQuirksApply...` |
| FAIL-04 | `dashscope-model-unsupported` (message regex) / `bad-request` | T: 400 invalid_parameter_error for a bad temperature; `TestDashScopeQuirksApply...` |
| FAIL-05 | `dashscope-model-access-denied` / `forbidden-account` | T: 403 access_denied naming the model, 403 access_denied by key restrictions |
| FAIL-06 | `dashscope-model-refused` | T: 403 Model.AccessDenied on a listed model (Model Gaps never consult the key's list) |
| FAIL-07 | `dashscope-data-inspection` | T: data inspection failed |
| FAIL-08 | — | n/a (c): v2 classifies the raw upstream body; no `upstream_code` re-wrapping exists |
| FAIL-09 | — | n/a: every failed Attempt stores the whole `failure_body` and headers (ticket 05) |
| FAIL-10 | `dashscope-account-standing` | T: overdue in the message only. QwenCloud's "Access to model denied" is not ported: it collides with the model refusal and was never seen at inference (script only); an Owner rule can add it |
| FAIL-11 | — | n/a: script-only region repair; regions are Endpoints (ticket 09) with keys restricted to them |
| FAIL-12 | Z.ai rules match `code` under `host` | T: Z.ai code elsewhere is a plain 429 |
| FAIL-13 | `zai-plan-billing` | T: 1113, 1309, 1314 (BigModel host) |
| FAIL-14 | `zai-usage-window`, `zai-rate-limit`, `zai-fair-use` | T: 1308, 1310, 1316, 1302, 1304, 1313 |
| FAIL-15 | `zai-usage-window` (`json:error.next_flush_time`) | T: 1308 date, 1310 Unix ms, 1308 in a 200 stream; `TestStreamedErrorBodies...`. Reset honoured in full (v2 caps at 7 days), not v1's 900 s |
| FAIL-16 | `zai-overloaded` (retry elsewhere, key unchanged) | T: 1305 overloaded |
| FAIL-17 | `zai-model-not-in-plan` → Model Gap | T: 1311. Deliberately not v1's "stop": another key's plan may include the model |
| FAIL-18 | `zai-wrong-product` → invalid | T: 1315 |
| FAIL-19 | `bad-request` | T: 1301 unsafe content |
| FAIL-20 | generic rules | T: 1001 auth, 1234 network error |
| FAIL-21 | `zai-fair-use` (1 h) | T: 1313 fair use |
| FAIL-22 | — | Ticket 17: abnormal `finish_reason` arrives after the stream is committed; not a pre-commit failure |
| FAIL-23 | `minimax-insufficient-balance` | T: 402 insufficient balance (fixture inference-402.json) |
| FAIL-24 | `minimax-rate-limit` (key, Retry-After) | T: 429 rate limit with Retry-After (fixture inference-429.json) |
| FAIL-25 | generic rules | T: bare 402, empty 429, 402 envelope on a 400 |
| FAIL-26 | — | n/a: usage reconciliation; balance polling is out of scope (spec) |
| FAIL-27 | `minimax-base-resp-*` (v1 gap) | T: base_resp 1008/1002/2049/1027 in a 200 answer; `TestStreamedErrorBodies...` (buffered 200) |
| FAIL-28 | — | n/a (c): classification runs on the raw upstream answer before any translation; ticket 13 must keep that order |
| FAIL-29 | engine reads flat envelopes | T: 402 monthly spending limit |
| FAIL-30 | `mistral-billing` (`billing_*` on 402) | T: 402 monthly spending limit, 402 spending limit as a 200 error body |
| FAIL-31 | generic rules | T: bare 402 (Mistral), billing type on a 429 |
| FAIL-32 | `rate-limited` (key+model) | T: per-model 429 |
| FAIL-33 | `bad-request` | T: 422 extra_forbidden, 400 invalid_model. The field path is in the stored `failure_body` |
| FAIL-34 | `nous-insufficient-credits` | T: 404 insufficient credits (also in a 200 stream); `TestBillingRefusalsCoolTheWholeKeyNotTheModel` |
| FAIL-35 | `nous-insufficient-credits` cools the whole key | `TestBillingRefusals...` (a second model goes to the other key) |
| FAIL-36 | generic rules | T: 404 model_not_found, credits code on a 429, bare 404 |
| FAIL-37 | — | n/a: DeepAI's `/theos` allowance is balance polling, out of scope (spec) |
| FAIL-38 | `deepai-pool-spent` (reset from the message) | T: pool spent with refill time. v1 saw it on `/theos`; v2 recognises the same body on inference |
| FAIL-39 | `deepai-check-in-refused` (retry elsewhere, key unchanged) | T: check-in refused |
| FAIL-40 | engine `statusOfType` for errors in 2xx; generic rules otherwise | T: 402 billing_error, overloaded/rate_limit_error inside a 200 |
| FAIL-41 | engine (`EmbeddedError`) | T: overloaded error event in a 200 stream, rate_limit_error inside a 200 answer, error with no status inside a 200 answer |
| FAIL-42 | `server-error` | T: 529 overloaded |
| FAIL-43 | `credit-balance-too-low` (v1 gap) | T: 400 credit balance too low |
| FAIL-44 | — | n/a (c): v2 always reads the failure body before relaying anything |
| FAIL-45 | `insufficient-quota`, `openrouter-moderation`; generic for the rest | T: 429 insufficient_quota, OpenRouter 403 moderation, OpenRouter 402 credits, OpenRouter error chunk before content; `TestStreamedErrorBodies...` |
| FAIL-46 | `unauthorized` | G: 401 |
| FAIL-47 | `forbidden-model`, `forbidden-billing`, `forbidden-account`, `forbidden` | T: ModelScope 403 email verification, 403 naming the balance; G: 403 cases |
| FAIL-48 | `rate-limited` (key+model; escalation covers key-wide) | G: 429 cases. v2 does not widen on account words; billing 429s have their own rules |
| FAIL-49 | engine | n/a as stated: v2's `body` matches the raw body (rules choose their own words); `code` reads only structured fields |
| FAIL-50 | `payment-required` (cools the whole key) | G: 402. Deliberate change from v1 (spec: 402 is key-wide) |
| FAIL-51 | `server-error` + one replay | G: 500; `TestWhenEveryAttemptFailsTheCallerGetsEachAttempt` |
| FAIL-52 | `model-not-found` (404 naming a model); else `bad-request` | G: 404 model, 404 other |
| FAIL-53 | `bad-request`; 408 → `upstream-timeout` | G: 400, 408 |
| FAIL-54 | engine `ParseReset` (HTTP dates too) | G: 429 retry-after date; `TestResetTimesAreReadInEveryCommonForm` |
| FAIL-55 | scoped rules are tried first | `TestRulesMatchOnEveryConditionAndScopedRulesComeFirst`; T: cases on other hosts |
| FAIL-56 | — | n/a (d) |
| FAIL-79 | engine + `gateway/embedded.go` | T: every "event-stream body" / "200 stream" case; `TestStreamedErrorBodiesAreClassifiedLikeBufferedOnes` |
| FAIL-118, USE-04 | — | n/a: Z.ai's quota endpoint is balance polling, out of scope; at inference every Z.ai code concerns chat |
| USE-17, USE-18 | `deepai-pool-spent`, `deepai-check-in-refused` | as FAIL-38/39. USE-20 (poll cadence) n/a: no polling |
| FAIL-131…135 | — | n/a: v2 stores the whole failure body and headers per Attempt and shows them through the API (tickets 05, 19) |
| FAIL-136 | — | n/a (c): built-ins target hosts, not templates |
| FAIL-137 | — | n/a here: the rule set is read once per Request (`budget.go`) |

FAIL-57…130 are Key States, cooling, the budget loop, planning and key tests (tickets 05, 08, 17); ticket 26 maps them.
