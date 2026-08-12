import { useCallback, useEffect, useState } from 'react'
import { AccountSettings } from '@/components/account-settings'
import { AppShell } from '@/components/app-shell'
import { AuditArea } from '@/components/audit-area'
import { AuthScreen } from '@/components/auth-screen'
import { GatewayKeysArea } from '@/components/gateway-keys-area'
import { Overview } from '@/components/overview'
import { ProvidersArea } from '@/components/providers-area'
import { ReadinessPill } from '@/components/readiness-pill'
import { RequestsArea } from '@/components/requests-area'
import { Button } from '@/components/ui/button'
import { fetchAuthState, signOut, type AuthState } from '@/lib/auth'
import { fetchReadiness, type Readiness } from '@/lib/health'

export default function App() {
  const [activeId, setActiveId] = useState('overview')
  const [readiness, setReadiness] = useState<Readiness | null>(null)
  const [auth, setAuth] = useState<AuthState | null>(null)

  useEffect(() => {
    const controller = new AbortController()

    const poll = () => {
      void fetchReadiness(controller.signal).then((result) => {
        if (!controller.signal.aborted) setReadiness(result)
      })
    }

    poll()
    const timer = setInterval(poll, 15_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [])

  const reloadAuth = useCallback(async () => {
    try {
      setAuth(await fetchAuthState())
    } catch {
      // The gateway is unreachable; readiness already reports that, and the
      // shell must not claim a signed-in state it cannot confirm.
      setAuth({
        setupRequired: false,
        authenticated: false,
        recoveryEnabled: false,
        owner: null,
        session: null,
      })
    }
  }, [])

  useEffect(() => {
    void reloadAuth()
  }, [reloadAuth])

  if (auth === null) {
    return (
      <div className="bg-canvas flex min-h-full items-center justify-center p-10">
        <div className="bg-muted h-6 w-40 animate-pulse rounded-md" aria-label="Loading" />
      </div>
    )
  }

  if (!auth.authenticated) {
    return <AuthScreen state={auth} onAuthenticated={setAuth} />
  }

  const signOutHere = async () => {
    try {
      await signOut(auth.session?.csrfToken ?? '')
    } finally {
      await reloadAuth()
      setActiveId('overview')
    }
  }

  const area = AREAS[activeId] ?? AREAS.overview!
  const csrf = auth.session?.csrfToken ?? ''

  return (
    <AppShell
      activeId={activeId}
      onNavigate={setActiveId}
      title={area.title}
      description={area.description}
      headerAside={
        <div className="flex items-center gap-2">
          <ReadinessPill readiness={readiness} />
          <Button type="button" variant="ghost" size="sm" onClick={() => void signOutHere()}>
            Sign out
          </Button>
        </div>
      }
    >
      {activeId === 'settings' ? (
        <AccountSettings state={auth} onSignedOut={() => void reloadAuth()} />
      ) : activeId === 'providers' ? (
        <ProvidersArea csrfToken={csrf} onSignedOut={() => void reloadAuth()} />
      ) : activeId === 'gateway-keys' ? (
        <GatewayKeysArea csrfToken={csrf} onSignedOut={() => void reloadAuth()} />
      ) : activeId === 'requests' ? (
        <RequestsArea onSignedOut={() => void reloadAuth()} />
      ) : activeId === 'audit' ? (
        <AuditArea csrfToken={csrf} onSignedOut={() => void reloadAuth()} />
      ) : (
        <Overview auth={auth} readiness={readiness} csrfToken={csrf} />
      )}
    </AppShell>
  )
}

const AREAS: Record<string, { title: string; description: string }> = {
  overview: {
    title: 'Overview',
    description: 'Gateway runtime and the things that need attention',
  },
  providers: {
    title: 'Providers',
    description: 'Provider Connections and their Upstream Keys',
  },
  'gateway-keys': {
    title: 'Gateway Keys',
    description: 'Application credentials and their Provider Connection scope',
  },
  requests: {
    title: 'Requests',
    description: 'Inference metadata — connection, model, key, status, and latency',
  },
  audit: {
    title: 'Audit',
    description: 'Every administrative change retained by Iroha',
  },
  settings: {
    title: 'Settings',
    description: 'Owner account, sessions, and retention',
  },
}