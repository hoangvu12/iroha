import { useCallback, useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AuthError,
  fetchSessions,
  revokeAllSessions,
  revokeSession,
  type AuthState,
  type SessionSummary,
} from '@/lib/auth'

interface AccountSettingsProps {
  readonly state: AuthState
  /** Called when this browser's own session ends, so the shell can step back. */
  readonly onSignedOut: () => void
}

/**
 * The Owner's account area: who is signed in, and which browsers hold a live
 * session. Revocation is the useful action here, so it sits next to each row
 * rather than behind a menu.
 */
export function AccountSettings({ state, onSignedOut }: AccountSettingsProps) {
  const csrfToken = state.session?.csrfToken ?? ''
  const [sessions, setSessions] = useState<readonly SessionSummary[] | null>(null)
  const [error, setError] = useState<AuthError | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setSessions(await fetchSessions())
      setError(null)
    } catch (cause) {
      if (cause instanceof AuthError && cause.code === 'authentication_required') {
        onSignedOut()
        return
      }
      setError(cause instanceof AuthError ? cause : new AuthError('request_failed', 'Load failed.'))
    }
  }, [onSignedOut])

  useEffect(() => {
    void reload()
  }, [reload])

  const revokeOne = async (session: SessionSummary) => {
    setBusyId(session.id)
    try {
      await revokeSession(session.id, csrfToken)
      if (session.current) onSignedOut()
      else await reload()
    } catch (cause) {
      setError(cause instanceof AuthError ? cause : new AuthError('request_failed', 'Revoke failed.'))
    } finally {
      setBusyId(null)
    }
  }

  const revokeEverything = async () => {
    setBusyId('all')
    try {
      await revokeAllSessions(csrfToken)
      onSignedOut()
    } catch (cause) {
      setError(cause instanceof AuthError ? cause : new AuthError('request_failed', 'Revoke failed.'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-base font-semibold tracking-tight">Owner</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          This installation has one Owner account. Setup is closed and cannot create another.
        </p>

        <Separator className="my-4" />

        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground text-xs tracking-wide uppercase">Signed in as</dt>
            <dd className="text-sm">{state.owner?.username ?? '—'}</dd>
          </div>
        </dl>
      </section>

      <section>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Sessions</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Every browser currently signed in as the Owner.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void revokeEverything()}
            disabled={busyId !== null || sessions === null}
          >
            Sign out everywhere
          </Button>
        </div>

        <Separator className="my-4" />

        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Sessions unavailable</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {sessions === null ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <ul className="divide-border divide-y">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {session.userAgent ?? 'Unidentified client'}
                    {session.current && (
                      <span className="text-active ml-2 text-xs font-medium">This browser</span>
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    Signed in {formatTime(session.createdAt)} · last used{' '}
                    {formatTime(session.lastSeenAt)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void revokeOne(session)}
                  disabled={busyId !== null}
                  aria-label={`Revoke session ${session.id}`}
                >
                  {session.current ? 'Sign out' : 'Revoke'}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/** Stored in UTC, shown in the reader's own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'

  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
