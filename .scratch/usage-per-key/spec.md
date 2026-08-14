# Per-Upstream-Key usage polling

## What

The Owner-facing Usage surface tracks entitlement at the Upstream-Key level,
not the Provider level. Today the service picks the *first* eligible key as
the connection's voice to the entitlement endpoint and stores the result at
the Provider level (`src/usage/usage-service.ts:189-200`). The
`KeyHealth` reactivation logic in
`src/providers/provider-registry.ts:2160-2170` already supports a
`{ kind: 'key', keyId }` scope, and the UI's
`scopeMatchesKey` (`ui/src/components/provider-detail.tsx:1528-1531`)
already knows how to gate a reading to one key — but neither ever fires
because the service never produces a key-scoped reading.

A Provider with two Upstream Keys on two upstream accounts is currently
shown the *first eligible key's* entitlement for both rows, which is wrong.
Polling per key, storing the readings per key, and letting the UI render
per row fixes that.

## Why now

The user reported the bug visually: "if I have 2 keys, shouldn't it get
usage of those 2 keys?". The data model already half-supports it; the
service just doesn't produce the data.

## Non-goals

- Per-key freshness (`lastSuccessAt` per key). The connection-level
  `lastSuccessAt` reflects the freshest of any key. Per-key freshness is a
  follow-up.
- Deduplication of polls across keys that share an upstream account. Two
  keys on the same MiniMax account will produce two equal readings; the
  cost is one extra poll per cadence. Acceptable for ≤5 keys.
- Per-key failure metadata. The connection-level `lastFailureAt`/`Code`/
  `Message` track the most recent failure across keys.

## Design

### Reading shape

`UsageReading` gains one new field: `keyId: string | null`.

- `null` for a reading that is not tied to a specific key (legacy snapshots,
  reactive-only adapter's per-key reading also keeps `null` because the
  adapter doesn't know about per-key — but the *service* tags the reading
  it pulled via a specific key, so reactive-only with per-key polling gets
  a non-null `keyId`).
- `keyId = 'k1'` for a reading the service pulled via key k1.

The existing `scope` keeps describing the *entitlement* (account, model,
provider, …). `keyId` describes the *transport* (which key fetched it).
Two different concepts, two different fields; a `connection_model: 'gpt-4o'`
reading still tells the UI "this is the gpt-4o window," and the `keyId`
tells it which row to render in.

### Snapshot shape

The `usage_snapshots.result` column stays a single JSON blob (no schema
migration). The shape inside it changes from `UsageReading[]` to
`Record<keyId, UsageReading[]>`:

```jsonc
{
  "uk_abc": [ /* readings for key uk_abc, each tagged with keyId: 'uk_abc' */ ],
  "uk_def": [ /* readings for key uk_def, each tagged with keyId: 'uk_def' */ ]
}
```

`normalizeReadings` in `src/usage/usage-service.ts` handles both shapes:

- Legacy `UsageReading[]` → flatten, return with `keyId: null` each.
- New `Record<keyId, UsageReading[]>` → flatten, return with the
  per-entry `keyId` set.

On every successful refresh the service rewrites the snapshot in the new
shape, so legacy flat-list snapshots are converted on first contact and
the legacy branch in `normalizeReadings` is purely read-time back-compat.

### Polling

`#resolveTarget` becomes `#resolveTargets` and returns one target per
eligible key (active/unverified/cooling_down/exhausted; never disabled).
`refresh` calls the adapter once per target with `Promise.all` so a slow
key doesn't block the others. The adapter sees one key at a time and
returns `UsageReading[]` exactly as today.

### Per-key outcome handling

For each target:

- `poll.ok` → store `poll.readings` (each tagged with `target.keyId`)
  into the per-key map.
- `poll.failure.code === 'rate_limited'` → don't store a new reading;
  keep the prior entry for this key (if any); record the connection-level
  `lastFailureAt`/`Code`/`Message` and the most-restrictive
  `retryAfterSeconds`. If at least one key rate-limited, the route
  returns 429.
- other `poll.failure` → same as rate-limited but the route returns 200
  with the partial view.

Keys that are no longer eligible (e.g. `disabled` between two refreshes)
have their entry dropped from the map on the next successful refresh.

### Recovery evidence

`recoveryEvidenceFor` reads `Object.values(result).flat()` and keeps its
existing "best reading by balance" reduction. The `best` reading carries
its existing `scope` (e.g. `connection_model: 'gpt-4o'`), so
`eligibleForUsageRecovery` (`src/providers/provider-registry.ts:2150`)
keeps reactivating correctly across both model-scoped and key-scoped
evidence. A future change can add "evidence that names a specific keyId"
and have the existing `case 'key':` branch light up — that branch is
already coded but unreachable today.

### UI

`UsageReadingView` adds `keyId: string | null`. `readingsForRow` becomes:

```ts
usage.readings.filter(r => r.keyId === null || r.keyId === keyId)
```

`scopeMatchesKey` is removed — its only caller was `readingsForRow`.

## Tickets

- `01-usage-reading-keyid.md` — add `keyId` to the reading type and DTO.
- `02-per-key-snapshot.md` — change the snapshot shape and
  `normalizeReadings` back-compat.
- `03-per-key-polling.md` — service polls every eligible key in
  parallel, accumulates per-key outcomes.
- `04-ui-render-per-key.md` — UI filters readings by `keyId` instead of
  by scope.
- `05-tests.md` — multi-key test coverage and back-compat round-trip
  test.

## What this is not

- No database migration. `usage_snapshots.result` was already `unknown`
  JSON; the shape inside it changes but the column type doesn't.
- No HTTP route change. The same `GET /providers/:id/usage` and
  `POST /providers/:id/usage/refresh` endpoints exist; only the
  `readings[].keyId` field is new on the response.
- No change to the inference path, the catalog path, or the
  `reactivateFromUsage` semantics.
