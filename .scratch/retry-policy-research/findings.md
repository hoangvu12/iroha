# Retry policy research

Researched 2026-08-15 with GitHub CLI against pinned upstream commits. Primary sources only.

## Executive conclusion

There is no broad ecosystem convention that generic HTTP `402` means a transient rate limit. The implementations inspected either leave it non-retryable (OpenAI SDK, Vercel AI SDK, Portkey, and LiteLLM's generic OpenAI-compatible mapping) or special-case it only inside a provider adapter that knows the provider's semantics (LiteLLM's NLP Cloud adapter).

For Iroha, the defensible policy is therefore adapter-owned classification: a generic adapter must not durably assert that every `402` means an exhausted balance. A Provider-specific Inference Adapter may classify a documented/recognized `402` as exhausted capacity, apply it at the known Capacity Scope, and rotate to an independently eligible Upstream Key or Upstream Account. If the scope is unknown, rotate for the current request and record an inconclusive/unknown-scope failure rather than permanently exhausting the key.

Ambiguous network retries are much more common: OpenAI's Python SDK, Vercel AI SDK, and Portkey retry connection failures by default. However, generic inference POSTs do not have a portable end-to-end idempotency guarantee. Iroha should expose an explicit Provider setting and may default it on only with a tight attempt cap and a clear warning/telemetry flag; safest is to retry only before response headers or stream bytes are observed. Reusing a stable request/idempotency key where the Provider supports one is an additional safeguard, not a universal proof of safety.

## Comparison

| Project | HTTP 402 | HTTP/status retries | Ambiguous network failure | Credential/deployment health |
|---|---|---|---|---|
| OpenAI Python SDK | Not retryable by the generic classifier | Defaults to 2 retries; retries 408, 409, 429, and 5xx | Retried within the same default budget | SDK has no credential pool |
| Vercel AI SDK | Not retryable by default (`APICallError`) | Defaults to 2 retries; retries 408, 409, 429, and 5xx | Explicitly wrapped as retryable | SDK has no credential pool |
| Portkey Gateway | Not in default retry statuses | Defaults are 429, 500, 502, 503, 504; configurable list | A thrown fetch/network error flows through `async-retry` | Rotation is expressed separately through load-balancing/fallback targets |
| LiteLLM Router | Generic OpenAI-compatible 402 becomes generic `APIError`; NLP Cloud alone maps 402 to `RateLimitError` | Exception-typed retry policy; deployment failures feed cooldown | Has timeout/error retry categories and router retries | Failed deployments are counted and put in temporary cooldown; no evidence here of generic 402 becoming durable billing exhaustion |

## Evidence

### OpenAI Python SDK

- At commit [`10ee3f0`](https://github.com/openai/openai-python/tree/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2), the default is two retries ([constants](https://github.com/openai/openai-python/blob/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2/src/openai/_constants.py#L9-L13)).
- `_should_retry` obeys an explicit `x-should-retry` override, then retries 408, 409, 429, and status codes >= 500. All others, including 402, return false ([classifier](https://github.com/openai/openai-python/blob/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2/src/openai/_base_client.py#L804-L851)).
- Timeout and connection exceptions consume the same retry budget before surfacing `APITimeoutError` / `APIConnectionError` ([sync request loop](https://github.com/openai/openai-python/blob/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2/src/openai/_base_client.py#L1004-L1058)).
- The client creates one retry-stable idempotency key for non-GET requests, but the base client's `_idempotency_header` is `None`; it only places the key on the wire when a concrete client configures a header ([request setup](https://github.com/openai/openai-python/blob/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2/src/openai/_base_client.py#L945-L952), [header condition](https://github.com/openai/openai-python/blob/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2/src/openai/_base_client.py#L448-L451)). Thus default POST retry behavior should not be described as universally protected by server-side idempotency.

### Vercel AI SDK

- At commit [`8d05a55`](https://github.com/vercel/ai/tree/8d05a5574aed8533df3f8e2e6a019cbf15bd4a15), `APICallError` defaults retryability to 408, 409, 429, and >=500. A 402 is therefore non-retryable unless a provider supplies an override ([error classifier](https://github.com/vercel/ai/blob/8d05a5574aed8533df3f8e2e6a019cbf15bd4a15/packages/provider/src/errors/api-call-error.ts#L23-L51)).
- The exponential-backoff helper defaults to two retries and delegates the decision to `isRetryable` ([retry helper](https://github.com/vercel/ai/blob/8d05a5574aed8533df3f8e2e6a019cbf15bd4a15/packages/provider-utils/src/retry-with-exponential-backoff.ts#L28-L60)); the AI-layer strategy respects provider retry headers and retries only errors marked retryable ([AI strategy](https://github.com/vercel/ai/blob/8d05a5574aed8533df3f8e2e6a019cbf15bd4a15/packages/ai/src/util/retry-with-exponential-backoff.ts#L50-L86)).
- Its fetch error wrapper explicitly marks recognized connection failures as retryable ([network classifier](https://github.com/vercel/ai/blob/8d05a5574aed8533df3f8e2e6a019cbf15bd4a15/packages/provider-utils/src/handle-fetch-error.ts#L31-L68)). `postToApi` is a literal POST and has no generic idempotency-header injection ([POST implementation](https://github.com/vercel/ai/blob/8d05a5574aed8533df3f8e2e6a019cbf15bd4a15/packages/provider-utils/src/post-to-api.ts#L77-L113)).

### Portkey Gateway

- At commit [`669825c`](https://github.com/Portkey-AI/gateway/tree/669825cbe89ee51569918b8f78a9db486fd69dd4), default retry statuses are exactly 429, 500, 502, 503, and 504; 402 is absent ([globals](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/globals.ts#L38-L42)).
- `retryRequest` retries only configured response statuses, but thrown fetch/network exceptions are rethrown into `async-retry` until the configured attempt limit. A non-selected response status is bailed immediately ([handler](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/retryHandler.ts#L75-L196)). It respects 429 retry headers only within a 60-second total ceiling ([handler](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/handlers/retryHandler.ts#L104-L160)).
- Separate load-balance/fallback targets are the mechanism for routing around a failing provider/account, and the first-party cookbook explicitly shows multiple provider credentials as independent targets ([cookbook](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/cookbook/getting-started/resilient-loadbalancing-with-failure-mitigating-fallbacks.md#L45-L91)). This is separate from same-target retry classification.

### LiteLLM Router

- At commit [`40a4184`](https://github.com/BerriAI/litellm/tree/40a418440c121202f57f93c64b67209971de317c), the generic OpenAI/OpenAI-compatible mapping handles 400, 401, 404, 408, 422, 429, and selected 5xx codes explicitly, then maps every other status (including 402) to generic `APIError` while preserving the status ([mapping](https://github.com/BerriAI/litellm/blob/40a418440c121202f57f93c64b67209971de317c/litellm/litellm_core_utils/exception_mapping_utils.py#L399-L488)).
- In contrast, its provider-specific NLP Cloud mapper explicitly maps both 429 and 402 to `RateLimitError` ([NLP Cloud mapping](https://github.com/BerriAI/litellm/blob/40a418440c121202f57f93c64b67209971de317c/litellm/litellm_core_utils/exception_mapping_utils.py#L1589-L1621)). This is strong precedent for keeping ambiguous status semantics in an Inference Adapter instead of the generic Gateway layer.
- Retry policy is exception-typed (authentication, timeout, rate limit, content-policy, bad-request, internal-server) rather than an all-4xx rule ([policy type](https://github.com/BerriAI/litellm/blob/40a418440c121202f57f93c64b67209971de317c/litellm/types/router.py#L89-L103), [selection](https://github.com/BerriAI/litellm/blob/40a418440c121202f57f93c64b67209971de317c/litellm/router_utils/get_retry_from_policy.py#L17-L52)).
- Router failure callbacks count failures per deployment and put deployments into a time-bounded cooldown after the allowed failure threshold ([cooldown callback](https://github.com/BerriAI/litellm/blob/40a418440c121202f57f93c64b67209971de317c/litellm/router.py#L7174-L7245)). This is temporary deployment health, not a generic durable assertion of exhausted billing.

## Implications for Iroha

1. Do not add `402` to a global generic retry/status table as though it were synonymous with `429`.
2. Let an Inference Adapter return a typed classification such as `capacity_exhausted` plus `Capacity Scope` and confidence/source. For a known MiniMax contract or a recognized MiniMax error code/body, mark the appropriate Upstream Key or Upstream Account exhausted and rotate.
3. For an unrecognized bare 402, permit one alternate-selection attempt for availability, but avoid durable `exhausted` Key Health. Record the original 402/body and classification as ambiguous so operators can diagnose it.
4. Rotation must exclude the failed key/account and should prefer an independently funded Upstream Account. Retrying the same known-unfunded key is wasteful.
5. Keep network retry separate from status retry. A reasonable default-on policy is one ambiguous retry maximum, only before headers/stream bytes, with exponential backoff and attempt history. Never restart after any response bytes were exposed to the caller.
6. Generate a stable per-Gateway-request identifier and map it to a Provider-supported idempotency header when an adapter knows one. Do not promise exactly-once inference for generic OpenAI-compatible Providers.
7. Surface the ambiguity in naming/UI: e.g. "Retry connection failures before a response (may duplicate a request)" rather than simply "network retries."
