import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  createGatewayKey,
  fetchGatewayKeys,
  GatewayKeyError,
  revokeGatewayKey,
  type CreatedGatewayKey,
  type GatewayKeyScopeEntry,
  type GatewayKeyView,
} from '@/lib/gateway-keys'
import { fetchConnections, type ConnectionView } from '@/lib/providers'

/**
 * The Gateway Keys area. Lists every key with its name, scope, and revocation
 * state, and creates a new key when the Owner asks for one. The usable secret
 * is shown once on creation; this view never re-renders it.
 */
export function GatewayKeysArea({
  csrfToken,
  onSignedOut,
}: {
  readonly csrfToken: string
  readonly onSignedOut: () => void
}) {
  const [keys, setKeys] = useState<readonly GatewayKeyView[] | null>(null)
  const [connections, setConnections] = useState<readonly ConnectionView[] | null>(null)
  const [error, setError] = useState<GatewayKeyError | null>(null)
  const [creating, setCreating] = useState(false)
  const [issued, setIssued] = useState<CreatedGatewayKey | null>(null)

  const reload = useCallback(async () => {
    try {
      const [loaded, conns] = await Promise.all([fetchGatewayKeys(), fetchConnections()])
      setKeys(loaded)
      setConnections(conns)
      setError(null)
    } catch (cause: unknown) {
      if (cause instanceof GatewayKeyError && cause.code === 'authentication_required') {
        onSignedOut()
        return
      }
      setError(cause instanceof GatewayKeyError ? cause : new GatewayKeyError('request_failed', 'Load failed.'))
    }
  }, [onSignedOut])

  useEffect(() => {
    void reload()
  }, [reload])

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Gateway Keys</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Application credentials that authenticate against the Gateway. Each one is
              restricted to a set of Provider Connections and optional exact model IDs.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setCreating((open) => !open)
              setIssued(null)
            }}
            disabled={keys === null || connections === null}
          >
            {creating ? 'Close form' : 'New Gateway Key'}
          </Button>
        </div>

        <Separator className="my-4" />

        {issued && <IssuedSecret keyView={issued} />}

        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Gateway Keys unavailable</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {creating && connections && connections.filter((c) => !c.archived).length > 0 && (
          <CreateGatewayKeyForm
            connections={connections.filter((c) => !c.archived)}
            csrfToken={csrfToken}
            onCreated={(created) => {
              setCreating(false)
              setIssued(created)
              void reload()
            }}
            onFailure={setError}
          />
        )}

        {creating && connections && connections.filter((c) => !c.archived).length === 0 && (
          <Alert role="status" className="mb-4">
            <AlertTitle>Create a Provider Connection first</AlertTitle>
            <AlertDescription>
              Gateway Keys need at least one Provider Connection to scope to. Add one in the
              Providers area, then return here.
            </AlertDescription>
          </Alert>
        )}

        {keys === null ? (
          <Skeleton className="h-16 w-full" />
        ) : keys.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">
            No Gateway Keys yet. Create the first one to give an application access to the
            Gateway.
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {keys.map((key) => (
              <GatewayKeyRow
                key={key.id}
                keyView={key}
                csrfToken={csrfToken}
                onChanged={() => void reload()}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function GatewayKeyRow({
  keyView,
  csrfToken,
  onChanged,
}: {
  readonly keyView: GatewayKeyView
  readonly csrfToken: string
  readonly onChanged: () => void
}) {
  const [confirmingRevoke, setConfirmingRevoke] = useState(false)
  const [error, setError] = useState<GatewayKeyError | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async (perform: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await perform()
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof GatewayKeyError
          ? cause
          : new GatewayKeyError('request_failed', 'That did not work.'),
      )
    } finally {
      setBusy(false)
      setConfirmingRevoke(false)
    }
  }

  return (
    <li className="flex flex-col gap-2 py-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{keyView.name}</span>
          {keyView.revoked ? (
            <Badge variant="secondary">Revoked</Badge>
          ) : (
            <Badge variant="default">Active</Badge>
          )}
          <span className="text-muted-foreground font-mono text-xs">{keyView.id}</span>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {!keyView.revoked && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                if (confirmingRevoke) {
                  void run(() => revokeGatewayKey(keyView.id, csrfToken))
                } else {
                  setConfirmingRevoke(true)
                }
              }}
              onBlur={() => setConfirmingRevoke(false)}
              disabled={busy}
            >
              {busy ? 'Revoking…' : confirmingRevoke ? 'Confirm revoke' : 'Revoke'}
            </Button>
          )}
        </div>
      </div>

      <p className="text-muted-foreground text-xs">
        Created {formatTime(keyView.createdAt)}
        {keyView.lastUsedAt === null ? ' · never used' : ` · last used ${formatTime(keyView.lastUsedAt)}`}
      </p>

      <p className="text-muted-foreground text-xs">{summariseScope(keyView)}</p>

      {keyView.corsOrigins.length > 0 && (
        <p className="text-muted-foreground text-xs">
          CORS origins: {keyView.corsOrigins.join(', ')}
        </p>
      )}

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
    </li>
  )
}

function summariseScope(keyView: GatewayKeyView): string {
  if (keyView.scope.length === 0) return 'No Provider Connections in scope.'
  const parts = keyView.scope.map((entry) => {
    const models = entry.models
    if (models === null) return `${entry.connectionId}: all models`
    if (models.length === 0) return `${entry.connectionId}: no models allowed`
    return `${entry.connectionId}: ${models.join(', ')}`
  })
  return `Scope: ${parts.join('; ')}`
}

function CreateGatewayKeyForm({
  connections,
  csrfToken,
  onCreated,
  onFailure,
}: {
  readonly connections: readonly ConnectionView[]
  readonly csrfToken: string
  readonly onCreated: (created: CreatedGatewayKey) => void
  readonly onFailure: (error: GatewayKeyError) => void
}) {
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<
    Record<string, { enabled: boolean; models: string }>
  >(() =>
    Object.fromEntries(connections.map((c) => [c.id, { enabled: false, models: '' }])),
  )
  const [corsOrigins, setCorsOrigins] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GatewayKeyError | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return

    const scope: GatewayKeyScopeEntry[] = connections.flatMap((connection) => {
      const entry = selected[connection.id]
      if (entry === undefined || !entry.enabled) return []
      const models = entry.models
        .split(',')
        .map((m) => m.trim())
        .filter((m) => m !== '')
      return [{ connectionId: connection.id, models: models.length === 0 ? null : models }]
    })

    if (scope.length === 0) {
      setError(new GatewayKeyError('validation_failed', 'Choose at least one Provider Connection.'))
      return
    }

    const origins = corsOrigins
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== '')

    setBusy(true)
    setError(null)
    createGatewayKey({ name, scope, corsOrigins: origins }, csrfToken)
      .then((created) => onCreated(created))
      .catch((cause: unknown) => {
        const failure =
          cause instanceof GatewayKeyError
            ? cause
            : new GatewayKeyError('request_failed', 'That request could not be completed.')
        setError(failure)
        onFailure(failure)
      })
      .finally(() => setBusy(false))
  }

  return (
    <form className="bg-card mb-4 flex flex-col gap-4 rounded-lg border p-4" onSubmit={submit} noValidate>
      <h3 className="text-sm font-semibold tracking-tight">New Gateway Key</h3>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gateway-key-name">Name</Label>
        <Input
          id="gateway-key-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
          required
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Provider Connections in scope</legend>
        <p className="text-muted-foreground text-xs">
          Tick a connection to include it. Per-connection model restrictions are optional and
          apply only inside that connection.
        </p>
        <ul className="divide-border divide-y rounded-md border">
          {connections.map((connection) => {
            const entry = selected[connection.id] ?? { enabled: false, models: '' }
            return (
              <li key={connection.id} className="flex flex-col gap-2 p-3 md:flex-row md:items-center">
                <label className="flex flex-1 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onChange={(event) =>
                      setSelected((current) => ({
                        ...current,
                        [connection.id]: { ...entry, enabled: event.target.checked },
                      }))
                    }
                    className="size-3.5"
                  />
                  <span className="truncate">{connection.displayName}</span>
                </label>
                <Input
                  aria-label={`Models for ${connection.displayName}`}
                  placeholder="Optional: exact model IDs, comma-separated"
                  value={entry.models}
                  onChange={(event) =>
                    setSelected((current) => ({
                      ...current,
                      [connection.id]: { ...entry, models: event.target.value },
                    }))
                  }
                  disabled={!entry.enabled}
                  className="md:max-w-md"
                />
              </li>
            )
          })}
        </ul>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gateway-key-cors">CORS origins</Label>
        <Input
          id="gateway-key-cors"
          value={corsOrigins}
          onChange={(event) => setCorsOrigins(event.target.value)}
          placeholder="https://app.example.com, https://staging.example.com"
          autoComplete="off"
        />
        <p className="text-muted-foreground text-xs">
          Optional. Comma-separated exact browser origins allowed to call the Gateway with this
          key.
        </p>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Creating…' : 'Create Gateway Key'}
        </Button>
      </div>
    </form>
  )
}

function IssuedSecret({ keyView }: { readonly keyView: CreatedGatewayKey }) {
  return (
    <Alert role="status" className="mb-4">
      <AlertTitle>Gateway Key created</AlertTitle>
      <AlertDescription>
        <p className="mb-2">
          Copy this credential now. Iroha stores only its hash and will not show it again.
        </p>
        <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs break-all">
          {keyView.secret}
        </pre>
      </AlertDescription>
    </Alert>
  )
}

/** Stored in UTC, shown in the reader's own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}