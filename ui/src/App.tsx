import { useCallback, useEffect, useState } from 'react'
import { RouterProvider } from '@tanstack/react-router'
import { AuthScreen } from '@/components/auth-screen'
import { CsrfContext } from '@/lib/csrf-context'
import { fetchAuthState, signOut, type AuthState } from '@/lib/auth'
import { router } from '@/router'

export default function App() {
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

  const csrfToken = auth.session?.csrfToken ?? ''

  const handleSignedOut = async () => {
    try {
      await signOut(csrfToken)
    } finally {
      await reloadAuth()
      void router.navigate({ to: '/' })
    }
  }

  return (
    <CsrfContext.Provider
      value={{ csrfToken, onSignedOut: () => void handleSignedOut(), authState: auth }}
    >
      <RouterProvider router={router} />
    </CsrfContext.Provider>
  )
}