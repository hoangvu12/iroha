# 03 — Providers read from the cache and mutate optimistically

**What to build:** `providers-area` and `provider-detail` each hold a private copy of the Provider list, so neither sees the other's changes, and each mutation ends in a `reload()` that refetches everything — including, in `providers-area`, 800 Request events behind the sparklines. Move both onto `['providers']` and `['providers', id]`, give `provider-detail` the unused `GET /providers/:id`, and convert the mutations.

Optimistic: `updateProvider`, `activateKey`, `disableKey`, `removeKey`, `archiveProvider`, `purgeProvider`, `updateKeySettings`, and the three Upstream Account mutations. Pending indicator only: `addKey`, `bulkAddKeys`, `createProvider`, `duplicateProvider`, `testKey`. See ADR-0022 for why the line falls there.

**Blocked by:** 02

**Status:** complete

- [x] `providers-area` and `provider-detail` read from a shared cache; a mutation in one is visible in the other without a refetch.
- [x] `provider-detail` fetches `GET /providers/:id` rather than the whole list.
- [x] Each optimistic mutation cancels in-flight queries, snapshots, patches, and restores the snapshot on failure.
- [x] `archiveProvider`'s optimistic patch sets both `archived: true` and `enabled: false`.
- [x] `updateKeySettings` recomputes `effectiveBaseUrl` as the Key's override or the Provider's base URL.
- [x] On success each mutation writes its returned `ProviderView` into both `['providers']` and `['providers', id]`; on settle it invalidates those keys and `['audit']`.
- [x] A failed mutation restores the previous state and raises a toast naming the affected Provider or Key. No success toast is raised.
- [x] A row's actions are disabled while its own mutation is in flight.
- [x] The five upstream-touching mutations show a pending indicator and do not alter the cache before their response arrives.
- [x] A bulk import that partially fails raises one summary toast, with per-entry detail inline in the import dialog.
- [x] Toggling a Provider no longer refetches Request events.
- [x] `bun run typecheck` passes.

## Comments

Every bullet above is met. `bun run typecheck`, `bun run --cwd ui build` and
`bun test` (1144 pass / 2 skip / 0 fail across 89 files) are green. No browser
tests, per `docs/agents/ui-testing.md`.

The recipe lives in `useProviderMutation` in the new `ui/src/lib/use-providers.ts`:
one mutation declares `perform`, a `failureTitle` naming its row, an optional
`optimistic: { providerId, patch }`, and an optional `viewOfResult`. Whether a
mutation predicts is visible from whether it declares `optimistic`, and the
pairing is structural — nothing can predict without naming the Provider it
patches. `onSettled` invalidates by prefix and is deliberately not awaited, so a
row's actions reopen when the response lands rather than when the background
refetch does.

Two deliberate departures:

- The Upstream Account mutations have no call site anywhere in the UI today.
  They are converted as the spec asks, with their patches written and reviewable,
  but nothing exercises them until an accounts surface exists.
- The Provider Handle availability probe in `CreateProviderForm` stays a
  debounced `useEffect`. It is a per-keystroke validation probe, not shared
  server state: caching it would add one cache entry per prefix the Owner types
  and a 30s `staleTime` would keep reporting a handle available after a create
  took it.

**Two rollback defects found in review and fixed.** Both were in
`useProviderMutation`'s failure path, which the bullet "restores the snapshot on
failure" covers.

The first: when `['providers']` was cached but `['providers', id]` was not, the
patch *created* the detail entry, and `restoreProviders` then restored nothing
there because it had no snapshot of it — leaving the refused prediction cached.
`onSettled` marks an inactive entry stale without refetching it, and both
`ensureQueryData` callers serve stale data as a hit, so opening that Provider
painted the state the Gateway had just rejected. The rollback now removes an
entry it did not snapshot.

The second: a Provider's Upstream Keys are separate rows sharing one
`ProviderView`, and a row disables only its *own* actions, so the Owner can
disable two Keys in quick succession. Restoring the whole snapshot on the
first failure silently revoked the second Key's patch. The four Key-scoped
mutations now supply a narrow `rollback` that puts back only the Key they
touched, reading whatever the cache holds at that moment; Provider-scoped
mutations still restore wholesale, which is correct because a Provider row
serialises its own writes. ADR-0022's reasoning stops at the row; the cache
entry is coarser than the row, and that gap is what this closes.

**`purge` now drops the detail entry rather than leaving it.** The comment
claimed the entry was left alone so the mounted detail screen would not be sent
back for a Provider on its way out — but `onSettled` invalidates the
`['providers']` *prefix*, which matches `['providers', id]`, so on that screen
the query was active and would refetch into a `404`. It is removed on the
prediction instead, which takes it out of the invalidation's reach.

**Two audited writes reconciled nothing.** `useRefreshUsage` had no `onSettled`
at all, yet a usage refresh records `usage.refreshed` *and* reconciles Key Health
from the Provider's entitlement surface, so both `['providers']` and `['audit']`
were left stale. `refreshCatalog` was called bare from `provider-detail` and is
audited as `model_catalog.refreshed`; it is now `useRefreshCatalog` and follows
the same recipe. It raises no toast of its own because the button it sits behind
reports inline.
