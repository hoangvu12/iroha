# LiteLLM upstream-failure handling

Research date: 2026-09-17. Sources are the LiteLLM repository at commit
`4b368bf0669cfd3268b780eea6c69497b9a51850` (shallow clone of `main`) and the
project's own documentation at `docs.litellm.ai`. Line numbers refer to that
commit; the surrounding code can move between releases, so treat the functions
named below as the stable reference points.

This is a non-normative research record for comparing another gateway against
LiteLLM. It records observed mechanics and defaults, not a recommendation.

## Summary of defaults

| Setting | Default | Where |
|---|---|---|
| Router `num_retries` | 2 (i.e. 2 retries after the first attempt) | `litellm/router.py:1029-1034`, `litellm/constants.py:66`, `litellm/__init__.py:536` |
| Retry-triggering statuses | 408, 409, 429, `>=500` | `litellm/utils.py:6887-6913` |
| Backoff | `0.5s * 2^n`, capped at 8s, + jitter up to 0.75s | `litellm/utils.py:6950-6973`, `litellm/constants.py:458-460` |
| Provider `Retry-After` | honoured if `0 < x <= 60`, + jitter | `litellm/utils.py:6950-6963` |
| Cooldown time | 5s | `litellm/constants.py:78` |
| Allowed fails | 3 | `litellm/__init__.py:542` |
| Failure-rate threshold | 50%, min 5 requests | `litellm/constants.py:72-74`, `litellm/constants.py:135-137` |
| Max fallbacks | 5 | `litellm/constants.py:11` |
| Routing strategy | `simple-shuffle` | `litellm/router.py:768-776` |
| Request timeout (unset sentinel) | 6000s, effective fallback 600s | `litellm/constants.py:531,534` |
| Background health checks | off; interval 300s | `litellm/constants.py:1768`, `docs/proxy/health_check_routing` |

## 1. Retry logic

Retries are implemented twice: once in the Router (`Router.async_function_with_retries`,
`litellm/router.py:7755`) and once by the underlying provider SDK, which LiteLLM
configures with `max_retries` (`litellm/llms/openai/openai.py:380-381`,
`litellm/llms/openai/chat/gpt_transformation.py:166`). The Router loop is the one
that interacts with fallbacks and cooldowns.

**Count.** `Router.num_retries` is resolved at construction: explicit argument →
`litellm.num_retries` → `openai.DEFAULT_MAX_RETRIES` (2)
(`litellm/router.py:1029-1034`). The loop makes one initial attempt and then
`range(num_retries)` further attempts, so `num_retries=2` means up to **3 total
attempts per model group** (`litellm/router.py:7785-7937`). Per-deployment
`litellm_params.num_retries` and per-request `num_retries` override it; a
`RetryPolicy` can override per exception type (`litellm/router.py:7794-7830`,
`litellm/constants.py:66`).

**Which errors retry.** `litellm.utils._should_retry` returns true for status
408, 409, 429 and `>=500`; every other status, including 400/401/403/404, is
treated as non-retryable (`litellm/utils.py:6887-6913`). `should_retry_this_error`
adds the deployment-aware cases (`litellm/router.py:7991-8053`):

- `ContextWindowExceededError` / `ContentPolicyViolationError` are surfaced
  immediately when the matching fallback list is set, so the fallback path can
  handle them instead of retrying the same model.
- 401/403 are retried **only if more than one deployment exists** for the model
  group (`litellm/router.py:8040-8046`).
- A `RateLimitError` is raised instead of retried when there are no healthy
  deployments left in the group but a fallback exists.
- If no healthy deployment remains at all, the error is raised.

In the retry loop, a non-retryable error (e.g. 400 context-window exceeded)
raises out immediately rather than burning the remaining attempts
(`litellm/router.py:7907-7922`). Deployments that already returned a
non-retryable status for this request are recorded and skipped on later attempts
(`_deployment_ids_to_skip_on_retry`, `litellm/router.py:7737-7752`).

**Backoff.** `Router._time_to_sleep_before_retry` (`litellm/router.py:8119-8162`)
delegates to `litellm.utils._calculate_retry_after` (`litellm/utils.py:6950-6973`):

1. Parse `Retry-After` from the exception response headers.
2. If a provider says to wait a "reasonable" amount (`0 < retry_after <= 60`)
   that value wins, plus jitter.
3. Otherwise exponential: `INITIAL_RETRY_DELAY * 2 ** num_retries`, floored at
   the router's `retry_after` and capped at `MAX_RETRY_DELAY` (8s).
4. Add jitter: `JITTER * random()` with `JITTER = 0.75`, so up to 0.75s.

Defaults: `INITIAL_RETRY_DELAY = 0.5`, `MAX_RETRY_DELAY = 8.0`, `JITTER = 0.75`,
router `retry_after` default 0 (`litellm/constants.py:458-460`, `litellm/router.py:761`).
There is no full-jitter/decorrelated-jitter scheme; it is capped exponential plus
a small additive random term.

**Important nuance.** The Router sleeps only when it has nowhere else to go. If
another healthy deployment exists in the same model group (another key), it
returns `0` and retries instantly against a different deployment; exponential
backoff is reserved for the single/last-deployment case
(`litellm/router.py:8135-8139`). Retries are also skipped when the exception
carries a `num_retries` value from a sub-call.

## 2. Rate limit handling (429)

**Detection.** 429 is retryable via `_should_retry` (`litellm/utils.py:6906-6907`).
`RateLimitError` carries a `category` (`vendor_rate_limit` vs
`litellm_rate_limit`) and a `rate_limit_type`
(`requests`/`tokens`/`concurrent_requests`/`budget`/`max_iterations`) so callers
can distinguish an upstream 429 from LiteLLM's own limiter
(`litellm/exceptions.py:23-87,450-483`). `RouterRateLimitError` is raised when no
deployment is selectable, and carries a `cooldown_time`
(`litellm/router.py:887-910`); the proxy turns it into a `Retry-After` response
header (`litellm/proxy/common_request_processing.py:3515-3517`).

**Parsing `Retry-After`.** `_get_retry_after_from_exception_header`
(`litellm/utils.py:6916-6947`) reads the `retry-after` header, first as integer
delta-seconds, then as an HTTP-date using `email.utils.parsedate_tz`; an
unparseable value yields `-1`. It is a reimplementation of OpenAI's
`_calculate_retry_after` (cited in the docstring). Valid values up to 60s are
honoured for backoff. The provider `Retry-After` is also used as the **cooldown**
duration: cooldown priority is deployment config → response header → router
default (`litellm/router.py:8391-8412`, `litellm/router_utils/fallback_event_handlers.py:110-137`).

**Scope.** Cooldowns and retries operate per **deployment**, and each deployment
is one provider/model/key tuple with a generated `model_info.id`
(`litellm/router_utils/cooldown_handlers.py:416-478`,
`litellm/router_utils/cooldown_cache.py:130-133`). So a 429 cools down the
specific key/deployment, and the request can immediately retry a sibling
deployment in the same model group. The failure counter behind the percentage
threshold is also per deployment (`litellm/router_utils/router_callbacks/track_deployment_metrics.py`).
LiteLLM does not infer that a 429 is account-wide; any cooldown is scoped to the
deployment that returned it, and each key must fail on its own before it is
excluded.

LiteLLM's own proxy limiters (key/team/user RPM/TPM, max parallel requests,
budget) raise 429 with their own `retry-after` derived from the remaining window
(`litellm/proxy/hooks/parallel_request_limiter.py:133,166-197`).

## 3. Cooldowns / circuit breaker

LiteLLM has no explicit open/half-open/closed breaker object. The equivalent is a
per-deployment **cooldown entry with a TTL**: while the entry exists the
deployment is filtered out of healthy deployments; when the TTL expires the entry
is gone and the deployment is selectable again. That expiry is the only recovery
mechanism — the next request acts as an implicit probe (there is no separate
half-open gate for request-driven cooldowns).

**Placement.** `_set_cooldown_deployments` is called from the failure callback on
every failed request (`litellm/router.py:8422`), from the fallback path for failed
fallback deployments (`litellm/router_utils/fallback_event_handlers.py:143`), and
from routing-strategy pre-call checks when a deployment is over its RPM/TPM
(`litellm/router.py:8724`). Storage is a `DualCache` (in-memory, optionally
Redis-backed) keyed `deployment:<id>:cooldown`, written with
`ttl = cooldown_time` (`litellm/router_utils/cooldown_cache.py:96-125`). Using a
shared Redis cache makes cooldown state visible across proxy instances; the
in-memory default is process-local.

**Should it cool down.** `_is_cooldown_required` (`litellm/router_utils/cooldown_handlers.py:207-257`):
429, 401, 408 and 404 cool down; other 4xx do not; anything else (5xx, no status)
does. `APIConnectionError` strings are explicitly exempted so local connection
errors do not cool down a deployment. `_should_cooldown_deployment`
(`litellm/router_utils/cooldown_handlers.py:319-413`) then applies either the
legacy allowed-fails policy or the v2 error-rate logic:

- 429 always cools down, unless it is a single-deployment model group.
- 100% failure with at least 1000 requests in the minute cools down
  (`SINGLE_DEPLOYMENT_TRAFFIC_FAILURE_THRESHOLD`).
- More than 50% failure with at least 5 requests in the minute cools down, unless
  single-deployment (`DEFAULT_FAILURE_THRESHOLD_PERCENT`,
  `DEFAULT_FAILURE_THRESHOLD_MINIMUM_REQUESTS`).
- Any status where `_should_retry` is false cools down.

**Duration / configurability.** Router-level `cooldown_time` (default 5s),
`allowed_fails` (default 3, `litellm/__init__.py:542`), and `allowed_fails_policy`
per exception type; deployment-level overrides live in `model_info`
(`cooldown_time`, `allowed_fails`, `allowed_fails_policy`)
(`litellm/router_utils/cooldown_handlers.py:92-127,352-411`). `AllowedFails: N`
means cooldown on the (N+1)th failure. `disable_cooldowns: true` turns the whole
mechanism off (`litellm/router_utils/cooldown_handlers.py:291-293`).

**Safety net.** If every deployment in a group is in cooldown, the router does
not return "no deployments" silently: it raises `RouterRateLimitError` and the
proxy maps it to 429 with a `Retry-After` (`litellm/router.py:887-910`,
`litellm/proxy/common_request_processing.py:3515-3517`). Requests that carry no
virtual key (e.g. health checks) bypass fallback access/budget checks.

**Health-check-driven routing** is the proactive counterpart, off by default.
`enable_health_check_routing` + background health checks filter unhealthy
deployments before requests land on them; `allowed_fails_policy` controls how many
health-check failures of each type are tolerated; `health_check_ignore_transient_errors`
excludes 429/408 from routing decisions; a staleness threshold
(default `interval * 2`) discards stale health state
(`docs/proxy/health_check_routing`, `litellm/constants.py:1768-1775`,
`litellm/router.py:786-788`). When all deployments are unhealthy the filter is
bypassed rather than failing closed.

## 4. Fallbacks

Fallbacks run after retries are exhausted, in `async_function_with_fallbacks` →
`async_function_with_fallbacks_common_utils` → `run_async_fallback`
(`litellm/router.py:7625-7688`, `litellm/router.py:7369-7508`). Chains are walked
in order, and `max_fallbacks` (default 5) bounds the walk
(`litellm/router.py:7403-7406`, `litellm/constants.py:11`).

Four kinds, configured under `router_settings`/`litellm_settings` (proxy) or as
`Router(fallbacks=...)` (SDK):

- `fallbacks`: all remaining errors; the common "provider failover" case.
- `context_window_fallbacks`: `ContextWindowExceededError`; typically points at a
  larger-context model. Pre-call enforcement requires
  `enable_pre_call_checks: true`.
- `content_policy_fallbacks`: `ContentPolicyViolationError`.
- `default_fallbacks` / wildcard `{"*": [...]}`: catch-all when a group is
  misconfigured.

Configuration shape is a list of one-key maps, e.g.
`fallbacks: [{"gpt-5.6-luna": ["gpt-5.6-terra"]}]`; fallback entries may be bare
model-group names or `{"model": ..., **overrides}` to change messages/params for
that target (`docs/proxy/reliability`).

Additional mechanics:

- **Cross-provider** works because a model group can point at any provider; the
  docs show Azure → Anthropic content-policy failover.
- **Cross-model** is the normal case: one `model_name` alias failing over to
  another alias.
- **Fallback to a specific deployment id** skips the cooldown check for that
  target; useful when a whole group is rate-limited
  (`docs/proxy/reliability` §"Fallback to Specific Model ID").
- **Order-based fallbacks**: deployments with an `order` value are tried in
  ascending order before external fallbacks (`litellm/router.py:7410-7463`).
- **Weighted intra-group failover** when `enable_weighted_failover` is set
  (`litellm/router.py:7465-7476`).
- **Client-side fallbacks**: a `fallbacks` list in the request body for the
  proxy / SDK call.
- **Access/budget guards**: `enforce_fallback_model_access` and the always-on
  budget re-check (toggle `enforce_fallback_budget`) skip fallback targets the
  caller is not allowed/able to pay for (`docs/proxy/reliability`).
- **Disable** per request or per key with `disable_fallbacks: true`.
- **Observability**: `x-litellm-attempted-fallbacks` and
  `x-litellm-fallback-errors` response headers; spend logs record
  `attempted_fallbacks` and `original_model_group`
  (`litellm/router_utils/add_retry_fallback_headers.py:288-318`).

## 5. Load balancing / routing strategies

`RoutingStrategy` enum: `simple-shuffle`, `least-busy`, `latency-based-routing`,
`cost-based-routing`, `usage-based-routing`, `usage-based-routing-v2`
(`litellm/types/router.py:936-942`). Default is `simple-shuffle`
(`litellm/router.py:768-776`). Selection first filters to healthy deployments
(unhealthy/cooldown/blocked removed, `litellm/router.py:8627-8675`), then the
strategy picks one.

- **simple-shuffle**: weighted random. Weights are taken, in priority order, from
  per-model `_router_weights` scoped by deployment id, then the deployment's
  `weight`, `rpm`, then `tpm`; if none are positive it falls back to uniform
  random choice (`litellm/router_strategy/simple_shuffle.py:43-67`). This is the
  "weighted" strategy.
- **least-busy**: tracks in-flight request counts per deployment (local + Redis)
  and picks the least busy (`litellm/router_strategy/least_busy.py:150-214`).
- **latency-based-routing**: keeps per-deployment latency history keyed by the
  current minute with `RoutingArgs.ttl` default 1 hour, chooses the lowest average
  latency within a `lowest_latency_buffer`; for streaming it can use
  time-to-first-token with an optional `ttft_percentile`
  (`litellm/router_strategy/lowest_latency.py:26-30,363-481`).
- **usage-based-routing / -v2**: TPM/RPM-aware selection; v2 runs the RPM check
  inside the concurrency semaphore for correctness
  (`litellm/router.py:1323-1332`, `litellm/router_strategy/lowest_tpm_rpm_v2.py`).
- **cost-based-routing**: picks the cheapest deployment
  (`litellm/router_strategy/lowest_cost.py`).
- Beyond the enum: **custom routing strategies** (`set_custom_routing_strategy`),
  **routing groups** with per-group strategies, **tag-based routing**, and the
  beta adaptive/complexity/quality/auto routers.

Pre-call checks (`enable_pre_call_checks`, `optional_pre_call_checks`) can filter
deployments by context window, budget, affinity, and model rate limits before
selection (`litellm/router.py:2247-2302`).

## 6. Streaming

Streaming is where "seamless" is hardest, and LiteLLM does not hide all of it.

- Provider exceptions raised while iterating a stream are mapped to OpenAI types.
  Non-retriable 4xx (anything 400–499 except 429) are raised straight through;
  5xx, 429 and content-policy errors are wrapped in `MidStreamFallbackError` so
  the Router can fail over (`litellm/litellm_core_utils/streaming_handler.py:2399-2470`).
- The responses API has the same rule via `_mid_stream_fallback_eligible`
  (`litellm/responses/streaming_iterator.py:228-232`).
- The fallback wrapper re-enters the fallback chain and, if the fallback is
  itself streaming, continues yielding chunks; if it fails too, the last error is
  surfaced (`litellm/router.py:2868-2970`, `litellm/router.py:3304-3401`).
- Because response bytes may already have been sent, the Anthropic streaming path
  declines to fail over once content has been generated
  (`_anthropic_stream_should_decline_fallback`, `litellm/router.py:528-560`).
  `MidStreamFallbackError` carries `generated_content` and `is_pre_first_chunk`
  so the decision can be made.
- The proxy can send SSE keepalive comment frames (`: ping`) during idle gaps via
  per-deployment `keepalive_seconds` (clamped 1–300, client override gated by
  `allow_client_keepalive_override`) or a global
  `sse_keepalive_ping_interval_seconds`. Once the response has started pinging,
  errors arrive as SSE error frames under HTTP 200 rather than an HTTP error
  status (`docs/proxy/timeout`).
- An optional global wall-clock cap exists:
  `LITELLM_MAX_STREAMING_DURATION_SECONDS` raises `litellm.Timeout` once a stream
  exceeds it (`litellm/constants.py:87-93`,
  `litellm/litellm_core_utils/streaming_handler.py:324-336`).

## 7. Timeouts

LiteLLM enforces timeouts by passing a single value down to the provider HTTP
call; it does not define a separate connect timeout at its own layer.

- Resolution order for non-streaming: model/deployment `timeout` → request
  `timeout` → `request_timeout` → explicit `litellm.request_timeout` → 600s
  fallback (`litellm/litellm_core_utils/completion_timeout.py:32-70`).
- `litellm.request_timeout` defaults to a 6000s sentinel so "unset" is
  distinguishable; the effective unset fallback is `COMPLETION_HTTP_FALLBACK_SECONDS = 600`
  (`litellm/constants.py:525-534`).
- Router-level `timeout` is documented as the maximum for the **entire call** and
  is passed down (`docs/proxy/timeout`).
- `stream_timeout` is the streaming-specific value, documented as the maximum
  wait for the **first chunk**, used to abort a hanging provider and retry another
  model. Resolution order: request → deployment `litellm_params.stream_timeout` →
  router `stream_timeout` → per-attempt `request_timeout` → default params
  (`litellm/router.py:3996-4028`).
- Per-request `timeout` is supported; `mock_timeout=True` is the documented way
  to test timeout/fallback handling.
- Connecting, TLS and pool timeouts fall to the underlying `httpx`/provider SDK
  defaults, not to LiteLLM-specific settings.
- A caller-supplied near-zero `x-litellm-timeout` produces a 408 that
  `is_caller_timeout_408` explicitly refuses to attribute to the deployment, so a
  client cannot cool down a whole fallback chain from one request
  (`litellm/router_utils/cooldown_handlers.py:643`, `litellm/router.py:8380-8385`).

## 8. Error normalization

Providers are normalized to OpenAI-style exception types at the SDK boundary
(`exception_type`, `litellm/litellm_core_utils/exception_mapping_utils.py:2339`).
LiteLLM's exception classes subclass the corresponding `openai` exceptions, so
`except openai.RateLimitError` works against LiteLLM (`litellm/exceptions.py:10,131`).
Each carries `status_code`, a message prefixed `litellm.<Type>:`, `llm_provider`,
`model`, optional `litellm_debug_info`, and the downstream `response`
(`litellm/exceptions.py:131-150`).

At the proxy boundary the exception is converted to a `ProxyException` and the
FastAPI handler returns an OpenAI-compatible body
(`litellm/proxy/proxy_server.py:1700-1712`,
`litellm/proxy/_types.py:4005-4051`):

```json
{"error": {"message": "...", "type": "...", "param": null, "code": "429"}}
```

`provider_specific_fields` is added when present. Two message substrings are
special-cased: `"No healthy deployment available"` / `"No deployments available"`
map to code 429, and a tag-routing no-deployment error maps to 401
(`litellm/proxy/_types.py:4033-4039`). The generic unhandled handler returns a
minimal `{"error": {"message": "Internal server error", "type": "internal_server_error"}}`
with HTTP 500 (`litellm/proxy/proxy_server.py:1841-1855`), so internal failures
are deliberately not leaked.

Provider response headers are preserved on the error path when available, so
`Retry-After` and rate-limit headers reach the caller; unsafe headers are
stripped (`litellm/proxy/common_request_processing.py:3568-3598`). Successful
responses carry `x-litellm-attempted-retries` / `x-litellm-max-retries` and
`x-litellm-attempted-fallbacks` so retry/failover behavior is visible even when
the caller got a 200.

## What LiteLLM makes "seamless"

The caller-facing illusion of a single healthy endpoint comes from stacking these
pieces:

- **Same-group failover on the same public model name.** Multiple deployments
  (keys, regions, providers) share one `model_name`; a 429 on one cools that
  deployment only and the retry immediately picks a sibling with no added delay
  (`litellm/router.py:8135-8139`).
- **Automatic cross-provider failover** after retries, including dedicated
  context-window and content-policy paths, so a request that would have 400'd
  still returns a completion from a larger/more permissive model.
- **Cooldowns make the failing key invisible** for the next requests without any
  operator action, and expiry restores it automatically.
- **Health-check routing** removes broken deployments before a user request
  reaches them, with a fail-open safety net.
- **OpenAI-shaped errors and headers** so the client SDK's own retry logic and
  error handling keep working; the caller sees one consistent error contract
  regardless of upstream provider.
- **Mid-stream failover** and SSE keepalives so long or slow streams survive
  provider hiccups, subject to the "no failover after content was generated" rule.
- **Timeout unification** so a hanging provider is aborted and retried at the
  gateway rather than hanging the caller forever.

## Behaviors worth not copying blindly

- Retry-triggering statuses are hardcoded (408/409/429/5xx); there is no
  per-provider classification hook in the generic path, so a provider that uses
  403 for rate limits or 500 for a permanent misconfiguration is treated the same
  as a generic transient error.
- Backoff is capped at 8s with a fixed 0.75s additive jitter, not full jitter, so
  many workers can still synchronize.
- Cooldown state is per deployment and in-memory by default; without Redis it is
  process-local and lost on restart, and there is no durable `INVALID_AUTH` state.
- Recovery is TTL expiry with no explicit half-open probe limit — the first
  request after expiry is the probe, so a still-broken key gets a full request
  rather than a cheap one.
- An error-rate cooldown needs at least 5 requests in the minute (50% threshold)
  or 1000 requests (100% threshold) before firing, so low-traffic single-key
  setups will not benefit from the percentage logic.
- Streaming failover after content has been generated is deliberately declined,
  and enabling SSE pings early commits a 200 status before the upstream outcome
  is known.