import { Component, useCallback, useEffect, useState, type ReactNode } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { AuthScreen } from '@/components/auth-screen'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { registerOwnerSignOut } from '@/lib/api-client'
import { CsrfContext } from '@/lib/csrf-context'
import { fetchAuthState, signOut, type AuthState } from '@/lib/auth'
import { queryClient } from '@/lib/query-client'
import { router } from '@/router'

class ErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error('Iroha UI crashed:', error)
  }

  render() {
    if (this.state.error !== null) {
      return (
        <div className="bg-canvas flex min-h-full items-center justify-center p-10">
          <div className="bg-card max-w-md rounded-lg border p-6">
            <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
            <p className="text-muted-foreground mt-2 text-sm">
              The UI hit an error rendering this page. Reload to try again.
            </p>
            <pre className="text-muted-foreground bg-muted mt-4 max-h-48 overflow-auto rounded p-3 text-xs">
              {this.state.error.message}
            </pre>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <OwnerSession />
      {/* Outside the router so a toast raised by a navigation survives it. */}
      <Toaster position="bottom-right" />
    </QueryClientProvider>
  )
}

function OwnerSession() {
  const [auth, setAuth] = useState<AuthState | null>(null)

  const reloadAuth = useCallback(async () => {
    try {
      setAuth(await fetchAuthState())
    } catch {
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

  const csrfToken = auth?.session?.csrfToken ?? ''

  const handleSignedOut = useCallback(async () => {
    try {
      await signOut(csrfToken)
    } finally {
      await reloadAuth()
      void router.navigate({ to: '/' })
    }
  }, [csrfToken, reloadAuth])

  // The API client and both query caches notice an expired Owner Session from
  // module scope, where this component's state is out of reach; registering the
  // handler here is the seam between the two. See `registerOwnerSignOut`.
  useEffect(() => registerOwnerSignOut(() => void handleSignedOut()), [handleSignedOut])

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

  return (
    <CsrfContext.Provider
      value={{ csrfToken, onSignedOut: () => void handleSignedOut(), authState: auth }}
    >
      <TooltipProvider delayDuration={150}>
        <ErrorBoundary>
          <RouterProvider router={router} />
        </ErrorBoundary>
      </TooltipProvider>
    </CsrfContext.Provider>
  )
}