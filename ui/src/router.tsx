import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from '@tanstack/react-router'
import { AccountSettings } from '@/components/account-settings'
import { AppShell } from '@/components/app-shell'
import { AuditArea } from '@/components/audit-area'
import { ProviderDetail } from '@/components/provider-detail'
import { GatewayKeysArea } from '@/components/gateway-keys-area'
import { Overview } from '@/components/overview'
import { ProvidersArea } from '@/components/providers-area'
import { RequestsArea } from '@/components/requests-area'
import { useCsrf } from '@/lib/csrf-context'
import { queryClient } from '@/lib/query-client'
import { auditPageQueryOptions } from '@/lib/use-audit'
import { backgroundJobsQueryOptions } from '@/lib/use-background'
import { gatewayKeysQueryOptions } from '@/lib/use-gateway-keys'
import { providerQueryOptions, providersQueryOptions } from '@/lib/use-providers'
import { requestOverviewQueryOptions, requestPageQueryOptions } from '@/lib/use-requests'

/**
 * Starts a route's reads without making the route depend on them.
 *
 * Every loader below hands its `ensureQueryData` promises here rather than
 * returning them, and the difference is the whole design:
 *
 *   - A returned promise is one the router waits on. On a hover that is the
 *     point, but on a cold navigation — a typed URL, a hard refresh — it would
 *     hold the Owner on a blank route until the fetch landed, instead of the
 *     skeleton every one of these screens already renders while its query is in
 *     flight. Nothing is awaited, so the loader only ever buys a head start.
 *   - A rejection that escaped a loader becomes a router error and replaces the
 *     route. Swallowing it here leaves the failure where it belongs: on the
 *     cache entry, which the component reads as its query's `error` and shows in
 *     the error branch it already has. `query-client`'s shared `onError` has
 *     meanwhile signed the Owner out if the Owner Session is what expired, so
 *     there is nothing here to handle twice.
 */
function warm(...reads: readonly Promise<unknown>[]): void {
  for (const read of reads) void read.catch(() => {})
}

function RootShell() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}

const rootRoute = createRootRoute({ component: RootShell })

function OverviewRoute() {
  const { csrfToken } = useCsrf()
  return <Overview csrfToken={csrfToken} />
}

function ProvidersAreaRoute() {
  const { csrfToken } = useCsrf()
  return <ProvidersArea csrfToken={csrfToken} />
}

function ProviderDetailRoute() {
  const { csrfToken } = useCsrf()
  const { providerId } = useParams({ strict: false }) as { providerId?: string }
  if (providerId === undefined) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <p className="text-muted-foreground text-sm">
          No provider ID in the URL. Go back to{' '}
          <a href="/providers" className="text-primary underline">
            Providers
          </a>
          .
        </p>
      </div>
    )
  }
  return (
    <ProviderDetail
      providerId={providerId}
      csrfToken={csrfToken}
      onBack={() => void router.navigate({ to: '/providers' })}
      onDeleted={() => void router.navigate({ to: '/providers' })}
    />
  )
}

function GatewayKeysRoute() {
  const { csrfToken } = useCsrf()
  return <GatewayKeysArea csrfToken={csrfToken} />
}

function RequestsRoute() {
  return <RequestsArea />
}

function AuditRoute() {
  const { csrfToken } = useCsrf()
  return <AuditArea csrfToken={csrfToken} />
}

function SettingsRoute() {
  const { authState, onSignedOut } = useCsrf()
  return <AccountSettings state={authState} onSignedOut={onSignedOut} />
}

/**
 * The Overview opens on this range and the Owner may change it from the header.
 * The chosen range is component state, so only the one it starts on can be
 * warmed ahead of the mount; it mirrors `overview.tsx`'s initial `range`.
 */
const OVERVIEW_DEFAULT_RANGE = '24h'

/** The filters and the page every list screen starts on, before the Owner narrows one. */
const NO_FILTER = {}
const FIRST_PAGE = 0

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewRoute,
  loader: () =>
    warm(
      queryClient.ensureQueryData(providersQueryOptions()),
      queryClient.ensureQueryData(requestOverviewQueryOptions(OVERVIEW_DEFAULT_RANGE)),
      queryClient.ensureQueryData(backgroundJobsQueryOptions()),
    ),
})

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/providers',
  component: ProvidersAreaRoute,
  loader: () => warm(queryClient.ensureQueryData(providersQueryOptions())),
})

const providerDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/providers/$providerId',
  component: ProviderDetailRoute,
  // The route this feature exists for: the Provider is on its way in before the
  // Owner has finished clicking, so the detail screen opens on data it has.
  // This loader covers arriving by URL or by the sidebar's `Link`s. A row in the
  // Providers list navigates imperatively — it cannot be an anchor without
  // nesting its action menu's button inside one — so it warms this same entry
  // from its own hover through `useWarmProvider`.
  loader: ({ params }) =>
    warm(queryClient.ensureQueryData(providerQueryOptions(params.providerId))),
})

const gatewayKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gateway-keys',
  component: GatewayKeysRoute,
  // Two reads: the keys themselves, and the Provider list the Key Scope picker
  // names Providers from (`gateway-keys-area.tsx`).
  loader: () =>
    warm(
      queryClient.ensureQueryData(gatewayKeysQueryOptions()),
      queryClient.ensureQueryData(providersQueryOptions()),
    ),
})

const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/requests',
  component: RequestsRoute,
  // The Provider list again, this time for the filter bar's Provider select.
  loader: () =>
    warm(
      queryClient.ensureQueryData(requestPageQueryOptions(NO_FILTER, FIRST_PAGE)),
      queryClient.ensureQueryData(providersQueryOptions()),
    ),
})

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: AuditRoute,
  loader: () => warm(queryClient.ensureQueryData(auditPageQueryOptions(NO_FILTER, FIRST_PAGE))),
})

// No loader: Account Settings reads Owner Sessions and the retention policy
// through its own `useEffect`, not the query cache, so there is no entry to warm.
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsRoute,
})

const routeTree = rootRoute.addChildren([
  overviewRoute,
  providersRoute,
  providerDetailRoute,
  gatewayKeysRoute,
  requestsRoute,
  auditRoute,
  settingsRoute,
])

export const router = createRouter({
  routeTree,
  // Now that the routes carry loaders this preloads something: hovering a
  // navigation `Link` starts that screen's reads. Only a `Link` expresses intent,
  // so a row that navigates imperatively gets no head start — see the note on
  // `providerDetailRoute`. There is no `context: { queryClient }` because the
  // cache is a module singleton by design (`lib/query-client.ts`); threading it
  // through the router would buy an injectability nothing here uses.
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}