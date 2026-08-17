# The management UI's server state lives in TanStack Query

Every area of the management UI owned its own copy of the server's state: a `useState<T | null>(null)`, a `useEffect` that called `fetchX()`, and a `reload()` that every mutation invoked on success. Nothing was shared, so `providers-area`, `provider-detail` and `overview` each held a private list of Providers that the others could not see, and `providers-area` and `provider-detail` each pulled 800 Request events for their charts. Worse, `reload()` discarded a response the UI already had — every Provider mutation returns the full `ProviderView` — and refetched everything instead, which is what made a Key deletion take one to two seconds to show. Server state now lives in a TanStack Query cache keyed by `['providers']`, `['providers', id]`, `['gateway-keys']`, and one key per read-only area; mutations write their returned `ProviderView` into the cache directly.

We rejected a hand-rolled shared store. It would have to reimplement request deduplication, staleness, snapshot-and-rollback, and in-flight cancellation — all of which the library already does, and all of which are the parts most likely to be got subtly wrong. We also rejected keeping state per component and layering optimistic overlays on top: with two components holding separate copies of the same Provider, an optimistic write in one is invisible in the other, which is the bug rather than the fix. `@tanstack/react-router` was already a dependency, so this adds a sibling package rather than a new vendor.

The cache is authoritative for reads only. The database remains the single source of truth per ADR-0002; nothing here lets the UI's copy outlive a page load.

## Consequences

Route loaders can now call `queryClient.ensureQueryData`, which finally gives the router's `defaultPreload: 'intent'` (`ui/src/router.tsx:138`) something to preload — it had been set since the router was introduced with no loader to act on it.

`provider-detail` had been fetching every Provider and filtering client-side for one (`ui/src/components/provider-detail.tsx:117`) despite `GET /providers/:id` existing (`src/http/admin.ts:171`). Giving the detail view its own cache key retires that.

Mutations invalidate their query keys on settle even though the mutation response has already been written into the cache. The write is what removes the visible wait; the invalidation is a cheap background reconciliation that costs network chatter, not perceived latency.
