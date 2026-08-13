import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  KeyRound,
  MoreHorizontal,
  Plus,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Card } from '@/components/card'
import { EmptyState } from '@/components/empty-state'
import { ModelListPicker } from '@/components/model-list-picker'
import { ProviderIcon } from '@/components/provider-icon'
import { StatusBadge } from '@/components/status-badge'
import { cn } from '@/lib/utils'
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
      setError(
        cause instanceof GatewayKeyError ? cause : new GatewayKeyError('request_failed', 'Load failed.'),
      )
    }
  }, [onSignedOut])

  useEffect(() => {
    void reload()
  }, [reload])

  const activeConnections = (connections ?? []).filter((c) => !c.archived)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Gateway Keys</h1>
        {(keys === null || keys.length > 0) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setCreating(true)
              setIssued(null)
            }}
            disabled={keys === null || connections === null}
          >
            <Plus className="size-3.5" aria-hidden />
            New Gateway Key
          </Button>
        )}
      </header>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Gateway Keys unavailable</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Gateway Key</DialogTitle>
            <DialogDescription>
              An application credential that authenticates against the Gateway. Scoped to
              one or more Provider Connections with optional exact model restrictions.
            </DialogDescription>
          </DialogHeader>
          {activeConnections.length > 0 ? (
            <CreateGatewayKeyForm
              connections={activeConnections}
              csrfToken={csrfToken}
              onCreated={(created) => {
                setCreating(false)
                setIssued(created)
                void reload()
              }}
              onFailure={setError}
            />
          ) : (
            <Alert role="status">
              <AlertTitle>Create a Provider Connection first</AlertTitle>
              <AlertDescription>
                Gateway Keys need at least one Provider Connection to scope to. Add one in the
                Providers area, then return here.
              </AlertDescription>
            </Alert>
          )}
        </DialogContent>
      </Dialog>

      {issued && <IssuedSecret keyView={issued} />}

      {keys === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : keys.length === 0 ? (
        <Card>
          <EmptyState
            icon={KeyRound}
            title="No Gateway Keys yet"
            description="Create the first one to give an application access to the Gateway."
            action={{ label: 'New Gateway Key', onClick: () => setCreating(true) }}
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {keys.map((key) => (
            <GatewayKeyRow
              key={key.id}
              keyView={key}
              connections={connections ?? []}
              csrfToken={csrfToken}
              onChanged={() => void reload()}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

const MAX_SCOPE_ICONS = 4

function GatewayKeyRow({
  keyView,
  connections,
  csrfToken,
  onChanged,
}: {
  readonly keyView: GatewayKeyView
  readonly connections: readonly ConnectionView[]
  readonly csrfToken: string
  readonly onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GatewayKeyError | null>(null)

  const runRevoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await revokeGatewayKey(keyView.id, csrfToken)
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof GatewayKeyError
          ? cause
          : new GatewayKeyError('request_failed', 'That did not work.'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <li>
      <div className="bg-card hover:bg-muted/40 flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors">
        <span
          aria-hidden
          className="border-border bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg border"
        >
          <KeyRound className="size-4" strokeWidth={1.5} />
        </span>
        <span className="truncate text-sm font-medium tracking-tight">{keyView.name}</span>
        <StatusBadge
          tone={keyView.revoked ? 'neutral' : 'healthy'}
          label={keyView.revoked ? 'Revoked' : 'Active'}
        />
        <ScopeIcons
          scope={keyView.scope}
          connections={connections}
          hasCorsOrigins={keyView.corsOrigins.length > 0}
          className="ml-auto"
        />
        {!keyView.revoked && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Key actions for ${keyView.name}`}
                disabled={busy}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void runRevoke()}
                disabled={busy}
              >
                {busy ? 'Revoking…' : 'Revoke'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {error && (
        <Alert variant="destructive" role="alert" className="mt-2">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}
    </li>
  )
}

/**
 * A visual summary of a Gateway Key's scope: one small provider icon per
 * scoped connection (capped at four), a "+N" tile if more, plus a small marker
 * for model restrictions and one for CORS origins.
 */
function ScopeIcons({
  scope,
  connections,
  hasCorsOrigins,
  className,
}: {
  readonly scope: readonly GatewayKeyScopeEntry[]
  readonly connections: readonly ConnectionView[]
  readonly hasCorsOrigins: boolean
  readonly className?: string
}) {
  if (scope.length === 0) {
    return (
      <span
        className={cn(
          'border-border bg-muted text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs',
          className,
        )}
      >
        <SlidersHorizontal className="size-3" aria-hidden strokeWidth={1.5} />
        No scope
      </span>
    )
  }

  const hasModelRestrictions = scope.some(
    (entry) => entry.models !== null && entry.models.length > 0,
  )

  const shown = scope.slice(0, MAX_SCOPE_ICONS)
  const overflow = scope.length - MAX_SCOPE_ICONS

  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)}>
      <div className="flex items-center -space-x-1.5">
        {shown.map((entry) => {
          const conn = connections.find((c) => c.id === entry.connectionId)
          const label = conn?.displayName ?? entry.connectionId
          const baseUrl = conn?.baseUrl ?? ''
          const title = entry.models === null
            ? `${label} · all models`
            : entry.models.length === 0
              ? `${label} · no models`
              : `${label} · ${entry.models.join(', ')}`
          return (
            <span
              key={entry.connectionId}
              title={title}
              className="ring-card inline-flex ring-2"
            >
              <ProviderIcon displayName={label} baseUrl={baseUrl} size="sm" />
            </span>
          )
        })}
        {overflow > 0 && (
          <span
            title={`${overflow} more connection${overflow === 1 ? '' : 's'}`}
            className="border-border bg-muted text-muted-foreground ring-card flex size-6 items-center justify-center rounded-md border text-[10px] font-medium tabular-nums ring-2"
          >
            +{overflow}
          </span>
        )}
      </div>
      {hasModelRestrictions && (
        <span
          title="One or more connections restrict this key to specific model IDs."
          className="bg-status-warning/10 text-status-warning border-status-warning/30 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
        >
          Restricted
        </span>
      )}
      {hasCorsOrigins && (
        <span
          title="Allows browser calls from specific origins."
          className="bg-muted text-muted-foreground border-border inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
        >
          CORS
        </span>
      )}
    </div>
  )
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
    Record<string, { enabled: boolean; models: readonly string[] }>
  >(() =>
    Object.fromEntries(
      connections.map((c) => [c.id, { enabled: false, models: [] as readonly string[] }]),
    ),
  )
  const [corsOrigins, setCorsOrigins] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GatewayKeyError | null>(null)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return

    const scope: GatewayKeyScopeEntry[] = connections.flatMap((connection) => {
      const entry = selected[connection.id]
      if (entry === undefined || !entry.enabled) return []
      return [{ connectionId: connection.id, models: entry.models.length === 0 ? null : entry.models }]
    })

    if (scope.length === 0) {
      setError(new GatewayKeyError('validation_failed', 'Choose at least one Provider Connection.'))
      return
    }

    setBusy(true)
    setError(null)
    createGatewayKey({ name, scope, corsOrigins: [...corsOrigins] }, csrfToken)
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
    <form className="flex flex-col gap-5" onSubmit={submit} noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="gateway-key-name">Name</Label>
        <Input
          id="gateway-key-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. staging-bot"
          autoComplete="off"
          required
          autoFocus
        />
        <p className="text-muted-foreground text-xs">
          How this key will appear in the keys list and the audit log.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="flex flex-col gap-0.5">
          <span className="text-sm font-medium">Scope</span>
          <span className="text-muted-foreground text-xs">
            Tick a Provider Connection to grant this key access. Pick specific models to
            narrow further.
          </span>
        </legend>
        <ul className="border-border overflow-hidden rounded-md border">
          {connections.map((connection, index) => {
            const entry = selected[connection.id] ?? { enabled: false, models: [] }
            return (
              <li
                key={connection.id}
                className={cn(
                  'flex flex-col gap-2 p-3 transition-colors',
                  entry.enabled && 'bg-muted/40',
                  index > 0 && 'border-border border-t',
                )}
              >
                <div className="flex items-center gap-3">
                  <Checkbox
                    checked={entry.enabled}
                    onCheckedChange={(value) =>
                      setSelected((current) => ({
                        ...current,
                        [connection.id]: { ...entry, enabled: value === true },
                      }))
                    }
                  />
                  <ProviderIcon
                    displayName={connection.displayName}
                    baseUrl={connection.baseUrl}
                    size="sm"
                  />
                  <span className="truncate text-sm font-medium">
                    {connection.displayName}
                  </span>
                </div>
                {entry.enabled && (
                  <ModelListPicker
                    connectionId={connection.id}
                    csrfToken={csrfToken}
                    selected={entry.models}
                    onChange={(models) =>
                      setSelected((current) => ({
                        ...current,
                        [connection.id]: { ...entry, models },
                      }))
                    }
                    className="ml-7 max-w-md"
                  />
                )}
              </li>
            )
          })}
        </ul>
      </fieldset>

      <CorsOriginsField origins={corsOrigins} onChange={setCorsOrigins} />

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-end pt-1">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Creating…' : 'Create Gateway Key'}
        </Button>
      </div>
    </form>
  )
}

function CorsOriginsField({
  origins,
  onChange,
}: {
  readonly origins: readonly string[]
  readonly onChange: (next: readonly string[]) => void
}) {
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)

  const add = () => {
    const value = draft.trim()
    if (value === '') return
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      setDraftError('Not a valid URL.')
      return
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setDraftError('Origins must start with http:// or https://.')
      return
    }
    if (origins.includes(value)) {
      setDraftError('That origin is already in the list.')
      return
    }
    onChange([...origins, value])
    setDraft('')
    setDraftError(null)
  }

  const remove = (origin: string) => {
    onChange(origins.filter((existing) => existing !== origin))
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="gateway-key-cors" className="text-muted-foreground font-normal">
        Browser origins <span className="opacity-70">(optional)</span>
      </Label>
      <p className="text-muted-foreground text-xs">
        Exact browser origins allowed to call the Gateway with this key. Leave empty to
        allow any origin.
      </p>
      {origins.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {origins.map((origin) => (
            <li key={origin}>
              <span className="border-border bg-muted text-foreground inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-xs">
                {origin}
                <button
                  type="button"
                  onClick={() => remove(origin)}
                  aria-label={`Remove ${origin}`}
                  className="text-muted-foreground hover:text-foreground -mr-1 ml-0.5 inline-flex size-4 items-center justify-center rounded transition-colors"
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Input
            id="gateway-key-cors"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              if (draftError !== null) setDraftError(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                add()
              }
            }}
            placeholder="https://app.example.com"
            autoComplete="off"
            className="font-mono text-xs"
            aria-invalid={draftError !== null}
          />
          {draftError && (
            <p className="text-status-danger text-xs">{draftError}</p>
          )}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={add}
          disabled={draft.trim() === ''}
        >
          <Plus className="size-3.5" aria-hidden />
          Add
        </Button>
      </div>
    </div>
  )
}

function IssuedSecret({ keyView }: { readonly keyView: CreatedGatewayKey }) {
  return (
    <Alert role="status">
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