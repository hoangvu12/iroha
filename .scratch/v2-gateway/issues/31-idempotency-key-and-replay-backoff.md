# 31: Idempotency key per Request and a pause before a same-key replay

**What to build:** Two retry-hygiene behaviours v1 had and v2 lacks (catalog REQ-18, FAIL-94, FAIL-83, TIME-09):

1. When the Caller sends no `Idempotency-Key`, mint one per Request (in `newExchange`) and send the same value on every Attempt (`outbound`, `internal/gateway/attempt.go`); a Caller's own value is forwarded unchanged. Providers that honour it then never bill a replayed Attempt twice.
2. A 5xx key+Endpoint pair is replayed once, last (`budget.go`), with no pause, so with one key a 503 is replayed at once. Before a replay Attempt, wait min(250 ms × 2^(n−1) with jitter, the answer's `Retry-After` capped, the time left before the first-byte deadline) on the injected clock, ending early when the Caller leaves.

**Blocked by:** none

**Status:** ready-for-agent

- [ ] `budget_test.go`: 500 then 200 on two Attempts carry the same minted key; a Caller value wins
- [ ] Fake-clock test: one key, 503 then 200; the replay arrives only after the clock advances
- [ ] Skill text (`20_gateway.md`) says what is sent

## Comments

- Owner decision (2026-11-19): build both parts.
