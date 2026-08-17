import { useEffect, useState, type FormEvent } from 'react'
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
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
import { ApiError, toApiError } from '@/lib/api-client'
import type {
  CreatedGatewayKey,
  GatewayKeyAccess,
  GatewayKeyScopeEntry,
  GatewayKeyView,
} from '@/lib/gateway-keys'
import type { ProviderView } from '@/lib/providers'
import { useProviders } from '@/lib/use-providers'
import {
  useCreateGatewayKey,
  useDeleteGatewayKey,
  useGatewayKeys,
  useRevokeGatewayKey,
  useUpdateGatewayKey,
  type GatewayKeyEdit,
} from '@/lib/use-gateway-keys'

/**
 * The Gateway Keys area. Lists every key with its name, scope, and revocation
 * state, and creates a new key when the Owner asks for one. The usable secret
 * is shown once on creation; this view never re-renders it.
 */
export function GatewayKeysArea({ csrfToken }: { readonly csrfToken: string }) {
  const keys = useGatewayKeys()
  // The Key Scope picker needs the Provider list; this screen is only another
  // reader of the cache entry the Providers area writes.
  const providers = useProviders()
  const [creating, setCreating] = useState(false)
  const [issued, setIssued] = useState<CreatedGatewayKey | null>(null)

  const loadFailure = keys.error ?? providers.error
  const rows = keys.data
  const activeProviders = (providers.data ?? []).filter((provider) => !provider.archived)

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Gateway Keys</h1>
        {(rows === undefined || rows.length > 0) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setCreating(true)
              setIssued(null)
            }}
            disabled={rows === undefined || providers.data === undefined}
          >
            <Plus className="size-3.5" aria-hidden />
            New Gateway Key
          </Button>
        )}
      </header>

      {loadFailure && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Gateway Keys unavailable</AlertTitle>
          <AlertDescription>{toApiError(loadFailure).message}</AlertDescription>
        </Alert>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Gateway Key</DialogTitle>
            <DialogDescription>
              An application credential that authenticates against the Gateway. Scoped to
              one or more Providers with optional exact model restrictions.
            </DialogDescription>
          </DialogHeader>
          <CreateGatewayKeyForm
              providers={activeProviders}
              csrfToken={csrfToken}
              onCreated={(created) => {
                setCreating(false)
                setIssued(created)
              }}
            />
        </DialogContent>
      </Dialog>

      {issued && <IssuedSecret keyView={issued} />}

      {rows === undefined ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : rows.length === 0 ? (
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
          {rows.map((key) => (
            <GatewayKeyRow
              key={key.id}
              keyView={key}
              providers={providers.data ?? []}
              csrfToken={csrfToken}
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
  providers,
  csrfToken,
}: {
  readonly keyView: GatewayKeyView
  readonly providers: readonly ProviderView[]
  readonly csrfToken: string
}) {
  const [editing, setEditing] = useState(false)
  const update = useUpdateGatewayKey(csrfToken)
  const revoke = useRevokeGatewayKey(csrfToken)
  const remove = useDeleteGatewayKey(csrfToken)

  // One row's own mutations, not the table's: a key being revoked must not
  // freeze the key next to it.
  const busy = update.isPending || revoke.isPending || remove.isPending

  const confirmDelete = () => {
    if (!window.confirm(`Permanently delete revoked Gateway Key "${keyView.name}"? Historical requests and audit events will remain.`)) return
    remove.mutate({ id: keyView.id, name: keyView.name })
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
          access={keyView.access}
          scope={keyView.scope}
          providers={providers}
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
              <DropdownMenuItem onSelect={() => setEditing(true)}>
                <Pencil className="size-4" aria-hidden />
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => revoke.mutate({ id: keyView.id, name: keyView.name })}
              >
                Revoke
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {keyView.revoked && (
          <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={confirmDelete}>
            Delete
          </Button>
        )}
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Gateway Key</DialogTitle>
            <DialogDescription>Changes apply to new Requests. Already admitted Requests may finish.</DialogDescription>
          </DialogHeader>
          <EditGatewayKeyForm
            keyView={keyView}
            providers={providers}
            csrfToken={csrfToken}
            onSubmit={(edit) => {
              // The patched row is the confirmation, so the dialog gets out of
              // the way immediately; a refusal rolls the row back and toasts.
              setEditing(false)
              update.mutate({ id: keyView.id, edit })
            }}
          />
        </DialogContent>
      </Dialog>
    </li>
  )
}

function EditGatewayKeyForm({
  keyView,
  providers,
  csrfToken,
  onSubmit,
}: {
  readonly keyView: GatewayKeyView
  readonly providers: readonly ProviderView[]
  readonly csrfToken: string
  readonly onSubmit: (edit: GatewayKeyEdit) => void
}) {
  const [name, setName] = useState(keyView.name)
  const [accessMode, setAccessMode] = useState<'all' | 'selected'>(keyView.access.mode)
  const initialProviders = keyView.access.mode === 'selected' ? keyView.access.providers : []
  const [selected, setSelected] = useState<Record<string, { enabled: boolean; models: readonly string[] }>>(
    () => Object.fromEntries(providers.map((provider) => {
      const entry = initialProviders.find((candidate) => candidate.providerId === provider.id)
      return [provider.id, { enabled: entry !== undefined, models: entry?.models ?? [] }]
    })),
  )
  const [corsOrigins, setCorsOrigins] = useState(keyView.corsOrigins)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const scoped = providers.flatMap((provider) => {
      const entry = selected[provider.id]
      return entry?.enabled
        ? [{ providerId: provider.id, models: entry.models.length === 0 ? null : entry.models }]
        : []
    })
    onSubmit({
      // Read off the prop, never off form state: an optimistic edit has already
      // advanced the cached row, and the next submit must carry that revision.
      revision: keyView.revision,
      name,
      access: accessMode === 'all' ? { mode: 'all' } : { mode: 'selected', providers: scoped },
      corsOrigins,
    })
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={submit}>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`gateway-key-edit-name-${keyView.id}`}>Name</Label>
        <Input id={`gateway-key-edit-name-${keyView.id}`} value={name} onChange={(event) => setName(event.target.value)} required />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Access</legend>
        <label className="border-border flex items-center gap-3 rounded-md border p-3">
          <Checkbox checked={accessMode === 'all'} onCheckedChange={(value) => setAccessMode(value === true ? 'all' : 'selected')} />
          <span className="text-sm font-medium">All Providers</span>
        </label>
        {accessMode === 'selected' && (
          <ul className="border-border overflow-hidden rounded-md border">
            {providers.map((provider, index) => {
              const entry = selected[provider.id] ?? { enabled: false, models: [] }
              return (
                <li key={provider.id} className={cn('flex flex-col gap-2 p-3', index > 0 && 'border-border border-t')}>
                  <label className="flex items-center gap-3">
                    <Checkbox checked={entry.enabled} onCheckedChange={(value) => setSelected((current) => ({ ...current, [provider.id]: { ...entry, enabled: value === true } }))} />
                    <span className="text-sm font-medium">{provider.displayName}</span>
                  </label>
                  {entry.enabled && <ModelListPicker providerId={provider.id} csrfToken={csrfToken} selected={entry.models} onChange={(models) => setSelected((current) => ({ ...current, [provider.id]: { ...entry, models } }))} />}
                </li>
              )
            })}
          </ul>
        )}
      </fieldset>
      <CorsOriginsField origins={corsOrigins} onChange={setCorsOrigins} />
      <div className="flex justify-end"><Button type="submit" size="sm">Save changes</Button></div>
    </form>
  )
}

/**
 * A visual summary of a Gateway Key's scope: one small provider icon per
 * scoped provider (capped at four), a "+N" tile if more, plus a small marker
 * for model restrictions and one for CORS origins.
 */
function ScopeIcons({
  access,
  scope,
  providers,
  hasCorsOrigins,
  className,
}: {
  readonly access: GatewayKeyAccess
  readonly scope: readonly GatewayKeyScopeEntry[]
  readonly providers: readonly ProviderView[]
  readonly hasCorsOrigins: boolean
  readonly className?: string
}) {
  if (access.mode === 'all') {
    return (
      <span className={cn('border-border bg-muted text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', className)}>
        <SlidersHorizontal className="size-3" aria-hidden strokeWidth={1.5} />
        All Providers
      </span>
    )
  }
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
          const provider = providers.find((p) => p.id === entry.providerId)
          const label = provider?.displayName ?? entry.providerId
          const title = entry.models === null
            ? `${label} · all models`
            : entry.models.length === 0
              ? `${label} · no models`
              : `${label} · ${entry.models.join(', ')}`
          return (
            <span
              key={entry.providerId}
              title={title}
              className="ring-card inline-flex ring-2"
            >
              <ProviderIcon
                logoDomain={provider?.logoDomain ?? null}
                size="sm"
              />
            </span>
          )
        })}
        {overflow > 0 && (
          <span
            title={`${overflow} more provider${overflow === 1 ? '' : 's'}`}
            className="border-border bg-muted text-muted-foreground ring-card flex size-6 items-center justify-center rounded-md border text-[10px] font-medium tabular-nums ring-2"
          >
            +{overflow}
          </span>
        )}
      </div>
      {hasModelRestrictions && (
        <span
          title="One or more providers restrict this key to specific model IDs."
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
  providers,
  csrfToken,
  onCreated,
}: {
  readonly providers: readonly ProviderView[]
  readonly csrfToken: string
  readonly onCreated: (created: CreatedGatewayKey) => void
}) {
  const [name, setName] = useState('')
  const [accessMode, setAccessMode] = useState<'all' | 'selected'>('all')
  const [selected, setSelected] = useState<
    Record<string, { enabled: boolean; models: readonly string[] }>
  >(() =>
    Object.fromEntries(
      providers.map((p) => [p.id, { enabled: false, models: [] as readonly string[] }]),
    ),
  )
  const [corsOrigins, setCorsOrigins] = useState<readonly string[]>([])
  const [error, setError] = useState<ApiError | null>(null)
  const create = useCreateGatewayKey(csrfToken)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (create.isPending) return

    const scope: GatewayKeyScopeEntry[] = providers.flatMap((provider) => {
      const entry = selected[provider.id]
      if (entry === undefined || !entry.enabled) return []
      return [{ providerId: provider.id, models: entry.models.length === 0 ? null : entry.models }]
    })

    if (accessMode === 'selected' && scope.length === 0) {
      setError(new ApiError('validation_failed', 'Choose at least one Provider.'))
      return
    }

    setError(null)
    const access: GatewayKeyAccess = accessMode === 'all'
      ? { mode: 'all' }
      : { mode: 'selected', providers: scope }
    // The dialog stays open until the Gateway answers, because only its answer
    // carries the secret. A refusal therefore reports itself here, in front of
    // the input the Owner still has, rather than as a toast about a row that
    // does not exist yet.
    create.mutate(
      { name, access, corsOrigins },
      {
        onSuccess: onCreated,
        onError: (cause) => setError(toApiError(cause)),
      },
    )
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
            Tick a Provider to grant this key access. Pick specific models to
            narrow further.
          </span>
        </legend>
        <label className="border-border flex items-center gap-3 rounded-md border p-3">
          <Checkbox
            checked={accessMode === 'all'}
            onCheckedChange={(value) => setAccessMode(value === true ? 'all' : 'selected')}
          />
          <span className="flex flex-col">
            <span className="text-sm font-medium">All Providers</span>
            <span className="text-muted-foreground text-xs">Includes Providers created or restored later.</span>
          </span>
        </label>
        {accessMode === 'selected' && <ul className="border-border overflow-hidden rounded-md border">
          {providers.map((provider, index) => {
            const entry = selected[provider.id] ?? { enabled: false, models: [] }
            return (
              <li
                key={provider.id}
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
                        [provider.id]: { ...entry, enabled: value === true },
                      }))
                    }
                  />
                  <ProviderIcon
                    logoDomain={provider.logoDomain}
                    size="sm"
                  />
                  <span className="truncate text-sm font-medium">
                    {provider.displayName}
                  </span>
                </div>
                {entry.enabled && (
                  <ModelListPicker
                    providerId={provider.id}
                    csrfToken={csrfToken}
                    selected={entry.models}
                    onChange={(models) =>
                      setSelected((current) => ({
                        ...current,
                        [provider.id]: { ...entry, models },
                      }))
                    }
                    className="ml-7 max-w-md"
                  />
                )}
              </li>
            )
          })}
        </ul>}
      </fieldset>

      <CorsOriginsField origins={corsOrigins} onChange={setCorsOrigins} />

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-end pt-1">
        <Button type="submit" size="sm" disabled={create.isPending}>
          {create.isPending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {create.isPending ? 'Creating…' : 'Create Gateway Key'}
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
        <CopySecretButton secret={keyView.secret} />
      </AlertDescription>
    </Alert>
  )
}

/** How long the copied confirmation stays on the control. */
const COPIED_LABEL_MS = 1500

function CopySecretButton({ secret }: { readonly secret: string }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), COPIED_LABEL_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(secret)
      } else {
        // A gateway served over plain http is not a secure context, so the
        // clipboard API is absent and the selection trick is the only route.
        const textarea = document.createElement('textarea')
        textarea.value = secret
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'absolute'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="mt-2"
      onClick={() => void copy()}
      aria-live="polite"
    >
      {copied ? (
        <>
          <Check className="size-3" aria-hidden />
          Copied
        </>
      ) : (
        <>
          <Copy className="size-3" aria-hidden />
          Copy
        </>
      )}
    </Button>
  )
}
