# 05 — The read-only areas move to the query cache

**What to build:** `requests`, `audit`, `usage` and `overview` have no mutations, so this ticket buys no optimism — it buys deduplication and instant back-navigation, and it stops the codebase carrying two data-fetching paradigms at once. `overview` and `providers-area` currently fetch 800 Request events independently; one shared key collapses that to a single request.

These are historical logs rather than live state, so they keep `staleTime` but opt out of refetch-on-focus. Left on the library's defaults, returning to the tab would refire every one of them.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] `requests`, `audit`, `usage` and `overview` read through the query cache under `['requests', filters]`, `['audit', filters]` and `['usage', providerId]`.
- [ ] `overview` and `providers-area` share one Request-events query rather than issuing two.
- [ ] Filter and pagination changes are part of the query key, so switching filters and switching back is served from cache.
- [ ] `refetchOnWindowFocus` is off for all three keys.
- [ ] No `useState` plus `useEffect` fetch pair remains in these four components.
- [ ] Every one of these screens renders the same data it did before this ticket, including empty and error states.
- [ ] `bun run typecheck` passes.
