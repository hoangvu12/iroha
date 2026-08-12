# 10 — Scoped retries and durable Key Health

**What to build:** Iroha classifies upstream failures, applies them at the affected Capacity Scope, persists explainable Key Health, performs safe bounded retries, and recovers capacity cautiously.

**Blocked by:** 07 — Streaming Chat Completions; 09 — Round-robin key pools and Upstream Accounts.

**Status:** done

- [x] Key Health persists Unverified, Active, Cooling Down, Invalid Authentication, Exhausted, and Disabled by Owner with reason and timing metadata.
- [x] Capacity Scope distinguishes key, Upstream Account, connection-and-model, Provider-wide, and unknown limits.
- [x] Confirmed authentication and exhaustion failures remove the affected credential/scope and rotate immediately where another candidate is eligible.
- [x] Ambiguous `403` affects only the target unless an adapter supplies stronger evidence.
- [x] Unknown-scope `429` respects bounded reset/backoff, tries at most one alternate, and avoids stampeding the pool.
- [x] Explicit retryable server responses reuse the same key with bounded backoff; validation errors do not retry.
- [x] Ambiguous timeout/reset retry is disabled by default and configurable at the connection level.
- [x] Retries stop at candidate exhaustion, configured attempt maximum, total time budget, cancellation, or downstream stream start.
- [x] Cooldown expiry permits one controlled real trial; authoritative recovery or manual Test can also restore eligibility.
- [x] When no key is eligible, callers receive HTTP 503, stable `upstream_credentials_unavailable`, request ID, and `Retry-After` when known.
- [x] HTTP and deterministic state tests cover every transition, scope, retry boundary, restart, and concurrent controlled-trial case.
