import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { MoreHorizontal, Plus, Server, Trash2 } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Card } from '@/components/card'
import { EmptyState } from '@/components/empty-state'
import { StatusBadge } from '@/components/status-badge'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Dot } from '@/components/dot'
import { LineChart, Line } from '@/components/charts/line-chart'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ProviderIcon } from '@/components/provider-icon'
import {
  Failure,
  Field,
  EditProviderForm,
  toManagementError,
  useSubmission,
} from '@/components/edit-provider-form'
import { BulkKeyInput } from '@/components/bulk-key-input'
import { describeProviderStatus } from '@/lib/provider-status'
import {
  archiveProvider,
  checkProviderHandleAvailability,
  createProvider,
  duplicateProvider,
  fetchProviders,
  fetchProviderTemplates,
  GENERIC_PROVIDER_TEMPLATE,
  GENERIC_PROVIDER_TEMPLATE_BASE_URL,
  GENERIC_PROVIDER_TEMPLATE_ID,
  ManagementError,
  purgeProvider,
  type ProviderTemplateView,
  type ProviderView,
} from '@/lib/providers'
import { fetchRequests } from '@/lib/requests'
import type { BulkKeyEntry } from '@/lib/parse-bulk-keys'
import { useBrandByTemplateId } from '@/lib/use-provider-templates'

interface ProvidersAreaProps {
  readonly csrfToken: string
  readonly onSignedOut: () => void
}

interface ProviderTraffic {
  readonly hourlyCounts: readonly number[]
  readonly reqPerMin: number
}

const HOUR_MS = 60 * 60 * 1000
const TRAFFIC_HOURS = 12

export function ProvidersArea({ csrfToken, onSignedOut }: ProvidersAreaProps) {
  const [providers, setProviders] = useState<readonly ProviderView[] | null>(null)
  const [traffic, setTraffic] = useState<ReadonlyMap<string, ProviderTraffic>>(new Map())
  const [error, setError] = useState<ManagementError | null>(null)
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()

  const reload = useCallback(async () => {
    try {
      const [list, page] = await Promise.all([
        fetchProviders(),
        fetchRequests({}, { limit: 800 }),
      ])
      setProviders(list)
      setTraffic(buildTrafficByProvider(page.events))
      setError(null)
    } catch (cause) {
      if (cause instanceof ManagementError && cause.code === 'authentication_required') {
        onSignedOut()
        return
      }
      setError(toManagementError(cause))
    }
  }, [onSignedOut])

  useEffect(() => {
    void reload()
  }, [reload])

  const active = providers?.filter((p) => !p.archived) ?? null
  const archived = providers?.filter((p) => p.archived) ?? null

  const openProvider = (id: string) => {
    void navigate({ to: '/providers/$providerId', params: { providerId: id } })
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Providers</h1>
        {(active === null || active.length > 0) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreating(true)}
            disabled={providers === null}
          >
            <Plus className="size-3.5" aria-hidden />
            New provider
          </Button>
        )}
      </header>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Providers unavailable</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Provider</DialogTitle>
          </DialogHeader>
          <CreateProviderForm
            csrfToken={csrfToken}
            onCreated={() => {
              setCreating(false)
              void reload()
            }}
            onFailure={setError}
            onCancel={() => setCreating(false)}
          />
        </DialogContent>
      </Dialog>

      {active === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
          <Skeleton className="h-12 w-full rounded-lg" />
        </div>
      ) : active.length === 0 ? (
        <Card>
          <EmptyState
            icon={Server}
            title="No Providers yet"
            description="Create the first one to give your applications an upstream to call."
            action={{ label: 'New provider', onClick: () => setCreating(true) }}
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {active.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              csrfToken={csrfToken}
              traffic={traffic.get(provider.id)}
              onOpen={() => openProvider(provider.id)}
              onChanged={() => void reload()}
            />
          ))}
        </ul>
      )}

      {archived !== null && archived.length > 0 && (
        <section>
          <h2 className="text-base font-semibold tracking-tight">Archived</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Preserved identity and history, removed from active use. Duplicate to bring one
            back, or purge it permanently.
          </p>
          <Separator className="my-4" />
          <ul className="flex flex-col gap-2">
            {archived.map((provider) => (
              <ProviderRow
                key={provider.id}
                provider={provider}
                csrfToken={csrfToken}
                traffic={traffic.get(provider.id)}
                onOpen={() => openProvider(provider.id)}
                onChanged={() => void reload()}
                archived
              />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

function ProviderRow({
  provider,
  csrfToken,
  traffic,
  onOpen,
  onChanged,
  archived = false,
}: {
  readonly provider: ProviderView
  readonly csrfToken: string
  readonly traffic: ProviderTraffic | undefined
  readonly onOpen: () => void
  readonly onChanged: () => void
  readonly archived?: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const { brandFor } = useBrandByTemplateId()
  const [rowError, setRowError] = useState<ManagementError | null>(null)
  const status = describeProviderStatus(provider.keys)

  const run = async (action: string, perform: () => Promise<unknown>) => {
    setBusy(action)
    setRowError(null)
    try {
      await perform()
      onChanged()
    } catch (cause) {
      setRowError(toManagementError(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <li>
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {provider.displayName}</DialogTitle>
            <DialogDescription>
              Editing keeps the provider’s ID unchanged, so client URLs stay valid.
            </DialogDescription>
          </DialogHeader>
          <EditProviderForm
            provider={provider}
            csrfToken={csrfToken}
            onDone={() => {
              setEditing(false)
              onChanged()
            }}
            onCancel={() => setEditing(false)}
          />
        </DialogContent>
      </Dialog>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${provider.displayName}`}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen()
          }
        }}
        className="bg-card hover:bg-muted/40 group flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors"
      >
        <ProviderIcon
          brand={brandFor(provider.templateId)}
          {...(provider.templateId === null ? {} : { templateId: provider.templateId })}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium tracking-tight">
              {provider.displayName}
            </span>
            <span className="text-muted-foreground max-w-40 shrink truncate font-mono text-xs">
              {provider.handle}
            </span>
          </span>
          <span
            className="text-muted-foreground truncate font-mono text-xs"
            title={provider.baseUrl || 'No default base URL set'}
          >
            {provider.baseUrl || '—'}
          </span>
        </span>
        {archived && <StatusBadge tone="neutral" label="Archived" />}
        {!archived && !provider.enabled && (
          <StatusBadge tone="neutral" label="Disabled" />
        )}
        <span className="text-muted-foreground ml-auto hidden items-center gap-1.5 text-xs sm:flex">
          <Dot tone={status.tone} />
          <span className="text-foreground">{status.label}</span>
        </span>

        <ProviderSparkline traffic={traffic} />

        <div
          role="presentation"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <ProviderMenu
            archived={archived}
            busy={busy}
            onEdit={() => setEditing(true)}
            onArchive={() =>
              void run('archive', () => archiveProvider(provider.id, csrfToken))
            }
            onDuplicate={() =>
              void run('duplicate', async () => {
                const handle = window.prompt('Choose the immutable Handle for the duplicated Provider:', `${provider.handle}-2`)
                if (handle === null) return provider
                return await duplicateProvider(provider.id, handle, csrfToken)
              })
            }
            onPurge={() => void run('purge', () => purgeProvider(provider.id, csrfToken))}
          />
        </div>
      </div>

      <div className="text-muted-foreground mt-1 flex items-center gap-2 px-4 text-xs sm:hidden">
        <Dot tone={status.tone} />
        <span>{status.label}</span>
      </div>

      {rowError && (
        <Alert variant="destructive" role="alert" className="mt-2">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{rowError.message}</AlertDescription>
        </Alert>
      )}
    </li>
  )
}

function ProviderMenu({
  archived,
  busy,
  onEdit,
  onArchive,
  onDuplicate,
  onPurge,
}: {
  readonly archived: boolean
  readonly busy: string | null
  readonly onEdit: () => void
  readonly onArchive: () => void
  readonly onDuplicate: () => void
  readonly onPurge: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Provider actions"
          disabled={busy !== null}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onEdit}>Edit provider</DropdownMenuItem>
        {!archived && (
          <DropdownMenuItem onSelect={onArchive} disabled={busy === 'archive'}>
            {busy === 'archive' ? 'Archiving…' : 'Archive'}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={onDuplicate} disabled={busy === 'duplicate'}>
          {busy === 'duplicate' ? 'Duplicating…' : 'Duplicate'}
        </DropdownMenuItem>
        {archived && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={onPurge}
              disabled={busy === 'purge'}
            >
              {busy === 'purge' ? 'Purging…' : 'Purge permanently'}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface CreateProviderKeyRow {
  /** Local row id so React keys stay stable across value edits. */
  readonly rowId: string
  readonly upstreamKey: string
  readonly baseUrl: string
}

function CreateProviderForm({
  csrfToken,
  onCreated,
  onFailure,
  onCancel,
}: {
  readonly csrfToken: string
  readonly onCreated: () => void
  readonly onFailure: (error: ManagementError) => void
  readonly onCancel: () => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [handle, setHandle] = useState('provider')
  const [handleCustomized, setHandleCustomized] = useState(false)
  const [handleSuggestion, setHandleSuggestion] = useState<string | null>(null)
  const [keys, setKeys] = useState<readonly CreateProviderKeyRow[]>(() => [
    { rowId: makeRowId(), upstreamKey: '', baseUrl: '' },
  ])
  // Bulk-mode parsed entries live alongside `keys` so toggling between Single
  // and Bulk does not destroy either. The submit handler picks which array
  // to send based on `keyInputMode`.
  const [bulkKeys, setBulkKeys] = useState<readonly BulkKeyEntry[]>([])
  const [keyInputMode, setKeyInputMode] = useState<'single' | 'bulk'>('single')
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false)
  // Default to the Generic OpenAI-compatible template up front so the Owner
  // never faces a blank selector or a loading state: the template list fetch
  // only widens the dropdown, it does not gate the default.
  const [templateId, setTemplateId] = useState<string | null>(GENERIC_PROVIDER_TEMPLATE_ID)
  const [baseUrl, setBaseUrl] = useState(GENERIC_PROVIDER_TEMPLATE_BASE_URL)
  const [templates, setTemplates] = useState<readonly ProviderTemplateView[]>([
    GENERIC_PROVIDER_TEMPLATE,
  ])
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle) || handle.length > 63) {
      setHandleSuggestion(null)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      checkProviderHandleAvailability(handle, controller.signal)
        .then((result) => setHandleSuggestion(result.available ? null : result.suggestion))
        .catch(() => undefined)
    }, 300)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [handle])

  useEffect(() => {
    const controller = new AbortController()
    fetchProviderTemplates(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return
        setTemplates(list)
        setLoadError(null)
        // Re-point the selection when the defaulted template is not part of
        // the served list (a custom registry); otherwise it stays put.
        const stillValid = list.some((template) => template.id === templateId)
        if (!stillValid) {
          const first = list[0]
          if (first !== undefined) setTemplateId(first.id)
        }
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setTemplates([])
        setLoadError(
          cause instanceof ManagementError ? cause.message : 'Could not load provider templates.',
        )
      })
    return () => controller.abort()
  }, [])

  const selectedTemplate =
    templateId === null
      ? null
      : (templates.find((template) => template.id === templateId) ?? null)

  const templateStatus =
    loadError !== null
      ? 'Could not load templates'
      : templates.length === 0
        ? 'No templates available'
        : selectedTemplate?.displayName ?? 'Pick a template'

  // Auto-fill the default base URL when the Owner picks a template, but
  // never clobber a URL the Owner has typed by hand. The previous template's
  // base URL lives in a ref so the comparison can decide whether the field
  // is still "untouched" (matches what we last seeded) or already carries a
  // custom value. After each template change the ref advances so the next
  // change has the right "last seeded" baseline to compare against.
  const lastAutofilledBaseUrl = useRef<string | null>(GENERIC_PROVIDER_TEMPLATE_BASE_URL)
  useEffect(() => {
    if (selectedTemplate === null) return
    const seeded = selectedTemplate.baseUrl
    if (baseUrl === '' || baseUrl === lastAutofilledBaseUrl.current) {
      setBaseUrl(seeded)
    }
    lastAutofilledBaseUrl.current = seeded
  }, [selectedTemplate])

  const updateKeyRow = useCallback(
    (rowId: string, patch: Partial<CreateProviderKeyRow>) => {
      setKeys((current) =>
        current.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)),
      )
    },
    [],
  )

  const addKeyRow = useCallback(() => {
    setKeys((current) => [
      ...current,
      { rowId: makeRowId(), upstreamKey: '', baseUrl: '' },
    ])
  }, [])

  const removeKeyRow = useCallback((rowId: string) => {
    setKeys((current) => {
      // Always leave at least one row so the form keeps an obvious place for
      // the Owner to type a key. Removing the last row would force the
      // Owner to click "Add another key" before they could submit again.
      if (current.length <= 1) return current
      return current.filter((row) => row.rowId !== rowId)
    })
  }, [])

  const form = useSubmission(async () => {
    await createProvider(
      {
        displayName,
        handle,
        baseUrl,
        keys:
          keyInputMode === 'bulk'
            ? bulkKeys.map((b) => ({ upstreamKey: b.upstreamKey, baseUrl: b.baseUrl }))
            : keys.map((row) => ({ upstreamKey: row.upstreamKey, baseUrl: row.baseUrl })),
        allowInsecureHttp,
        templateId,
      },
      csrfToken,
    )
    onCreated()
  }, onFailure)

  const topLevelKeysProblem = form.problemFor('keys')

  return (
    <form className="flex flex-col gap-4" onSubmit={form.submit} noValidate>
      <Field
        id="new-display-name"
        label="Display name"
        value={displayName}
        onChange={(value) => {
          setDisplayName(value)
          if (!handleCustomized) setHandle(proposeProviderHandle(value))
        }}
        problem={form.problemFor('displayName')}
      />

      <div className="flex flex-col gap-1.5">
        <Field
          id="new-provider-handle"
          label="Provider Handle"
          value={handle}
          onChange={(value) => { setHandle(value); setHandleCustomized(true) }}
          hint="Used in public inference URLs. It can never be renamed after creation."
          problem={form.problemFor('handle')}
        />
        {handleSuggestion !== null && <button type="button" className="text-muted-foreground self-start text-xs underline" onClick={() => { setHandle(handleSuggestion); setHandleCustomized(true) }}>Use available {handleSuggestion}</button>}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-provider-template">Provider template</Label>
        <Select
          value={templateId ?? ''}
          onValueChange={setTemplateId}
          disabled={templates.length === 0}
        >
          <SelectTrigger id="new-provider-template" className="w-full" size="sm">
            <SelectValue placeholder={templateStatus}>
              {selectedTemplate !== null ? (
                <span className="flex items-center gap-2">
                  <ProviderIcon
                    brand={selectedTemplate.brand}
                    templateId={selectedTemplate.id}
                    size="sm"
                  />
                  <span>{selectedTemplate.displayName}</span>
                </span>
              ) : (
                templateStatus
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            {templates?.map((template) => (
              <SelectItem key={template.id} value={template.id} textValue={template.displayName}>
                <span className="flex items-center gap-2">
                  <ProviderIcon
                    brand={template.brand}
                    templateId={template.id}
                    size="sm"
                  />
                  <span>{template.displayName}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {loadError !== null && (
          <p className="text-status-danger text-xs">{loadError}</p>
        )}
      </div>

      <Field
        id="new-base-url"
        label="Default base URL"
        value={baseUrl}
        onChange={setBaseUrl}
        problem={form.problemFor('baseUrl')}
      />

      <div className="flex flex-col gap-2">
        <Label>Upstream keys</Label>
        <div
          role="group"
          aria-label="Upstream key input mode"
          className="border-border bg-muted/40 inline-flex w-fit items-center gap-1 rounded-md border p-1"
        >
          <Button
            type="button"
            size="xs"
            variant={keyInputMode === 'single' ? 'secondary' : 'ghost'}
            aria-pressed={keyInputMode === 'single'}
            onClick={() => setKeyInputMode('single')}
          >
            Single entry
          </Button>
          <Button
            type="button"
            size="xs"
            variant={keyInputMode === 'bulk' ? 'secondary' : 'ghost'}
            aria-pressed={keyInputMode === 'bulk'}
            onClick={() => setKeyInputMode('bulk')}
          >
            Bulk paste
          </Button>
        </div>
        {keyInputMode === 'single' ? (
          <>
            <ul className="flex flex-col gap-3">
              {keys.map((row, index) => (
                <CreateProviderKeyRowFields
                  key={row.rowId}
                  index={index}
                  row={row}
                  defaultBaseUrl={baseUrl}
                  canRemove={keys.length > 1}
                  onChange={(patch) => updateKeyRow(row.rowId, patch)}
                  onRemove={() => removeKeyRow(row.rowId)}
                  upstreamKeyProblem={form.problemFor(`keys[${index}].upstreamKey`)}
                  baseUrlProblem={form.problemFor(`keys[${index}].baseUrl`)}
                />
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addKeyRow}
              className="self-start"
            >
              <Plus className="size-3.5" aria-hidden />
              Add another key
            </Button>
          </>
        ) : (
          <BulkKeyInput
            onParsed={(result) => setBulkKeys(result.entries)}
            defaultBaseUrl={baseUrl}
          />
        )}
        {topLevelKeysProblem !== undefined && (
          <p className="text-status-danger text-xs">{topLevelKeysProblem}</p>
        )}
      </div>

      <label className="text-muted-foreground flex items-start gap-2 text-xs">
        <Checkbox
          checked={allowInsecureHttp}
          onCheckedChange={(value) => setAllowInsecureHttp(value === true)}
          className="mt-0.5"
        />
        <span>
          Allow plain HTTP for this provider. Only for private or local servers — the Upstream
          Key travels unencrypted.
        </span>
      </label>

      <Failure error={form.error} />

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={form.busy}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={form.busy || (keyInputMode === 'bulk' && bulkKeys.length === 0)}
        >
          {form.busy ? 'Creating…' : 'Create provider'}
        </Button>
      </div>
    </form>
  )
}

function CreateProviderKeyRowFields({
  index,
  row,
  defaultBaseUrl,
  canRemove,
  onChange,
  onRemove,
  upstreamKeyProblem,
  baseUrlProblem,
}: {
  readonly index: number
  readonly row: CreateProviderKeyRow
  readonly defaultBaseUrl: string
  readonly canRemove: boolean
  readonly onChange: (patch: Partial<CreateProviderKeyRow>) => void
  readonly onRemove: () => void
  readonly upstreamKeyProblem: string | undefined
  readonly baseUrlProblem: string | undefined
}) {
  const upstreamKeyId = `new-upstream-key-${row.rowId}`
  const baseUrlId = `new-key-base-url-${row.rowId}`

  return (
    <li className="border-border bg-muted/30 flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-center justify-between">
        <Label htmlFor={upstreamKeyId} className="text-muted-foreground text-xs tracking-wide uppercase">
          Key {index + 1}
        </Label>
        {canRemove && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onRemove}
            aria-label={`Remove key ${index + 1}`}
          >
            <Trash2 className="size-3.5" aria-hidden />
            Remove
          </Button>
        )}
      </div>

      <Field
        id={upstreamKeyId}
        label="Upstream key"
        type="password"
        autoComplete="off"
        value={row.upstreamKey}
        onChange={(value) => onChange({ upstreamKey: value })}
        problem={upstreamKeyProblem}
      />

      <Field
        id={baseUrlId}
        label="Base URL override"
        type="url"
        autoComplete="off"
        value={row.baseUrl}
        onChange={(value) => onChange({ baseUrl: value })}
        hint={
          defaultBaseUrl.trim() === ''
            ? 'Inherits the Provider default once set.'
            : `Inherits ${defaultBaseUrl}.`
        }
        problem={baseUrlProblem}
      />
    </li>
  )
}

let createProviderRowCounter = 0
function makeRowId(): string {
  createProviderRowCounter += 1
  return `${Date.now().toString(36)}-${createProviderRowCounter.toString(36)}`
}

function proposeProviderHandle(displayName: string): string {
  const proposed = displayName
    .toLowerCase()
    .replace(/[àáâãäåāăąạảấầẩẫậắằẳẵặ]/g, 'a')
    .replace(/[èéêëēėęẹẻẽếềểễệ]/g, 'e')
    .replace(/[ìíîïīįịỉĩ]/g, 'i')
    .replace(/[òóôõöøōőọỏốồổỗộớờởỡợ]/g, 'o')
    .replace(/[ùúûüūűųụủũứừửữự]/g, 'u')
    .replace(/[ýÿỳỵỷỹ]/g, 'y')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '')
  return proposed || 'provider'
}

function ProviderSparkline({
  traffic,
}: {
  readonly traffic: ProviderTraffic | undefined
}) {
  const data = useMemo(() => {
    if (traffic === undefined) return []
    const now = Date.now()
    const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS
    return traffic.hourlyCounts.map((count, index) => ({
      date: new Date(currentHourStart - (TRAFFIC_HOURS - 1 - index) * HOUR_MS),
      count,
    }))
  }, [traffic])

  if (data.length < 2) {
    return <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">—</span>
  }

  return (
    <span className="hidden h-7 w-24 shrink-0 sm:inline-block" aria-hidden>
      <LineChart
        data={data}
        aspectRatio="24 / 7"
        margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
        animationDuration={0}
        status="ready"
      >
        <Line dataKey="count" stroke="var(--primary)" strokeWidth={1.25} />
      </LineChart>
    </span>
  )
}

function buildTrafficByProvider(
  events: readonly import('@/lib/requests').RequestEventView[],
): ReadonlyMap<string, ProviderTraffic> {
  const now = Date.now()
  const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS
  const firstHourStart = currentHourStart - (TRAFFIC_HOURS - 1) * HOUR_MS
  const buckets = new Map<string, number[]>()
  const minuteCounts = new Map<string, number>()

  for (const event of events) {
    const ts = new Date(event.occurredAt).getTime()
    if (Number.isNaN(ts)) continue
    if (ts < firstHourStart) continue

    const hourIndex = Math.floor((ts - firstHourStart) / HOUR_MS)
    if (hourIndex < 0 || hourIndex >= TRAFFIC_HOURS) continue

    let arr = buckets.get(event.providerId)
    if (arr === undefined) {
      arr = new Array(TRAFFIC_HOURS).fill(0)
      buckets.set(event.providerId, arr)
    }
    arr[hourIndex] = (arr[hourIndex] ?? 0) + 1

    if (ts >= now - 5 * 60 * 1000) {
      minuteCounts.set(event.providerId, (minuteCounts.get(event.providerId) ?? 0) + 1)
    }
  }

  const result = new Map<string, ProviderTraffic>()
  for (const [id, arr] of buckets) {
    const last5min = minuteCounts.get(id) ?? 0
    result.set(id, {
      hourlyCounts: arr,
      reqPerMin: Math.round(last5min / 5),
    })
  }
  return result
}
