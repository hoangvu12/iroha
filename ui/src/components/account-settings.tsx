import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { fetchRetention, updateRetention, SettingsError, type RetentionView } from '@/lib/settings'
import { formatTime as formatTimeWithUtc } from '@/lib/time'

interface AccountSettingsProps {
  readonly state: AuthState
  /** Called when this browser's own session ends, so the shell can step back. */
  readonly onSignedOut: () => void
}

/**
 * The Owner's account area: who is signed in, which browsers hold a live
 * session, the request-history retention window, and (later) other global
 * settings. Revocation is the useful action here, so it sits next to each row
 * rather than behind a menu.
 */
export function AccountSettings({ state, onSignedOut }: AccountSettingsProps) {
  const csrfToken = state.session?.csrfToken ?? ''
  const [sessions, setSessions] = useState<readonly SessionSummary[] | null>(null)
  const [sessionsError, setSessionsError] = useState<AuthError | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [retention, setRetention] = useState<RetentionView | null>(null)
  const [retentionDraft, setRetentionDraft] = useState<string>('30')
  const [retentionError, setRetentionError] = useState<string | null>(null)
  const [retentionBusy, setRetentionBusy] = useState(false)

  const reloadSessions = useCallback(async () => {
    try {
      setSessions(await fetchSessions())
      setSessionsError(null)
    } catch (cause) {
      if (cause instanceof AuthError && cause.code === 'authentication_required') {
        onSignedOut()
        return
      }
      setSessionsError(cause instanceof AuthError ? cause : new AuthError('request_failed', 'Load failed.'))
    }
  }, [onSignedOut])

  useEffect(() => {
    void reloadSessions()
  }, [reloadSessions])

  useEffect(() => {
    let cancelled = false
    fetchRetention()
      .then((value) => {
        if (cancelled) return
        setRetention(value)
        setRetentionDraft(String(value.days))
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setRetentionError(
          cause instanceof SettingsError ? cause.message : 'Retention could not be loaded.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [])

  const revokeOne = async (session: SessionSummary) => {
    setBusyId(session.id)
    try {
      await revokeSession(session.id, csrfToken)
      if (session.current) onSignedOut()
      else await reloadSessions()
    } catch (cause) {
      setSessionsError(cause instanceof AuthError ? cause : new AuthError('request_failed', 'Revoke failed.'))
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
      setSessionsError(cause instanceof AuthError ? cause : new AuthError('request_failed', 'Revoke failed.'))
    } finally {
      setBusyId(null)
    }
  }

  const saveRetention = (event: FormEvent) => {
    event.preventDefault()
    const parsed = Number(retentionDraft)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
      setRetentionError('Retention must be an integer between 0 and 3650 days.')
      return
    }
    setRetentionBusy(true)
    setRetentionError(null)
    updateRetention(parsed, csrfToken)
      .then((value) => {
        setRetention(value)
        setRetentionDraft(String(value.days))
      })
      .catch((cause: unknown) => {
        setRetentionError(
          cause instanceof SettingsError ? cause.message : 'Retention could not be saved.',
        )
      })
      .finally(() => setRetentionBusy(false))
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

        {sessionsError && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Sessions unavailable</AlertTitle>
            <AlertDescription>{sessionsError.message}</AlertDescription>
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

      <section>
        <h2 className="text-base font-semibold tracking-tight">Request history</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          How long Iroha keeps inference metadata. Zero disables storage entirely — useful when
          storage is unwanted and a fresh install needs to drop history before any inference has
          happened.
        </p>

        <Separator className="my-4" />

        {retentionError && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Retention could not be saved</AlertTitle>
            <AlertDescription>{retentionError}</AlertDescription>
          </Alert>
        )}

        {retention === null ? (
          <Skeleton className="h-12 w-full" />
        ) : (
          <form className="bg-card flex flex-col gap-2 rounded-lg border p-3" onSubmit={saveRetention}>
            <Label htmlFor="retention-days">Retention (days)</Label>
            <div className="flex items-center gap-2">
              <Input
                id="retention-days"
                type="number"
                min={0}
                max={3650}
                value={retentionDraft}
                onChange={(event) => setRetentionDraft(event.target.value)}
                aria-describedby="retention-hint"
              />
              <Button type="submit" size="sm" disabled={retentionBusy}>
                {retentionBusy ? 'Saving…' : 'Save'}
              </Button>
            </div>
            <p id="retention-hint" className="text-muted-foreground text-xs">
              Currently {retention.enabled ? `${retention.days} day${retention.days === 1 ? '' : 's'}` : 'disabled'}.
            </p>
          </form>
        )}
      </section>
    </div>
  )
}

function formatTime(iso: string): string {
  return formatTimeWithUtc(iso, { dateStyle: 'medium', timeStyle: 'short' })
}