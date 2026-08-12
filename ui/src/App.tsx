import { useCallback, useEffect, useState } from 'react'
import { AccountSettings } from '@/components/account-settings'
import { AppShell } from '@/components/app-shell'
import { AuthScreen } from '@/components/auth-screen'
import { ReadinessPill } from '@/components/readiness-pill'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
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
        <Skeleton className="h-24 w-full max-w-sm" aria-label="Loading" />
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
      ) : (
        <Overview readiness={readiness} auth={auth} />
      )}
    </AppShell>
  )
}

const AREAS: Record<string, { title: string; description: string }> = {
  overview: { title: 'Overview', description: 'Gateway runtime and configuration state' },
  settings: { title: 'Settings', description: 'Owner account and signed-in sessions' },
}

function Overview({ readiness, auth }: { readiness: Readiness | null; auth: AuthState }) {
  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-base font-semibold tracking-tight">Runtime</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Iroha validated its configuration, applied every pending migration, and bound its port
          before accepting this request.
        </p>

        <Separator className="my-4" />

        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Fact label="Readiness">
            {readiness === null ? <Skeleton className="h-4 w-24" /> : readinessText(readiness)}
          </Fact>
          <Fact label="Database engine">
            {readiness === null ? (
              <Skeleton className="h-4 w-20" />
            ) : readiness.state === 'ready' ? (
              readiness.dialect === 'sqlite' ? 'SQLite' : 'PostgreSQL'
            ) : (
              'Unknown'
            )}
          </Fact>
          <Fact label="Owner">{auth.owner?.username ?? '—'}</Fact>
          <Fact label="Recovery">
            {auth.recoveryEnabled ? 'Token configured' : 'Not configured'}
          </Fact>
        </dl>
      </section>

      <section>
        <h2 className="text-base font-semibold tracking-tight">Not configured yet</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          This installation has no Provider Connections or Gateway Keys. Those areas arrive with the
          tickets that build them; nothing here is inferred or simulated.
        </p>
      </section>
    </div>
  )
}

function readinessText(readiness: Readiness): string {
  switch (readiness.state) {
    case 'ready':
      return 'Accepting traffic'
    case 'not_ready':
      return `Not accepting traffic (${readiness.reason.replace(/_/g, ' ')})`
    case 'unreachable':
      return 'Gateway did not answer'
  }
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground text-xs tracking-wide uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}
