import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { AccountSettings } from '@/components/account-settings'
import { AppShell } from '@/components/app-shell'
import { AuditArea } from '@/components/audit-area'
import { ConnectionDetail } from '@/components/connection-detail'
import { GatewayKeysArea } from '@/components/gateway-keys-area'
import { Overview } from '@/components/overview'
import { ProvidersArea } from '@/components/providers-area'
import { RequestsArea } from '@/components/requests-area'
import { useCsrf } from '@/lib/csrf-context'

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
  const { csrfToken, onSignedOut } = useCsrf()
  return <ProvidersArea csrfToken={csrfToken} onSignedOut={onSignedOut} />
}

function ConnectionDetailRoute() {
  const { csrfToken } = useCsrf()
  return (
    <ConnectionDetail
      connectionId={providerDetailRoute.useParams().connectionId}
      csrfToken={csrfToken}
      onBack={() => void router.navigate({ to: '/providers' })}
      onDeleted={() => void router.navigate({ to: '/providers' })}
    />
  )
}

function GatewayKeysRoute() {
  const { csrfToken, onSignedOut } = useCsrf()
  return <GatewayKeysArea csrfToken={csrfToken} onSignedOut={onSignedOut} />
}

function RequestsRoute() {
  const { onSignedOut } = useCsrf()
  return <RequestsArea onSignedOut={onSignedOut} />
}

function AuditRoute() {
  const { csrfToken, onSignedOut } = useCsrf()
  return <AuditArea csrfToken={csrfToken} onSignedOut={onSignedOut} />
}

function SettingsRoute() {
  const { authState, onSignedOut } = useCsrf()
  return <AccountSettings state={authState} onSignedOut={onSignedOut} />
}

const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: OverviewRoute,
})

const providersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/providers',
  component: ProvidersAreaRoute,
})

const providerDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/providers/$connectionId',
  component: ConnectionDetailRoute,
})

const gatewayKeysRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/gateway-keys',
  component: GatewayKeysRoute,
})

const requestsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/requests',
  component: RequestsRoute,
})

const auditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/audit',
  component: AuditRoute,
})

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
  defaultPreload: 'intent',
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}