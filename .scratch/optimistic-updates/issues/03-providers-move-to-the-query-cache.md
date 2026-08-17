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
