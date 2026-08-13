import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { KeyRound } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import {
  AuthError,
  fetchSessions,
  revokeAllSessions,
  revokeSession,
  type AuthState,
  type SessionSummary,
} from '@/lib/auth'
import { fetchRetention, updateRetention, SettingsError, type RetentionView } from '@/lib/settings'
import { formatTime } from '@/lib/time'

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
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </header>

      <section>
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-semibold tracking-tight">Owner</h2>
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          This installation has one Owner account. Setup is closed and cannot create another.
        </p>
        <Separator className="my-4" />
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground text-xs">Signed in as</span>
          <span className="text-sm font-medium">{state.owner?.username ?? '—'}</span>
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold tracking-tight">Sessions</h2>
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
          <div className="flex flex-col gap-2">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title="No sessions"
            description="There are no active sessions for this account."
            compact
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                busy={busyId !== null}
                onRevoke={() => void revokeOne(session)}
              />
            ))}
          </ul>
        )}
      </section>

      <section>
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Request history</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            How long Iroha keeps inference metadata. Zero disables storage entirely — useful
            when storage is unwanted and a fresh install needs to drop history before any
            inference has happened.
          </p>
        </div>

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
          <form className="flex flex-wrap items-end gap-3" onSubmit={saveRetention}>
            <div className="flex w-40 flex-col gap-1.5">
              <label htmlFor="retention-days" className="text-muted-foreground text-xs">
                Retention (days)
              </label>
              <Input
                id="retention-days"
                type="number"
                min={0}
                max={3650}
                value={retentionDraft}
                onChange={(event) => setRetentionDraft(event.target.value)}
              />
            </div>
            <div className="text-muted-foreground flex flex-1 items-center pb-2 text-xs">
              Currently{' '}
              {retention.enabled
                ? `${retention.days} day${retention.days === 1 ? '' : 's'}`
                : 'disabled'}
              .
            </div>
            <Button type="submit" size="sm" disabled={retentionBusy}>
              {retentionBusy ? 'Saving…' : 'Save'}
            </Button>
          </form>
        )}
      </section>
    </div>
  )
}

function SessionRow({
  session,
  busy,
  onRevoke,
}: {
  readonly session: SessionSummary
  readonly busy: boolean
  readonly onRevoke: () => void
}) {
  return (
    <li>
      <div className="bg-card hover:bg-muted/40 flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm">
            {session.userAgent ?? 'Unidentified client'}
            {session.current && (
              <span className="text-active ml-2 text-xs font-medium">This browser</span>
            )}
          </span>
          <span className="text-muted-foreground text-xs">
            Signed in {formatTime(session.createdAt)} · last used{' '}
            {formatTime(session.lastSeenAt)}
          </span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onRevoke}
          disabled={busy}
          aria-label={`Revoke session ${session.id}`}
        >
          {session.current ? 'Sign out' : 'Revoke'}
        </Button>
      </div>
    </li>
  )
}