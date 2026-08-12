# Gateway routing comparison for Iroha

Research date: 2026-08-12. Sources are project-owned documentation and repository code. OmniRoute was inspected with the GitHub CLI at its default `release/v3.8.50` branch, as requested.

This is a non-normative research record. Where its preliminary recommendations differ from the confirmed design, `docs/design/iroha-v1.md` is authoritative.

## Executive conclusion

Iroha should be a generic, self-hosted OpenAI-compatible gateway, not a Nyanis integration. Persist provider connections, credentials, models, downstream API keys, and routing policy in a database because the UI is a primary management surface. Optionally support import/export later; do not make a hand-edited YAML file the second source of truth.

Address exact upstream models through a provider-scoped URL such as `/providers/{provider_id}/v1/...`; forward the body `model` unchanged. This eliminates collisions without inventing aliases. It also works with the OpenAI SDK because its `base_url` is configurable. Keep a conventional `/v1/...` route only if the model resolves to exactly one enabled provider; reject ambiguity rather than silently choosing.

For several keys on one provider connection, use round-robin among currently eligible keys. Random selection provides no meaningful benefit at this scale and makes incidents harder to reproduce. Retry only errors plausibly repaired by changing credentials or transient capacity, cap attempts, and never switch keys after response bytes have been sent.

## Comparison

| Concern | OmniRoute | LiteLLM Proxy | Portkey Gateway | Lesson for Iroha |
|---|---|---|---|---|
| Provider/model addressing | Direct examples use provider-prefixed model IDs such as `cc/claude-opus-4-6`; it also exposes virtual `auto` and combo model IDs. Provider connections and registry models are distinct concepts. [API reference](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md), [Auto-Combo](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/routing/AUTO-COMBO.md) | SDK calls use provider-qualified names (`openai/gpt-5`), while Proxy `model_name` is a public alias that maps to one or more deployments. Multiple deployments sharing one `model_name` form a routing pool. [Getting started](https://docs.litellm.ai/) | Provider is conveyed separately (`provider="openai"` / `x-portkey-provider`) while `model` remains native; routing configs can name provider/model targets. [Gateway README](https://github.com/Portkey-AI/gateway/blob/main/README.md) | Since exact model names must be preserved, scope the URL/base URL by provider rather than overload `model`. |
| Configuration/control plane | UI-first: provider connections are added in the dashboard, backed by persistent DB records; combos and settings have management APIs. [Providers guide](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/getting-started/PROVIDERS-GUIDE.md), [API reference](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md) | Supports declarative `config.yaml` (`model_list`, router settings) and a database-backed gateway/control plane for virtual keys, spend and UI management. [Proxy quick start](https://docs.litellm.ai/) | The open-source data plane accepts routing config per request/header; its local console focuses on logs. Broader organization/key control-plane features are described separately. [Gateway README](https://github.com/Portkey-AI/gateway/blob/main/README.md) | A UI means DB-authoritative runtime state. Add a transactional import/export format, not simultaneous live YAML ownership. |
| Multiple keys / load balancing | Extra keys on a connection are selected by in-memory round-robin; invalid keys are skipped. Auth failures accumulate health state and terminal balance failure can invalidate immediately. Selection can remain sticky during an ongoing request. [Key rotator source](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/open-sse/services/apiKeyRotator.ts) | A shared public `model_name` can contain multiple deployments/keys; router strategies include usage-, latency-, cost-, and rate-limit-aware choices rather than merely random choice. [Router docs/index](https://docs.litellm.ai/docs/routing) | Load-balancing configs distribute requests across keys/providers with explicit weights. [Gateway README](https://github.com/Portkey-AI/gateway/blob/main/README.md) | Begin with round-robin eligibility. Later add weights/quotas, keeping selection policy replaceable. |
| Retry/cooldown/failover | Has layered connection cooldown, provider breakers, upstream retry hints, budgets, and bounded retry counts; current defaults in source include five cooldown retry cycles and a total time budget. [Resilience settings](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/src/lib/resilience/settings.ts) | Router exposes bounded retries/fallbacks, allowed-failure thresholds, cooldowns, and error-specific fallback policy. Its cooldown handler tracks failures rather than treating every response equally. [Cooldown handler](https://github.com/BerriAI/litellm/blob/main/litellm/router_utils/cooldown_handlers.py), [Router types](https://github.com/BerriAI/litellm/blob/main/litellm/types/router.py) | Retry attempts are configurable (README example: 5), use exponential backoff, and fallbacks can specify triggering errors. [Gateway README](https://github.com/Portkey-AI/gateway/blob/main/README.md) | Do not “retry every error on every key.” Classify, cap, and cooldown. Separate same-provider key retry from future cross-provider/model fallback. |
| OpenAI compatibility | Implements a broad compatibility surface: chat, responses, embeddings, images, audio, models, files, batches, and streaming/WebSockets, with translation for non-OpenAI providers. [API reference](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md) | Documents translation for chat, responses, embeddings, images, audio, batches and more; output and mapped exceptions follow OpenAI shapes, and streaming is supported. [Getting started](https://docs.litellm.ai/) | Supports chat plus multimodal audio/image APIs using familiar OpenAI signatures, streaming, and OpenAI SDKs; provider coverage is endpoint-dependent. [Gateway README](https://github.com/Portkey-AI/gateway/blob/main/README.md) | “Fully compatible” is a tested endpoint/field matrix, not transparent `/v1/*` forwarding. Publish supported endpoints and provider capability gaps. |
| Downstream keys and UI | `/v1/*` can require gateway bearer keys; dashboard sessions and management-scoped keys are separate. The repo contains dashboard provider/key/health management. [API authentication](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/reference/API_REFERENCE.md) | Virtual keys, budgets, rate limits, projects/teams, and an admin dashboard are central Proxy features. [Getting started](https://docs.litellm.ai/) | Secure key management/virtual keys and RBAC are advertised, but some richer control-plane features belong to hosted/enterprise offerings; the OSS console is local observability-oriented. [Gateway README](https://github.com/Portkey-AI/gateway/blob/main/README.md) | Store only hashes of Iroha API keys, reveal plaintext once, support name/revoke/last-used initially, and keep admin-session auth separate from inference-key auth. |

## Recommended first design

### Addressing and collision policy

Canonical inference base URL:

```text
http://localhost:PORT/providers/{provider_id}/v1
```

An OpenAI client sets that as `base_url`; all endpoint suffixes and the request's `model` value stay OpenAI-shaped. `{provider_id}` identifies an owner-configured provider connection, not a provider brand. This matters because the owner may configure two OpenRouter accounts or two OpenAI-compatible servers with different keys and base URLs.

Optionally expose `/v1/...` as convenience routing only when `(endpoint, exact model)` maps uniquely. If zero targets match, return a normal not-found model error. If several match, return a deterministic `409 ambiguous_provider` with the candidate provider IDs and the scoped URL form. Do not pick by insertion order.

### Persistence and UI

Use one database as the authoritative store for:

- provider connections: stable ID, display name, protocol adapter, base URL, enabled state;
- exact upstream models/capabilities per connection;
- encrypted upstream credentials and their health/cooldown state;
- hashed downstream Iroha API keys, label, status, created/last-used timestamps;
- retry/timeout policy and an audit trail of owner changes.

The UI calls an admin API; the inference path reads the same persisted model through a cached snapshot/version. Secrets should not be returned to the browser after creation. A config export should omit secrets by default and imports should be validated then committed atomically.

### Key-selection policy

Round-robin is the best v1 default because it evenly spreads requests, is deterministic enough to debug, and does not require quota telemetry. Selection must be atomic per connection under concurrency. Random selection only approximates equal distribution over time and makes short-window bursts and reproduction worse. “Use one until failure” concentrates rate limits and wastes available quota.

Eligibility should precede selection: enabled, not permanently invalid, not in cooldown, and under any configured concurrency cap. A successful call clears transient failure count. Preserve the selected key for the life of one request/stream.

### Retry classification and caps

Suggested safe initial policy:

| Result | Try another key? | Key state |
|---|---:|---|
| `401` / invalid credential | Yes | Disable that key until owner retests/edits it. |
| `403` | Usually no by default | Provider meanings vary; classify with adapter-specific rules before calling it credential failure. |
| `402` / exhausted balance (where provider-defined) | Yes | Disable or long cooldown until owner action. |
| `429` | Yes | Cool down using `Retry-After` when valid, otherwise bounded exponential backoff with jitter. |
| timeout, connection reset, `502/503/504` before headers | Yes | Short transient cooldown. |
| other `5xx` | Configurable, yes by default for one alternate key | Short cooldown; preserve upstream error when exhausted. |
| `400`, `404`, `409`, `422` request/model errors | No | Another key does not repair the request. |

Make `max_attempts` configurable, counting the original attempt. Default to `min(2, eligible_key_count)` (one alternate key), with a small hard safety ceiling such as 4. Also enforce a total retry time budget. Never retry after any response body bytes have been emitted; streaming can only fail over before the downstream stream starts. Do not retry non-idempotent endpoints unless an endpoint-specific idempotency strategy exists.

### Meaning of OpenAI compatibility

Treat compatibility as a maintained matrix of endpoints and semantics. A sensible implementation order is:

1. `/v1/models`, `/v1/chat/completions`, streaming/tool calls/structured output;
2. `/v1/responses` and its streaming events;
3. embeddings, images, audio, moderations and other endpoints according to provider capabilities;
4. files/batches/vector stores only when lifecycle semantics can actually be preserved.

Unknown `/v1/*` endpoints should return a clear unsupported-endpoint response, not be forwarded blindly. Provider adapters should declare endpoint and feature capabilities so the UI and `/v1/models` do not promise unsupported behavior.

## Decisions this research supports

- Generic standalone Iroha, with no Nyanis dependency in v1.
- Provider-connection ID in the URL; exact `model` string forwarded unchanged.
- Database/control-plane configuration because the product includes a management UI.
- Round-robin among eligible keys, not random or use-until-failure.
- Error-classified, budgeted retry with configurable caps; conservative default of one alternate key.
- Owner-created downstream API keys with hash-only storage and separate admin authentication.
- “Full OpenAI compatibility” pursued endpoint-by-endpoint with conformance tests and an explicit capability matrix.

## Second pass: multi-key health and recovery (2026-08-12)

This pass inspected current project documentation and source with `gh`, concentrating on whether key health is request-local, process-local, or durable.

### What established gateways actually do

| Behavior | OmniRoute | Bifrost | LiteLLM |
|---|---|---|---|
| `401` / `403` | Its key rotator counts authentication failures per key, marks a key warning and then invalid after a threshold, skips invalid keys, and exposes manual reset. Health can be synchronized from/persisted into provider connection data. `403` is treated alongside auth failure in its surrounding retry path, but providers can use `403` for policy/permission failures as well as bad credentials. [Key rotator source](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/open-sse/services/apiKeyRotator.ts) | Classifies `401/403` as permanent per-key failures, rotates immediately without backoff, and never reuses that key for the remainder of that request. Crucially, the dead-key set is request-local: a future request tries the key again. [Retries and fallbacks](https://github.com/maximhq/bifrost/blob/dev/docs/features/retries-and-fallbacks.mdx) | Maps provider errors to typed OpenAI-style exceptions and tracks deployment failures/cooldowns after an allowed-fail threshold; routing excludes deployments currently in cooldown. [Error mapping](https://docs.litellm.ai/), [cooldown handler](https://github.com/BerriAI/litellm/blob/main/litellm/router_utils/cooldown_handlers.py) |
| `429` / `Retry-After` | Has connection cooldown profiles, optional upstream retry hints, bounded cooldown waits, circuit breakers, and configurable minimum/maximum provider cooldowns. [Resilience settings](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/src/lib/resilience/settings.ts) | Rotates away from the rate-limited key but still backs off with exponential jitter because keys may share account-level limits. Its ordinary retry implementation documents fixed configurable backoff bounds rather than relying on `Retry-After`; its separate enterprise circuit breaker can read a configured cooldown header, fall back to a static duration, and probe after expiry. [Retries](https://github.com/maximhq/bifrost/blob/dev/docs/features/retries-and-fallbacks.mdx), [circuit breaker](https://github.com/maximhq/bifrost/blob/dev/docs/enterprise/circuit-breaker.mdx) | Cooldown records contain status, timestamp, and duration; the router skips cooled deployments. Router configuration includes cooldown duration and allowed-failure behavior. The source remains the authoritative detail because behavior has changed across releases. [Cooldown handler](https://github.com/BerriAI/litellm/blob/main/litellm/router_utils/cooldown_handlers.py), [router types](https://github.com/BerriAI/litellm/blob/main/litellm/types/router.py) |
| Balance/quota/plan exhaustion | Distinguishes terminal conditions: its key rotator can invalidate immediately for `402`/insufficient balance. OmniRoute also has provider-specific quota/usage services and preflight policy rather than pretending one generic balance API exists. [Key rotator](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/open-sse/services/apiKeyRotator.ts), [quota usage guide](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/guides/USAGE_QUOTA_GUIDE.md) | Treats `402` as a permanent failure for the current request and rotates without waiting; the same key is reconsidered by the next request because ordinary health is not persisted. [Retries](https://github.com/maximhq/bifrost/blob/dev/docs/features/retries-and-fallbacks.mdx) | Provider failures enter its normal typed-error/cooldown system. LiteLLM's gateway can track *proxy-observed* spend and budgets, but those are not the same as authoritative upstream account balance. [Getting started](https://docs.litellm.ai/) |
| Recovery/probing | Invalid auth/balance key health is durable enough to be restored from connection data and can be reset by an owner; transient recovery is governed by layered cooldown/breaker settings. [Key rotator](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/open-sse/services/apiKeyRotator.ts), [resilience settings](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/src/lib/resilience/settings.ts) | Request-local key failure state disappears after the request. The separate circuit breaker uses open → cooldown → next-request probe behavior, including per-key sub-circuits, but that feature is documented as enterprise. [Circuit breaker](https://github.com/maximhq/bifrost/blob/dev/docs/enterprise/circuit-breaker.mdx) | Deployment cooldown expires based on stored timestamp/duration, after which routing can select it again; distributed/shared cache configuration determines whether instances share this state. [Cooldown handler](https://github.com/BerriAI/litellm/blob/main/litellm/router_utils/cooldown_handlers.py) |
| Persistence across restart | Rotation index is explicitly in memory and resets; key health is designed to sync to/from DB-backed provider-specific data. [Key rotator](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/open-sse/services/apiKeyRotator.ts) | Ordinary per-key dead/used sets are explicitly per request, so there is no unhealthy-key persistence to survive restart. [Retries](https://github.com/maximhq/bifrost/blob/dev/docs/features/retries-and-fallbacks.mdx) | Cooldown state is cache-backed; local in-memory cache is process-bound while a shared cache can coordinate router instances. Durable operator configuration and dynamic cooldown health should be considered separate lifecycles. [Cooldown handler](https://github.com/BerriAI/litellm/blob/main/litellm/router_utils/cooldown_handlers.py) |
| Proactive polling | Provider-specific fetchers and quota windows feed routing/preflight decisions; support necessarily differs by provider/auth type. [Quota guide](https://github.com/diegosouzapw/OmniRoute/blob/release/v3.8.50/docs/guides/USAGE_QUOTA_GUIDE.md) | The OSS retry design shown here is reactive to request failures; no generic provider-balance poller is part of its documented retry/key rotation contract. [Retries](https://github.com/maximhq/bifrost/blob/dev/docs/features/retries-and-fallbacks.mdx) | Health checks can validate that a deployment answers, and the proxy meters what passes through it; neither implies access to an upstream billing/plan API. [Proxy docs](https://docs.litellm.ai/) |

### Can a generic gateway query balances reliably?

No. A generic OpenAI-compatible inference contract does not define account balance, remaining credits, subscription plan, rate-limit window, or key status endpoints. Even HTTP meanings are inconsistent: `402` is not universally used, `403` may mean revoked credentials, missing model entitlement, geography/policy denial, or organization permission, and a `429` may apply to a key, organization, project, model, or shared account.

Balance/usage polling therefore requires a provider-specific adapter with all of the following declared explicitly:

- endpoint and authentication scheme (often different scopes from inference);
- units and windows (currency, credits, tokens, requests, daily/monthly/rolling);
- whether the result is key-, project-, organization-, subscription-, or account-scoped;
- refresh interval and rate limits for the usage endpoint itself;
- confidence/freshness and whether remaining capacity is authoritative or estimated.

For generic OpenAI-compatible custom providers, Iroha should expose `usage_visibility: reactive_only`. It may learn from response status/headers and proxy-observed usage, but must not claim authoritative remaining balance. Optional adapters can provide `usage_visibility: polled` when the upstream has a documented API. Owner-entered budget limits are another distinct mode: `configured_budget`, not upstream balance.

### Recommended Iroha key state machine

Persist durable operator-relevant state, but keep high-frequency counters/cooldowns in a shared runtime store when available. A single-node installation may use the main DB for both initially.

```text
ACTIVE
  ├─ 429 / transient capacity ──> COOLDOWN(until, reason, scope)
  ├─ timeout / 5xx threshold ───> COOLDOWN(short, transient)
  ├─ 401 confirmed ─────────────> INVALID_AUTH
  ├─ 403 unknown ───────────────> SUSPECT_PERMISSION
  ├─ provider-confirmed balance > EXHAUSTED(until? or manual)
  └─ owner disables ────────────> DISABLED

COOLDOWN -- deadline reached --> HALF_OPEN
HALF_OPEN -- one probe success -> ACTIVE
HALF_OPEN -- same failure -----> COOLDOWN(longer, capped)

SUSPECT_PERMISSION -- adapter says credential invalid --> INVALID_AUTH
SUSPECT_PERMISSION -- model-specific denial -----------> ACTIVE key,
                                                         block only that target
INVALID_AUTH / EXHAUSTED / DISABLED -- owner retest/edit or authoritative
                                      adapter recovery --> ACTIVE
```

State meanings:

- `ACTIVE`: eligible for round-robin selection.
- `COOLDOWN`: skipped until `next_probe_at`; preserve normalized reason, upstream status, attempt count, and scope.
- `HALF_OPEN`: allow one in-flight probe only; other traffic continues to skip the key.
- `SUSPECT_PERMISSION`: temporarily skip the failing provider/model tuple, not necessarily the whole key. `403` is too ambiguous for immediate global invalidation without adapter knowledge.
- `INVALID_AUTH`: durable and globally skipped; normally produced by `401` or adapter-confirmed invalid credential. Recovery requires owner edit/retest or an adapter with an authoritative validation endpoint.
- `EXHAUSTED`: durable or deadline-based depending on an adapter-confirmed reset time. Never infer a permanent account state from an arbitrary error-message substring alone.
- `DISABLED`: explicit owner choice, never auto-recovered.

### Transition and retry rules

1. Normalize failures through a provider adapter, returning `{category, scope, retryable, retry_after, confidence}`. The generic fallback uses conservative HTTP defaults.
2. Parse standard `Retry-After` as either delta-seconds or HTTP-date; adapters may additionally parse provider headers such as `retry-after-ms` and rate-limit-reset timestamps. Clamp every derived delay to owner-configured minimum/maximum bounds and add jitter where many workers could probe together.
3. On `429`, mark the affected scope (`key`, `account`, `provider+model`, or unknown). Rotating keys only helps when the limit is key-scoped; for unknown scope it is acceptable to try one alternate, then cool the connection rather than stampeding all keys.
4. On `401`, immediately stop selecting that key for the current request. Persist `INVALID_AUTH` after one unambiguous invalid-credential response; an optional two-strike threshold may protect poorly behaved custom providers, but must not repeatedly spray a known-bad key.
5. On `403`, try at most one eligible alternate if policy permits, record the target-specific failure, and require adapter evidence before globally invalidating the credential.
6. On quota/balance exhaustion, only set durable `EXHAUSTED` when a provider adapter recognizes a structured code/status or an authoritative poll confirms it. Otherwise apply a bounded cooldown and surface the uncertainty in the UI.
7. Default request budget remains one alternate key (`max_attempts = 2` total), constrained by a total time budget. Key state prevents obviously unhealthy candidates from consuming that budget.
8. Persist `INVALID_AUTH`, `EXHAUSTED`, `DISABLED`, last failure/success, and owner actions. Persist `COOLDOWN`/`next_probe_at` too so restart does not cause a thundering herd; expired cooldowns restore as `HALF_OPEN`, not unrestricted `ACTIVE`.
9. Probes should be real low-cost supported operations when possible (provider model-list/health endpoint or minimal inference), rate-limited globally, and never run continuously for every key. Manual “Test key” in the UI is an explicit probe and should display which capability was tested.

### Revised recommendation

Use OmniRoute's durable skip/reset idea, Bifrost's crisp per-error request behavior, and LiteLLM's deployment cooldown separation—but make scopes and persistence explicit. The most important correction to a simplistic design is: **do not treat every `403` as an invalid key, and do not assume rotating on every `429` escapes an account-wide limit**. Provider adapters improve classification; the generic engine remains conservative and honest about what it cannot know.
