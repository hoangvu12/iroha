# 03 — Providers read from the cache and mutate optimistically

**What to build:** `providers-area` and `provider-detail` each hold a private copy of the Provider list, so neither sees the other's changes, and each mutation ends in a `reload()` that refetches everything — including, in `providers-area`, 800 Request events behind the sparklines. Move both onto `['providers']` and `['providers', id]`, give `provider-detail` the unused `GET /providers/:id`, and convert the mutations.

Optimistic: `updateProvider`, `activateKey`, `disableKey`, `removeKey`, `archiveProvider`, `purgeProvider`, `updateKeySettings`, and the three Upstream Account mutations. Pending indicator only: `addKey`, `bulkAddKeys`, `createProvider`, `duplicateProvider`, `testKey`. See ADR-0022 for why the line falls there.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `providers-area` and `provider-detail` read from a shared cache; a mutation in one is visible in the other without a refetch.
- [ ] `provider-detail` fetches `GET /providers/:id` rather than the whole list.
- [ ] Each optimistic mutation cancels in-flight queries, snapshots, patches, and restores the snapshot on failure.
- [ ] `archiveProvider`'s optimistic patch sets both `archived: true` and `enabled: false`.
- [ ] `updateKeySettings` recomputes `effectiveBaseUrl` as the Key's override or the Provider's base URL.
- [ ] On success each mutation writes its returned `ProviderView` into both `['providers']` and `['providers', id]`; on settle it invalidates those keys and `['audit']`.
- [ ] A failed mutation restores the previous state and raises a toast naming the affected Provider or Key. No success toast is raised.
- [ ] A row's actions are disabled while its own mutation is in flight.
- [ ] The five upstream-touching mutations show a pending indicator and do not alter the cache before their response arrives.
- [ ] A bulk import that partially fails raises one summary toast, with per-entry detail inline in the import dialog.
- [ ] Toggling a Provider no longer refetches Request events.
- [ ] `bun run typecheck` passes.

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
