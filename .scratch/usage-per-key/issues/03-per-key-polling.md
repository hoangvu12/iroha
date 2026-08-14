# 03 — Per-key polling in the Usage Service

**What:** `UsageService.refresh` polls every eligible Upstream Key for
the connection in parallel. Each successful poll's readings are tagged
with the polling key's `keyId` and stored under that key in the
per-key snapshot map. A failure on one key never erases the prior
readings for any other key.

**Status:** done

- [x] `#resolveTargets` (renamed from `#resolveTarget`) returns one
      `UsagePollTarget` per eligible key
      (`active`/`unverified`/`cooling_down`/`exhausted`; never
      `disabled`).
- [x] `refresh` calls the adapter once per target via `Promise.all`.
- [x] `#recordOutcome` accumulates per-key outcomes:
      - success → replace that key's entry in the per-key map
      - failure → preserve the prior entry for that key, set the
        connection-level `lastFailureAt`/`Code`/`Message`
      - rate-limited → same as failure, plus return 429 to the caller
        with the most restrictive `retryAfterSeconds`.
- [x] Keys no longer eligible between two refreshes have their entry
      dropped on the next successful refresh.
- [x] The audit event records `polledKeys`/`successfulKeys`/`failedKeys`
      so the Owner can see partial outcomes in the audit history.
- [x] `recoveryEvidenceFor` keeps the existing "best reading by
      balance" reduction across all readings; the `eligibleForUsageRecovery`
      reactivation path (`src/providers/provider-registry.ts:2150`)
      already handles a key-scoped reading (its `case 'key':` branch
      is now reachable when the strongest reading happens to be
      key-scoped).

## Acceptance

- [x] `test/usage/usage-service.test.ts` › "each eligible Upstream Key
      is polled and tagged with its keyId" verifies the multi-key
      happy path.
- [x] "a partial failure keeps the successful key's reading and records
      the failure at the connection level" verifies the partial-failure
      semantics.
- [x] "a rate-limited key surfaces 429 with the most restrictive
      retryAfter" verifies the rate-limit aggregation.
- [x] "the snapshot's result is keyed by Upstream Key id after refresh"
      verifies the durable shape.
