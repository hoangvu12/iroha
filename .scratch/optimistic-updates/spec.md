# Optimistic updates in the management UI

Status: ready-for-tickets

## Problem

Acting on anything in the management UI produces no feedback until a full refetch lands, roughly one to two seconds later. Deleting an Upstream Key, disabling one, or toggling a Provider all look like nothing happened, then the list redraws.

## What we found

The delay is not the network. Three separate causes, in order of impact:

1. **Every mutation triggers a full refetch and throws away a response it already has.** Every Provider mutation returns the complete `ProviderView`; the UI discards it and calls `reload()` instead (`ui/src/lib/providers.ts:236-432`).
2. **`providers-area`'s `reload()` refetches 800 Request events** alongside the Provider list (`ui/src/components/providers-area.tsx:86-102`), so toggling one Provider re-pulls the traffic history behind every sparkline. `provider-detail` pulls 800 of its own, scoped to the Provider (`ui/src/components/provider-detail.tsx:145`).
3. **`provider-detail`'s `reload()` fetches every Provider to find one** (`ui/src/components/provider-detail.tsx:117`), although `GET /providers/:id` exists and is unused (`src/http/admin.ts:171`).

Separately, `addKey`, `createProvider` and `duplicate` await `#probeConnectionKeys` (`src/providers/provider-registry.ts:1676`), which probes each unverified Key **sequentially** over the network before responding. That is genuine server-side latency, not a refetch artefact.

## Decisions

- Server state moves into TanStack Query. See ADR-0021.
- Optimistic updates apply only to mutations that touch no upstream. See ADR-0022.
- Mutations write their response into the cache **and** invalidate on settle. The write removes the visible wait; the invalidation is cheap background reconciliation.
- The Upstream Account mutations are migrated like any other, despite `.scratch/upstream-account-removal/spec.md` planning the feature's removal. Maintaining two paradigms in one component for a removal with no schedule costs more than the four-line recipe that dies with it.

## The two sets

**Optimistic** — pure database writes, fully predictable from the request:
`updateProvider`, `activateKey`, `disableKey`, `removeKey`, `archiveProvider`, `purgeProvider`, `updateKeySettings`, `createUpstreamAccount`, `updateUpstreamAccount`, `deleteUpstreamAccount`, `updateGatewayKey`, `revokeGatewayKey`, `deleteGatewayKey`.

**Pending indicator** — awaits an upstream probe, or returns server-only data:
`addKey`, `bulkAddKeys`, `createProvider`, `duplicateProvider`, `testKey`, `createGatewayKey`, `revealKey`.

Two patches are easy to get wrong: `archiveProvider` must set `archived: true` **and** `enabled: false`; `updateGatewayKey` must set `revision: revision + 1`.

## Conventions

**Feedback.** Errors always raise a toast, naming the affected row. Success is signalled inline — the row changing *is* the confirmation, and copy buttons swap to a check reading "Copied" for about 1.5 seconds. Success toasts are a last resort, not a default. (Considered as an ADR and rejected: it is a convention, cheap to reverse.)

**In-flight rows.** A row disables its own actions while its mutation is in flight.

**Bulk import.** Partial failure raises one summary toast; per-line detail stays inline in the import dialog, per ADR-0009.

## Cache design

Keys: `['providers']`, `['providers', id]`, `['provider-templates']`, `['gateway-keys']`, `['requests', filters]`, `['audit', filters]`, `['usage', providerId]`.

`staleTime` is 30s globally. `refetchOnWindowFocus` stays on for `providers` and `gateway-keys` and is **off** for `requests`, `audit` and `usage` — those are expensive historical logs, and the library's default would make the app chattier than it is today.

Mutation shape: `onMutate` cancels queries, snapshots, patches, returns the snapshot; `onError` restores it and toasts; `onSuccess` writes the returned view into both `['providers']` and `['providers', id]`; `onSettled` invalidates its own keys plus `['audit']`, which every mutation dirties.

## Testing

Per `docs/agents/ui-testing.md` this ships without browser tests; the HTTP suite is the seam under test and the Owner verifies the UI by hand. Ticket 07 is server-side and carries real tests.

## Out of scope

`POST /providers/:id/restore` exists (`src/http/admin.ts:299`) with no client function in `ui/src/lib/providers.ts` — an archived Provider cannot be restored from the UI. Unrelated to this work; recorded so it is not lost.
