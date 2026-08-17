# 05 — The read-only areas move to the query cache

**What to build:** `requests`, `audit`, `usage` and `overview` have no mutations, so this ticket buys no optimism — it buys deduplication and instant back-navigation, and it stops the codebase carrying two data-fetching paradigms at once. `overview` and `providers-area` each fetch the whole Provider list independently; the shared `['providers']` key collapses that to one request.

These are historical logs rather than live state, so they keep `staleTime` but opt out of refetch-on-focus. Left on the library's defaults, returning to the tab would refire every one of them.

**Blocked by:** 02

**Status:** complete

- [x] `requests`, `audit`, `usage` and `overview` read through the query cache under `['requests', filters]`, `['audit', filters]` and `['usage', providerId]`.
- [x] `overview` and `providers-area` share one `['providers']` query rather than issuing two Provider-list fetches. (Revised: they never shared a Request-events fetch — see Comments.)
- [x] Filter and pagination changes are part of the query key, so switching filters and switching back is served from cache.
- [x] `refetchOnWindowFocus` is off for all three keys.
- [x] No `useState` plus `useEffect` fetch pair remains in these four components.
- [x] Every one of these screens renders the same data it did before this ticket, including empty and error states.
- [x] `bun run typecheck` passes.

## Comments

**`overview` never fetched 800 Request events.** It calls
`fetchRequestOverview(range)` (`ui/src/components/overview.tsx:99`), a
server-side aggregate. The two components that pull 800 raw events are
`providers-area` (unfiltered) and `provider-detail` (scoped to one Provider),
and those two are ticket 03's, not this ticket's. What `overview` and
`providers-area` genuinely duplicate is `fetchProviders()`, which the shared
`['providers']` key collapses.

**Two keys the spec's list omits.** `overview` also needs
`['request-overview', range]` and `['background-jobs']`
(`fetchBackgroundJobs`, `ui/src/lib/background.ts`). Neither appears in the
spec's cache design. Both belong to this ticket; add them to the key factory
ticket 02 introduces. `['request-overview', range]` is an expensive historical
aggregate, so it opts out of refetch-on-focus with the other three;
`['background-jobs']` is live operational state and keeps focus refetch.

**A third key was needed: `['requests', id]`.** `requests-area` fetches one
Request's Attempts when the Owner opens a row, and the bullet asking for no
leftover fetch effect covers that read too. It is spelled `queryKeys.request(id)`,
mirroring the existing `providers()` / `provider(id)` pair, so it inherits the
`requests` focus exemption and reopening a row already read costs no fetch.

**`usage` was already done.** `useProviderUsage` landed with ticket 03 in
`ui/src/lib/use-providers.ts` and `provider-detail` consumes it. Nothing to do,
and nothing duplicated.

**The audit clear never asked for confirmation.** The ticket brief said to keep a
confirmation step; there is none in `audit-area` today — the Clear feed button
fires straight into `clearAudit`. Its guards are that it is disabled on an empty
feed and that `StatefulButton` shows its own loading and error state. Left
exactly as it was rather than adding a dialog this ticket did not ask for; worth
a follow-up given the write is irreversible.

**One pre-existing inconsistency had to be resolved rather than preserved.**
`requests-area`'s `applyFilter` refetched at offset 0 but never reset its `offset`
state, so filtering from page three fetched page one and labelled it "51–75 of N".
With the offset in the query key that divergence is not representable — the key
either says 0 or 50 — so `applyFilter` now resets it, matching what `audit-area`
already did.

**Pagination keeps the page it is showing.** Both areas only replaced their list
on success, so the previous page stayed on screen while the next one loaded.
`placeholderData: keepPreviousData` reproduces that; without it the key change
would empty the table and flash the skeleton between pages.
