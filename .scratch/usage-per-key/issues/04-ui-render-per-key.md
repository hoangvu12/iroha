# 04 — UI: per-key rendering

**What:** `readingsForRow` in `ui/src/components/provider-detail.tsx`
filters by `reading.keyId` instead of by `scope.kind === 'key'`. A
reading with `keyId: null` is treated as connection-wide (legacy data
or a reactive-only reading the service couldn't attribute to a key) and
shows in every row; a reading with a non-null `keyId` shows only in
that key's row.

**Status:** done

- [x] `UsageReadingView.keyId: string | null` in `ui/src/lib/usage.ts`
      (see `01-usage-reading-keyid.md`).
- [x] `readingsForRow` reads `reading.keyId` instead of the scope's
      `kind` discriminator. The dead `scopeMatchesKey` helper is
      removed.
- [x] The synthetic "Unknown" reading in `primaryForCell` carries
      `keyId: null`.

## Acceptance

- [x] The unused `UsageScope` import in `provider-detail.tsx` is
      removed; typecheck stays clean.
- [x] `bun run --cwd ui build` succeeds.
- [x] The HTTP integration test
      `test/http/usage.test.ts` › "each reading carries the keyId of
      the Upstream Key that fetched it" verifies the round-trip.
