# Harness turn resilience: keep trying transient failures

Status: In progress

## Goal

A harness turn (opencode, zeron, or any OpenAI/Anthropic-compatible caller) must not end because of a recoverable upstream disruption. Iroha absorbs transient failures inside the Request and keeps trying eligible Upstream Keys until it succeeds or its total retry budget is spent. When the budget is spent, Iroha answers with a clearly retryable status and Provider retry timing so the caller's own retry loop can continue the turn instead of halting.

Observed trigger: an OpenAI-compatible harness stops a turn after a bounded number of retries (opencode 1.18.x retries 5 times, ~60s without headers, then halts). Any transient failure Iroha passes through becomes a stopped turn. The gateway is the only layer that can keep trying beyond the caller's budget.

## Invariant

No transient condition may surface as a terminal response that ends a harness turn:
- capacity / rate limit (429, provider capacity codes),
- Provider failure (5xx),
- unreachable connection / transport failure.

Only genuinely terminal conditions end a Request: model unroutable, Provider archived/disabled, Gateway authorization, and a request the Provider rejects as malformed.

## Decisions

- Same-key retries use exponential backoff with jitter instead of a fixed sleep, and honor Provider-supplied retry timing (`Retry-After`, structured reset) when present.
- A Request revisits the eligible Key pool in rounds. Attempted-key exclusion is per round, not per Request. A new round begins only when the classification stays transient, at least one key exists, and the total retry budget allows.
- `retryMaxAttempts` bounds same-key attempts per key (1..5). `totalRetryTimeoutMs` bounds total wall time across retries and rounds; the default rises from 30s to a value that outlives a caller's own retry budget.
- A generic 429/capacity failure applies a bounded, non-authoritative per-key cooldown (duration = Provider retry timing, else a short default) so the pool rotates. This is a temporary cooldown, not durable exhaustion; durable exhaustion still requires authoritative Capacity Evidence (ADR 0013).
- Terminal transient exhaustion answers `503` with `Retry-After` in both the OpenAI and Anthropic routes. A bare upstream 429 is never passed through as if the caller were throttled.
- No retry or replay happens after any response byte has been exposed to the caller.
- Rounds never exceed the caller's request timeout: Iroha holds a request, it does not park it indefinitely.

## Non-goals

- Cross-provider or cross-model failover (ADR 0006, ADR 0023 keep model identity exact).
- Fixing caller-side model discovery; that is a separate harness issue (`iroha/...` model dropped when `/v1/models` is slow). Handled downstream: the `opencode-models-discovery` plugin now reuses its last-good inventory when a cache refresh fails, in the fork branch `hoangvu12/opencode-models-discovery#fix/stale-cache-fallback`.
- Making unknown-scope 402 durably exhaust a key (`.scratch/failure-classification-retries`).

## Test seam

`test/http/inference-retries.test.ts` and the Anthropic-route equivalents. UI stays covered at the HTTP seam per `docs/agents/ui-testing.md`.

## Research

- `.scratch/retry-policy-research/findings.md`
- `.scratch/failure-classification-retries/spec.md`
- `docs/research/litellm-upstream-failure-handling.md`