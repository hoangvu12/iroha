# 01 — Usage Reading: add `keyId` field

**What:** `UsageReading` gains `keyId: string | null`. The `UsageService` is
the only writer; adapters never set it.

**Status:** done

- [x] `UsageReading.keyId: string | null` declared in
      `src/usage/adapter.ts` with a comment that distinguishes it from
      `scope` (entitlement vs transport).
- [x] Every adapter-built reading carries `keyId: null`:
      `src/usage/generic-adapter.ts`,
      `src/usage/minimax-usage-adapter.ts` (both reading kinds),
      `src/usage/mock-credit-adapter.ts`,
      `src/usage/mock-plan-adapter.ts`.
- [x] HTTP DTO `usageReading` includes `keyId: t.Union([t.Null(), t.String()])`
      in `src/http/usage.ts`.
- [x] `toUsageDto` propagates `reading.keyId` into the response.
- [x] UI type `UsageReadingView.keyId: string | null` in
      `ui/src/lib/usage.ts`.
- [x] Test adapter fixture in `test/providers/connection-templates.test.ts`
      adds `keyId: null`.
- [x] Test fixture helper in `test/usage/usage-service.test.ts` adds
      `keyId: null` to the synthetic `successReadingFor` output.

## Acceptance

- [x] All existing usage and HTTP tests still pass; the new field is
      nullable in the response so legacy and per-key consumers share a
      shape.
- [x] Typecheck clean for the server and the UI.
