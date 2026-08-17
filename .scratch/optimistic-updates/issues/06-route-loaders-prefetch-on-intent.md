# 06 — Route loaders make the router's preload real

**What to build:** `ui/src/router.tsx:138` sets `defaultPreload: 'intent'`, but no route declares a loader, so hovering a Provider row preloads nothing and clicking it shows a skeleton. Now that the query keys are stable, wire the routes to `queryClient.ensureQueryData` so intent-to-navigate warms the cache.

This is the other half of the feature's goal: mutations stop making the Owner wait, and so does navigation.

**Blocked by:** 03, 05

**Status:** complete

- [x] Each route declares a loader calling `queryClient.ensureQueryData` for the data its component reads. (`/settings` reads nothing from the cache and has none.)
- [x] Hovering a Provider row warms `['providers', id]`, and clicking through renders without a skeleton on a warm cache. Closed in integration by `useWarmProvider` rather than by a `Link` — see Comments.
- [x] A cold navigation — direct URL entry or a hard refresh — still renders its loading state rather than blocking on the loader.
- [x] A loader failure surfaces the existing error state; it does not blank the route.
- [x] `bun run typecheck` passes.

## Comments

**The rows are not `Link`s, so there is no hover to preload from.**
`defaultPreload: 'intent'` only fires from a router `Link`; a Provider row is a
`div role="button"` whose `onClick` calls `openProvider`, which calls
`navigate({ to: '/providers/$providerId' })`
(`ui/src/components/providers-area.tsx:95` and `:240`). Intent never reaches the
router, so the loader below runs on click rather than on hover. Everything else
the bullet asks for holds: the loader exists, it warms exactly
`queryKeys.provider(id)`, and `provider-detail`'s skeleton is gated solely on
`providerQuery.data` (`provider-detail.tsx:128`), so a warm entry renders the
Provider with no skeleton at all.

This was resolved in integration without a `Link` — see the last comment below.
The sidebar `Link`s in `app-shell.tsx` do express intent, so `/`, `/providers`,
`/gateway-keys`, `/requests` and `/audit` all preload on hover through the
router itself.

**No loader is awaited, and that is what satisfies the last two bullets.**
Each loader hands its `ensureQueryData` promises to a `warm` helper that voids
them. Returning them would make the router the thing that waits: a cold
navigation would hold the Owner on a blank route until the fetch landed instead
of showing the skeleton the screen already renders, and a rejection would
surface as a router error replacing the whole route. Voided, the failure stays
on the cache entry, which the component reads back as its query's `error` and
renders in its own error branch. `defaultPendingMs` / `defaultPendingComponent`
would have been the alternative — a second loading state, competing with seven
skeletons that already exist — so neither is set.

**Six additive exports, no behaviour changed.** A loader that spelled its own key
or fetch could drift from its hook by a character and warm an entry no screen
reads, with nothing failing to show it. Each read is now one exported
`queryOptions(...)` object that both the hook and the loader use:
`providersQueryOptions`, `providerQueryOptions` (`use-providers.ts`),
`gatewayKeysQueryOptions` (`use-gateway-keys.ts`), `requestPageQueryOptions`,
`requestOverviewQueryOptions` (`use-requests.ts`), `auditPageQueryOptions`
(`use-audit.ts`), `backgroundJobsQueryOptions` (`use-background.ts`). Every hook
now reads `useQuery(xQueryOptions(...))`; `useRequestPage` and `useAuditPage`
keep their `placeholderData: keepPreviousData` at the hook, since paging
behaviour is not the loader's business.

**No router context.** Ticket 02 left `context: { queryClient }` off `createRouter`
and flagged it as loader work. It stays off: `lib/query-client.ts` creates the
cache at module scope precisely so the router can import it, and
`createRootRouteWithContext` would buy an injection seam nothing here uses.

**The expensive reads are deliberately not warmed.** `providers-area` and
`provider-detail` each pull 800 Request events for their sparklines
(`useRequestHistory`), and `provider-detail` also reads `['usage', id]`. Neither
gates a skeleton, and warming them would fire an 800-event query on every hover
of the Providers link — the chattiness the spec's focus-refetch exemptions exist
to avoid. The Overview's aggregate is warmed only for `24h`, the range its
`useState` starts on; the other two ranges are the Owner's choice and cannot be
known before the mount.

**`/settings` needs no loader.** `AccountSettings` still reads Owner Sessions and
the retention policy through `useState` plus `useEffect`
(`account-settings.tsx:42-59`); tickets 02–05 migrated the seven areas that hold
Provider, Gateway Key and log state, not this one. There is no cache entry to
warm, and adding one would mean migrating the screen.

**No UI tests, per `docs/agents/ui-testing.md`.** The suite is unchanged at
1144 pass / 2 skip / 0 fail across 89 files; `bun run typecheck` and
`bun run --cwd ui build` both pass.

**Hover intent was closed in integration, not with a `Link`.** The row's outer
element cannot become a `Link`: its action menu is a `Button`, and interactive
content nested inside an `<a>` is invalid HTML, which is why the recommendation
to swap the element was not taken. Instead `useWarmProvider`
(`ui/src/lib/use-providers.ts`) calls `ensureQueryData(providerQueryOptions(id))`
from the row's `onMouseEnter` and `onFocus`, so hover — and keyboard focus,
which a `Link` would not have covered either — warms exactly the entry the
route's loader warms, through the same expression. `ensureQueryData` no-ops on a
fresh entry, so crossing the whole list costs at most one read per Provider per
`staleTime`. The loader stays as it is and still covers a typed URL, a refresh,
and the sidebar's real `Link`s.
