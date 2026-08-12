# 14 — Bounded background operations

**What to build:** Model, usage, recovery, retention, and session maintenance run predictably without overlapping work and expose failures to the Owner.

**Blocked by:** 06 — Model catalog and scoped Models API; 10 — Scoped retries and durable Key Health; 11 — Usage Adapter and entitlement visibility; 13 — Private request history and Owner audit.

**Status:** done

- [x] Background jobs cover periodic model synchronization, Usage Adapter polling, cooldown recovery, request-retention cleanup, and expired-session cleanup.
- [x] Each job prevents overlapping executions in the single-instance runtime.
- [x] Each job records last start, completion, success/failure, and useful sanitized error detail.
- [x] Model and usage schedules are globally configurable with appropriate connection overrides.
- [x] Cleanup operates in bounded batches and does not monopolize the database.
- [x] Recovery never creates automatic paid inference probes.
- [x] The Owner can trigger appropriate jobs manually and see their current/last outcome.
- [x] Deterministic clock tests cover schedule claims, overlap prevention, restart, backoff, and cleanup boundaries on both databases.

## Comments

### What was added

- `src/jobs/schedule-settings.ts` — `BackgroundScheduleSettings.overrides: { modelSync, usage }` with `parseOverrides` / `parseOverrideMap` (write-path validation: non-integers reject the whole write, out-of-range integers clamp to the shared `MIN_INTERVAL_SECONDS`/`MAX_INTERVAL_SECONDS` bounds) and `parseOverridesFromStored` / `sanitizeOverrideMap` (read-path sanitization that drops bad entries silently and backfills empty maps on legacy stored records).
- `src/jobs/jobs.ts` — pure helpers `effectiveIntervalFor(schedule, job, connectionId)` and `connectionIsDue({ lastSyncedAt, effectiveIntervalSeconds, now })` extracted so the cadence decision lives in one place. The `modelSync` and `usage` jobs now look up the connection's effective interval, read the connection's last `syncedAt` from the relevant repository (`database.modelCatalog.getSync`, `database.usage.get`), skip when `connectionIsDue` returns false, and otherwise process the connection as before. `now` is read inside the loop so a long-running fleet cannot starve later connections against a stale tick-start timestamp.
- `src/http/background-jobs.ts` — `settingsResponse` and `toScheduleDto` carry the overrides round-trip.
- `test/jobs/schedule-settings.test.ts` — eight new cases covering defaults, write acceptance, clamping, non-integer rejection, non-object inner-map rejection, cache survival, and legacy-stored-record sanitization.
- `test/jobs/scheduler.test.ts` — pure-function tests for `connectionIsDue` and `effectiveIntervalFor`, plus a `retention cleanup boundaries` suite proving the bounded batch + iteration guard semantics. The database-using describe blocks (background scheduler, retention cleanup boundaries) are now wrapped in `for (const engine of availableEngines)` so they run against both SQLite and PostgreSQL.
- `test/http/background-jobs.test.ts` — three new HTTP cases proving the settings endpoint reports empty overrides by default, accepts and round-trips an override write, and rejects a non-integer override value with the structured `validation_failed` problem list.

### Decisions worth knowing about

- **Override semantics.** `effectiveIntervalFor` is the single source of precedence. A connection listed in `overrides.modelSync` uses that interval; otherwise the global `modelSync.intervalSeconds` applies. The override can be either longer or shorter than the global; the only ceiling is the shared `MAX_INTERVAL_SECONDS`.
- **Reference timestamp reused.** No new schema. Each connection's existing `syncedAt` (from `model_catalog_sync` or `usage_snapshots`) is the reference the override compares against, so the first run after enabling an override behaves like the very first run.
- **`now` inside the loop.** The spec says cleanup must not monopolize the database; the same property matters for per-connection cadence — a fleet whose loop spans more than one effective interval cannot let a stale tick-start `now` decide for connections later in the iteration.
- **Override storage key.** Overrides live inside the existing `background.schedule` settings row alongside the global intervals, so the Owner's read/write surface is one PUT and one GET.

### Review

`/code-review` ran two parallel axes:

- **Standards:** no hard violations; the new code follows the existing JSDoc + `readonly` + parse-then-clamp + engine-parameterized test patterns. The reviewer flagged dead `skipped` counters that I introduced in the first pass and three near-identical iterate-validate-clamp loops; both have been fixed (dead state removed; a `collectOverrideEntries` helper collapses the three loops into one).
- **Spec:** every requirement in the ticket is implemented. The reviewer noted that the `IROHA_TEST_POSTGRES_URL` env var is required to actually exercise the PostgreSQL leg of "both databases"; the existing conformance suite has the same dependency and prints a warning when the var is unset.

Full suite: 732 pass / 1 skip / 0 fail; typecheck clean.


