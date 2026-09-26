# Provisional key-scoped capacity cools down, and trials serve last

Status: Complete
Blocked by: none

## Problem

A Z.ai Request produced a 58-Attempt trail: 57 eligible Upstream Keys were
tried one at a time before one answered, most with the Provider's `1113`
(insufficient balance) and `1313`/`1308`/`1310` (fair-use and window limits).
Two separate defects let that happen.

1. **A provisional key-scoped capacity reading writes nothing.**
   `recordInferenceFailure` returns early whenever the classification carries
   Capacity Evidence that is not `authoritative`
   (`src/providers/provider-registry.ts:1744-1745`). The Z.ai adapter's
   `capacity_limited` reading is provisional by design
   (`src/inference/zai-adapter.ts:243-268`), so a structured `1313` key keeps
   `health: active` and `retryAfterAt: null`: no cooldown at all, not even the
   5 s one a bare 429 gets. Every later Request re-selects it, and every round
   inside a Request re-selects it again.
2. **A key re-entering rotation displaces a healthy key.** An `exhausted` or
   `cooling_down` key whose `retryAfterAt` has passed is eligible again as a
   one-shot controlled trial, and `resolveInference` round-robins over it in the
   same pool as untouched `active` keys. A Request therefore spends its first
   Attempts on keys already known to be out of credit, and only reaches a
   working key at the end of the eligible list.

## Acceptance

- [ ] A provisional key-scoped `capacity_limited` reading parks the key as
      `cooling_down` with a bounded `retryAfterAt`: the Provider's structured
      reset (`recheckAt`) or `Retry-After` when named, else the short default.
- [ ] The cooldown is never `exhausted`; durable exhaustion still requires
      authoritative Capacity Evidence (ADR 0013).
- [ ] The cooldown is clamped to a bounded maximum so a wild Provider reset
      cannot park a key indefinitely.
- [ ] A provisional reading for a non-key scope writes no Key Health.
- [ ] `resolveInference` serves keys with no adverse evidence before keys
      re-entering rotation on a controlled trial, and still reaches the trial
      keys when the healthy ones are excluded or none exist. Ordering only, as
      ADR 0023 requires: no key is filtered out.
- [ ] Focused tests pass: provider-registry Key Health, resolve ordering, and
      the assembled-Gateway retry trail.

## Comments

Corrects the assumption recorded in `03-transient-exhaustion-response.md` that
"Provider-specific 429s that carry evidence (MiniMax, Z.ai provisional) keep
their existing paths". Their existing path was the early return above, which is
strictly weaker than the generic path the harness spec requires: a bounded,
non-authoritative per-key cooldown so the pool rotates.

Live evidence from the reported installation: the Z.ai Provider held 63 keys
(47 `exhausted`, 14 `active`) with most keys carrying the model, and every
`1313` key sat `active` with `retryAfterAt: null` because of defect 1.

Landed 2026-09-27: the ordering half of this ticket shipped earlier as
`52cfe81` (it is what the in-flight registry change and the commit share),
and the provisional-cooldown half lands here, written by the Owner and
ported verbatim. `test/providers/key-health.test.ts` covers the named
reset, the clamp to `PAYMENT_REQUIRED_RECHECK_SECONDS`, `Retry-After`, the
short default, and the no-write rule for broader scopes; the tests fail
without the registry change and pass with it. Live production shape at
landing: 86 wasted `1313` Attempts in the four hours before, because no
cooldown was ever written.