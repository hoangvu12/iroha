# Provider-extensible capacity reconciliation, proven with MiniMax text

Status: Complete

## Problem

MiniMax has a typed Usage Adapter but still uses the generic Inference Adapter. The Owner Refresh action runs a generic `GET /models` credential probe, treats its 2xx response as proof that a key is usable, and overwrites authoritative exhaustion with `active`. The same action polls usage twice. Background usage polling stores zero or negative capacity but does not demote active keys.

Production evidence confirms the contradiction. MiniMax keys with confirmed subscription usage of 0%, credit of 0 CNY, or negative credit remained active and continued receiving requests. MiniMax text failures included both HTTP 402 and HTTP 429; status alone cannot distinguish credit exhaustion, rolling-window exhaustion, weekly exhaustion, and transient throttling. Request history discards the Provider error code/type and sometimes leaves the parent request row as a placeholder failure even after an alternate succeeds.

## Goal

Make Routing Eligibility reflect credential acceptance, Owner intent, and authoritative text capacity. Introduce Provider-extensible evidence and shared reconciliation so MiniMax is the first concrete adapter rather than a special case in routing.

## Decisions

- Inference and Usage Adapters remain separate seams and emit compatible normalized evidence.
- One shared capacity reconciliation module derives durable Key Health, Routing Eligibility, and the next capacity check.
- Credential Evidence is `authenticated`, `rejected`, or `inconclusive`. A successful models probe establishes authentication only and never clears authoritative exhaustion.
- Authoritative usage reconciles health in both directions. Positive text capacity may activate an Owner-enabled, non-invalid key; zero or negative capacity exhausts it and removes it from key selection.
- MiniMax text capacity is key-scoped for this feature. Upstream Account removal is a separate migration decision.
- MiniMax HTTP 402 or 429 triggers reconciliation. Recent authoritative evidence (at most 60 seconds old) may be used immediately; otherwise the Gateway starts one deduplicated refresh and excludes the failed key from the current request.
- MiniMax credit `<= 0` is exhausted with no provider reset time. It is polled every 15 minutes while exhausted and immediately on Owner Refresh.
- If either applicable MiniMax five-hour or weekly text window is 0%, the key is exhausted. The advertised limiting-window timestamp schedules a recheck but does not reactivate the key.
- Exhausted subscription capacity receives a bounded safety poll no later than five minutes when the advertised boundary is farther away. A small grace/jitter prevents synchronized polling.
- Reactivation requires fresh authoritative positive capacity. A failed poll preserves prior eligibility and marks the reading stale.
- The generic Inference Adapter does not infer durable exhaustion from bare 402 or 429. It follows the generic bounded-alternate behavior owned by `.scratch/failure-classification-retries/spec.md`.
- Each attempt persists bounded, allow-listed Provider Diagnostics: HTTP status, Provider code/type, normalized classification, Capacity Scope, retry/recheck timing, and safe numeric capacity facts. Raw bodies, arbitrary messages, prompts, completions, headers, and secrets are never stored.
- A request recovered by an alternate is finalized as successful while retaining every attempt.
- The Owner UI distinguishes authoritative, unknown, stale, unsupported, and exhausted usage. It exposes useful sanitized attempt diagnostics rather than only HTTP status.

## MiniMax text behavior

### Manual Refresh

1. Probe authentication/discovery.
2. Poll entitlement exactly once.
3. Reconcile both results.
4. Return and reload one consistent Provider/key/usage view.

`authenticated + 0%` remains exhausted. `authenticated + positive capacity` becomes active unless the Owner disabled the key or authentication is durably invalid.

### Inference failure

1. The MiniMax Inference Adapter parses the allow-listed error envelope for HTTP 402 and 429.
2. Fresh authoritative capacity decides exhaustion immediately.
3. Stale or missing capacity starts one deduplicated entitlement refresh without delaying selection of an alternate eligible key.
4. Zero/negative entitlement durably exhausts the key; positive entitlement produces a temporary cooldown; unavailable evidence does not assert durable exhaustion.
5. When no eligible key remains, the Gateway returns `provider_capacity_exhausted` when exhaustion is known, otherwise the appropriate upstream/throttling error.

### Recovery

1. Exhausted keys never enter round-robin selection.
2. Subscription recovery polls near the limiting advertised boundary and through the bounded safety cadence.
3. Credit recovery polls every 15 minutes.
4. Only a fresh positive entitlement reading restores Routing Eligibility.

## Owner UI

The Usage column renders:

- `<percent>% left` for fresh authoritative subscription capacity.
- `Exhausted` for authoritative zero/negative capacity, with the limiting window or credit reason.
- `Unknown` when a Provider supports usage but has no successful reading.
- `<value> - stale` when the latest refresh failed and a prior reading is retained.
- `Not available` when no authoritative Usage Adapter exists.

Key details and request history expose HTTP status, Provider code/type, normalized classification, Capacity Scope, alternate-attempt information, evidence freshness, and retry/recheck time. They never expose raw Provider bodies or arbitrary messages.

## Verification

- Adapter contract tests cover MiniMax 402/429 parsing, credit, five-hour, weekly, positive, zero, stale, malformed, and undocumented status values.
- Reconciliation tests exercise the module interface with fake inference/usage evidence.
- Assembled HTTP tests cover Refresh, inference failover, recovery, sanitized history, and request finalization.
- UI changes are verified at the HTTP seam per `docs/agents/ui-testing.md`; no JS-DOM harness is introduced.

## Out of scope

- Non-text MiniMax quotas.
- Removing Upstream Account persistence and UI.
- Generic authoritative usage for Providers that expose no entitlement surface.
- Storing raw Provider response bodies or arbitrary upstream messages.

## Research evidence

- MiniMax documents a five-hour rolling text window, a weekly window, and a Token Plan remains endpoint. It does not publicly document the entitlement status-number enum.
- Live verification showed `GET /models` succeeding while entitlement reported 0% and a one-token `MiniMax-M3` request returned HTTP 429.
- Recent production history contained 97 MiniMax HTTP-402 attempts; many recovered through an alternate, while the five recurring 402 keys currently had zero/negative authoritative capacity.
- LiteLLM and Portkey avoid universal durable 402 semantics. One API and New API retry 402 generically but use body/balance evidence for durable disabling.
