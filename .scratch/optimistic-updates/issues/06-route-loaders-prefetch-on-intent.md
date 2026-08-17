# 06 — Route loaders make the router's preload real

**What to build:** `ui/src/router.tsx:138` sets `defaultPreload: 'intent'`, but no route declares a loader, so hovering a Provider row preloads nothing and clicking it shows a skeleton. Now that the query keys are stable, wire the routes to `queryClient.ensureQueryData` so intent-to-navigate warms the cache.

This is the other half of the feature's goal: mutations stop making the Owner wait, and so does navigation.

**Blocked by:** 03, 05

**Status:** ready-for-agent

- [ ] Each route declares a loader calling `queryClient.ensureQueryData` for the data its component reads.
- [ ] Hovering a Provider row warms `['providers', id]`, and clicking through renders without a skeleton on a warm cache.
- [ ] A cold navigation — direct URL entry or a hard refresh — still renders its loading state rather than blocking on the loader.
- [ ] A loader failure surfaces the existing error state; it does not blank the route.
- [ ] `bun run typecheck` passes.
