# Retryable terminal response and transient 429 cooldown

Status: done
Blocked by: 01

## Acceptance

- [x] When the retry budget is spent on a transient condition, both the OpenAI and Anthropic routes answer `503` with `Retry-After` derived from the earliest known recovery time.
- [x] A bare upstream 429 is never returned as the terminal answer; the caller never sees a rate-limit it did not cause.
- [x] A generic 429/capacity failure applies a bounded per-key cooldown (Provider retry timing, else a 5s default) so the next round rotates keys.
- [x] The cooldown is temporary Key Health (`cooling_down`), never durable `exhausted` without authoritative Capacity Evidence.
- [x] `Retry-After` stays a plain numeric value (no upstream text).
- [x] Focused HTTP tests cover both route shapes, the cooldown, and the `Retry-After` fallback.

## Comments

`recordInferenceFailure` now narrows to the generic case (`classification` supplied, no `capacityEvidence`, scope `unknown`) and parks only the key that answered with a bounded `cooling_down`. Provider-specific 429s that carry evidence (MiniMax, Z.ai provisional) keep their existing paths, so authoritative exhaustion still needs authoritative evidence.

`startNextRound` falls back to `providers.earliestRetryAfterSeconds` when the Provider named no `Retry-After`, so a round waits out the cooldown and the recovered key is eligible again. The generic 429 test advances the app clock through `retrySleep` to exercise recovery.