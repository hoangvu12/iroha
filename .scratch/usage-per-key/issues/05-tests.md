# 05 — Tests: per-key coverage and back-compat

**What:** Existing tests assert the new `keyId` field where it shows up;
new tests cover the per-key happy path, the partial-failure path, the
rate-limit aggregation, the durable snapshot shape, and the two legacy
back-compat shapes.

**Status:** done

- [x] `test/usage/usage-service.test.ts` › "each eligible Upstream Key
      is polled and tagged with its keyId" (multi-key happy path).
- [x] `test/usage/usage-service.test.ts` › "a partial failure keeps
      the successful key's reading and records the failure at the
      connection level" (partial failure).
- [x] `test/usage/usage-service.test.ts` › "a rate-limited key
      surfaces 429 with the most restrictive retryAfter" (rate-limit
      aggregation).
- [x] `test/usage/usage-service.test.ts` › "the snapshot's result is
      keyed by Upstream Key id after refresh" (durable shape).
- [x] `test/usage/usage-service.test.ts` › "reads the legacy
      single-reading snapshot as a one-element list" (legacy
      single-reading back-compat).
- [x] `test/usage/usage-service.test.ts` › "reads a legacy flat-list
      snapshot and re-homes it on the next refresh" (legacy flat-list
      back-compat and re-home on next refresh).
- [x] `test/http/usage.test.ts` › "each reading carries the keyId of
      the Upstream Key that fetched it" (HTTP round-trip with two
      keys).
- [x] Test fixture helpers and adapter stubs that build `UsageReading`
      objects inline updated to include `keyId: null` (two places).

## Pre-existing failures not in scope

- `test/http/providers.test.ts`: 4 tests about upstream-key health
  verdict mapping (`inconclusive`/`rejected` should demote health
  per `docs/adr/0007-test-verdict-demotes-upstream-key.md`). These
  fail on `main` without the per-key change; they belong to a
  separate ticket. **Resolved in this session**: each test was
  rewritten to assert the post-ADR 0007 health (`cooling_down` /
  `invalid_authentication`) instead of `unverified`, and the local
  `ProviderBody.keys[].health` type was widened from a 3-value to a
  6-value union to match the public DTO.
- `test/http/inference-chat-completions.test.ts`: 1 test about "no
  eligible Upstream Key." Also pre-existing on `main`. **Resolved
  in this session**: the assertion was updated to expect
  `cooling_down` for the inconclusive probe.
