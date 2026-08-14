# 02 — Per-key snapshot shape with back-compat

**What:** The `usage_snapshots.result` JSON column keeps storing
`unknown`, but the shape inside changes from `UsageReading[]` to
`Record<keyId, UsageReading[]>`. `normalizeReadings` and a new
`perKeyMapFromSnapshot` helper recognise both the new shape and the
two legacy shapes (single `UsageReading` and flat `UsageReading[]`),
so an existing install's first per-key refresh converts the row
in place without losing cadence state.

**Status:** done

- [x] `UsageService.refresh` writes `result: Record<keyId, UsageReading[]>`
      on every successful refresh.
- [x] `normalizeReadings` accepts the three shapes and returns a flat
      `UsageReading[]` with each reading tagged with the right
      `keyId` (or `null` for legacy).
- [x] `perKeyMapFromSnapshot` is the reader's inverse: it returns the
      per-key map so `#recordOutcome` can preserve prior entries on
      per-key failure.
- [x] `nextByKey` starts from `perKeyMapFromSnapshot(prior.result)` and
      is rewritten in place; entries for keys that disappeared from the
      eligible list since the last refresh are dropped on the next
      successful refresh.

## Acceptance

- [x] A legacy single-reading snapshot reads back as a one-element
      flat list with `keyId: null` (see
      `test/usage/usage-service.test.ts` › "reads the legacy
      single-reading snapshot as a one-element list").
- [x] A legacy flat-list snapshot reads back with `keyId: null` and the
      next refresh rewrites the snapshot in the per-key map shape (see
      "reads a legacy flat-list snapshot and re-homes it on the next
      refresh").
- [x] No database migration is required; the column type stays
      `text`/`jsonb` and the shape lives inside the JSON.
