# 05 — The read-only areas move to the query cache

**What to build:** `requests`, `audit`, `usage` and `overview` have no mutations, so this ticket buys no optimism — it buys deduplication and instant back-navigation, and it stops the codebase carrying two data-fetching paradigms at once. `overview` and `providers-area` each fetch the whole Provider list independently; the shared `['providers']` key collapses that to one request.

These are historical logs rather than live state, so they keep `staleTime` but opt out of refetch-on-focus. Left on the library's defaults, returning to the tab would refire every one of them.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `requests`, `audit`, `usage` and `overview` read through the query cache under `['requests', filters]`, `['audit', filters]` and `['usage', providerId]`.
- [ ] `overview` and `providers-area` share one `['providers']` query rather than issuing two Provider-list fetches. (Revised: they never shared a Request-events fetch — see Comments.)
- [ ] Filter and pagination changes are part of the query key, so switching filters and switching back is served from cache.
- [ ] `refetchOnWindowFocus` is off for all three keys.
- [ ] No `useState` plus `useEffect` fetch pair remains in these four components.
- [ ] Every one of these screens renders the same data it did before this ticket, including empty and error states.
- [ ] `bun run typecheck` passes.

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
