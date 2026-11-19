# 31: Idempotency key per Request and a pause before a same-key replay

**What to build:** Two retry-hygiene behaviours v1 had and v2 lacks (catalog REQ-18, FAIL-94, FAIL-83, TIME-09):

1. When the Caller sends no `Idempotency-Key`, mint one per Request (in `newExchange`) and send the same value on every Attempt (`outbound`, `internal/gateway/attempt.go`); a Caller's own value is forwarded unchanged. Providers that honour it then never bill a replayed Attempt twice.
2. A 5xx key+Endpoint pair is replayed once, last (`budget.go`), with no pause, so with one key a 503 is replayed at once. Before a replay Attempt, wait min(250 ms × 2^(n−1) with jitter, the answer's `Retry-After` capped, the time left before the first-byte deadline) on the injected clock, ending early when the Caller leaves.

**Blocked by:** none

**Status:** done

- [x] `budget_test.go`: 500 then 200 on two Attempts carry the same minted key; a Caller value wins
- [x] Fake-clock test: one key, 503 then 200; the replay arrives only after the clock advances
- [x] Skill text (`20_gateway.md`) says what is sent

## Comments

- Owner decision (2026-11-19): build both parts.
- Built (agent/t31). `newExchange` mints a UUID when the Caller sent no `Idempotency-Key`; `attempt` sets it on every Attempt after `outbound` (key tests send none). A 5xx replay is queued with a `notBefore` time (failure + pause) and `serve` sleeps on the injected clock until then; the Caller leaving ends the pause as `caller_gone`. Tests: `gateway TestEveryAttemptOfARequestCarriesTheSameIdempotencyKey`, `TestAReplayOnTheSameKeyWaitsFirst`, `TestACallerLeavingDuringTheReplayPauseEndsTheRequest`.
- Reading of the formula: "min" over the three terms would let `Retry-After` only shorten the wait, which contradicts the catalog (FAIL-83: "a larger Retry-After wins"). Built as v1 did: the jittered backoff (up to 8 s), or `Retry-After` (or `Retry-After-Ms`) when it asks for longer, up to 60 s; then the first-byte deadline caps it. A replay that could only start at or after the deadline is not made, so the Caller gets the 502 at once instead of waiting out the budget for a guaranteed 504.
- The pause is counted from the failure, so time spent trying other keys counts towards it.
- Seven existing tests replay a 5xx and would now wait on the fake clock; they call the new `srv.SkipShortWaits(time.Second)` (testkit), which moves the fake clock to timers due within a second. New tests by other tickets that replay a 5xx need the same (see architecture.md "Ticket 31").
