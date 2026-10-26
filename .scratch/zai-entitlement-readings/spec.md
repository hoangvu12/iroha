# Z.ai quota readings that speak for chat capacity

Status: Complete

## Problem

Post-deploy request history (2026-09-26, since 18:43 UTC) held exactly one
still-failing signature: Z.ai `glm-5.3-flash` Requests walking 6–52 Attempts
over 429ing keys (86× `1313`, 83× `1113`, 17× `1310`, 15× `1308`) before the
two working keys answered; 4 Requests failed outright on transient upstream
502s.

Two mechanisms kept dead keys in rotation. The first lives in the owner's
in-flight registry change (`.scratch/harness-turn-resilience/issues/04`):
a provisional key-scoped `capacity_limited` reading writes no Key Health, so
`1313`/`1310`/`1308`/`1302` keys never cool down at all. The second — this
feature — is the entitlement poll resurrecting keys the inference endpoint
refuses:

`zaiUsageReadings` read exactly one limit entry —
`entries.find(type === 'TIME_LIMIT') ?? entries[0]` — and named whatever it
found `positive_entitlement`. Real coding-plan bodies carry three limit
families, and the entry that binds chat is not always the one read:

- An **arrears** key (`1113` at inference) reports two `CREDIT_LIMIT` entries;
  the first is unconsumed and the second spent. The fallback read the first
  and called the key healthy.
- A **weekly-exhausted** key (`1310` at inference) reports its `TIME_LIMIT`
  (the tool-call quota for search-prime/web-reader/zread) as unconsumed while
  the binding `TOKENS_LIMIT` sits at 100%. Reading `TIME_LIMIT` as entitlement
  called the key healthy.
- Every `refreshAfterCapacityFailure` re-read the quota endpoint immediately
  after an inference refusal, so the wrong reading un-parked the key within
  seconds of it being parked. Production showed the loop: 20 keys
  `active (positive entitlement)` at 21:07–21:22 that had 429-refused at
  20:26–21:01, several with `retryAfterAt` in October.

## Decisions

- Only `CREDIT_LIMIT` and `TOKENS_LIMIT` entries speak for chat-completions
  capacity. `TIME_LIMIT` is the tool-call quota and never becomes evidence.
  Anything else is skipped rather than guessed at.
- Every capacity-bearing entry becomes its own `UsageReading`, so the shared
  reconciliation sees each window and a consumed entry dominates an
  unconsumed one regardless of the order the Provider used.
- A consumed `CREDIT_LIMIT` reading carries `balance`, and
  `zaiCapacityEvidenceOf` maps it to `credit_exhausted`; a consumed
  `TOKENS_LIMIT` reading stays `window_exhausted`. Both reconcile to durable
  exhaustion, but the reason names which one.
- An envelope whose limits are all tool-call quotas is an honest empty
  reading (`ok: true, readings: []`), not `unparseable_response`: the shape
  matched, there is just nothing that speaks for chat capacity.
- `number` never becomes a `limit` fact — on real bodies it is a plan tier
  count, not a quota size.

`TIME_LIMIT` keys are deliberately not resurrected *or* parked by the poll
when no capacity-bearing entry exists: no reading preserves the durable
state, which is the safe direction after this feature.

## Verification

- `test/usage/zai-usage-adapter.test.ts` carries the three real captured
  bodies (arrears, weekly-exhausted, healthy) as fixtures, and drives each
  through `reconcileCapacity`: the arrears and weekly bodies keep a parked
  key parked; the healthy body still reactivates one.
- Live probes of the six 429ing production keys through the fixed reader:
  `1113` keys read credit 0%, `1310`/`1308` keys read tokens 100% (parked);
  `1313` keys read healthy windows — fair-use throttling is invisible to the
  quota endpoint and remains issue 04's to fix.

## Out of scope

- The provisional key-scoped cooldown for `1313`/`1302` (owner's in-flight
  `provider-registry.ts` change, issue 04) — deploying it is the owner's
  call and this feature does not touch that file.
- Transient upstream 502s from Z.ai itself (observed interleaved with 200s on
  the two working keys).
