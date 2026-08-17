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
import { LogoDomainField } from '@/components/logo-domain-field'
import {
  Failure,
  Field,
  EditProviderForm,
  useSubmission,
} from '@/components/edit-provider-form'
import { BulkKeyInput } from '@/components/bulk-key-input'
import { ApiError, toApiError } from '@/lib/api-client'
import { describeProviderStatus } from '@/lib/provider-status'
import {
  checkProviderHandleAvailability,
  GENERIC_PROVIDER_TEMPLATE,
  GENERIC_PROVIDER_TEMPLATE_BASE_URL,
  GENERIC_PROVIDER_TEMPLATE_ID,
  type ProviderView,
} from '@/lib/providers'
import { useProviderTemplates } from '@/lib/use-provider-templates'
import {
  useArchiveProvider,
  useCreateProvider,
  useDuplicateProvider,
  useProviders,
  usePurgeProvider,
  useRequestHistory,
  useWarmProvider,
} from '@/lib/use-providers'
import type { BulkKeyEntry } from '@/lib/parse-bulk-keys'
import { logoDomainFromBaseUrl, normalizeLogoDomainInput } from '@/lib/logo-domain'

interface ProvidersAreaProps {
  readonly csrfToken: string
}

interface ProviderTraffic {
  readonly hourlyCounts: readonly number[]
  readonly reqPerMin: number
}

const HOUR_MS = 60 * 60 * 1000
const TRAFFIC_HOURS = 12

export function ProvidersArea({ csrfToken }: ProvidersAreaProps) {
  const providers = useProviders()
  // Its own query key, so archiving or toggling a Provider no longer re-pulls
  // the traffic history behind every sparkline.
  const history = useRequestHistory()
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()

  const traffic = useMemo(
    () => buildTrafficByProvider(history.data?.events ?? []),
    [history.data],
  )

  const error = providers.error === null ? null : toApiError(providers.error)
  const active = providers.data?.filter((p) => !p.archived) ?? null
  const archived = providers.data?.filter((p) => p.archived) ?? null

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
            disabled={providers.data === undefined}
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
            onCreated={() => setCreating(false)}
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
  archived = false,
}: {
  readonly provider: ProviderView
  readonly csrfToken: string
  readonly traffic: ProviderTraffic | undefined
  readonly onOpen: () => void
  readonly archived?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const warmProvider = useWarmProvider()
  const archive = useArchiveProvider(csrfToken)
  const duplicate = useDuplicateProvider(csrfToken)
  const purge = usePurgeProvider(csrfToken)
  const status = describeProviderStatus(provider.keys)
  const target = { id: provider.id, displayName: provider.displayName }

  // One row's actions close while that row's own mutation is in flight; a
  // mutation on another Provider leaves this one alone.
  const busy = archive.isPending
    ? 'archive'
    : duplicate.isPending
      ? 'duplicate'
      : purge.isPending
        ? 'purge'
        : null

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
            onDone={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        </DialogContent>
      </Dialog>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Open ${provider.displayName}`}
        onClick={onOpen}
        // The row's stand-in for `defaultPreload: 'intent'`: an imperative
        // navigation gives the router no `Link` to preload from, so the row asks
        // for the Provider itself the moment the Owner looks like opening it.
        // `onFocus` carries the same intent for a keyboard.
        onMouseEnter={() => warmProvider(provider.id)}
        onFocus={() => warmProvider(provider.id)}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen()
          }
        }}
        className="bg-card hover:bg-muted/40 group flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors"
      >
        <ProviderIcon logoDomain={provider.logoDomain} />
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
            onArchive={() => archive.mutate(target)}
            onDuplicate={() => {
              const handle = window.prompt('Choose the immutable Handle for the duplicated Provider:', `${provider.handle}-2`)
              if (handle === null) return
              duplicate.mutate({ ...target, handle })
            }}
            onPurge={() => purge.mutate(target)}
          />
        </div>
      </div>

      <div className="text-muted-foreground mt-1 flex items-center gap-2 px-4 text-xs sm:hidden">
        <Dot tone={status.tone} />
        <span>{status.label}</span>
      </div>
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
  onCancel,
}: {
  readonly csrfToken: string
  readonly onCreated: () => void
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
  const [logoDomain, setLogoDomain] = useState(() => logoDomainFromBaseUrl(GENERIC_PROVIDER_TEMPLATE_BASE_URL) ?? '')
  const logoDomainTouched = useRef(false)
  const [authHeader, setAuthHeader] = useState(GENERIC_PROVIDER_TEMPLATE.authHeader)
  const [authPrefix, setAuthPrefix] = useState(GENERIC_PROVIDER_TEMPLATE.authPrefix)
  const create = useCreateProvider(csrfToken)
  const templateList = useProviderTemplates()
  // Until the list arrives the selector still offers the Generic template, which
  // is what lets the form be usable with no loading state to wait on. A failed
  // fetch clears it: an empty selector plus the message below beats pretending
  // one template is on offer when the registry could not be read.
  const templates = templateList.data ?? (templateList.isError ? [] : [GENERIC_PROVIDER_TEMPLATE])
  const loadError =
    templateList.error === null ? null : toApiError(templateList.error).message

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
    const served = templateList.data
    if (served === undefined) return
    // Re-point the selection when the defaulted template is not part of the
    // served list (a custom registry); otherwise it stays put.
    if (served.some((template) => template.id === templateId)) return
    const first = served[0]
    if (first !== undefined) setTemplateId(first.id)
  }, [templateList.data, templateId])

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

  // Auto-fill the default base URL, auth header, and auth prefix when the Owner
  // picks a template, but never clobber values the Owner has typed by hand.
  // The previous template's values live in refs so the comparison can decide
  // whether the fields are still "untouched" (match what we last seeded) or
  // already carry custom values. After each template change the refs advance
  // so the next change has the right "last seeded" baseline to compare against.
  const lastAutofilledBaseUrl = useRef<string | null>(GENERIC_PROVIDER_TEMPLATE_BASE_URL)
  const lastAutofilledAuthHeader = useRef<string>(GENERIC_PROVIDER_TEMPLATE.authHeader)
  const lastAutofilledAuthPrefix = useRef<string>(GENERIC_PROVIDER_TEMPLATE.authPrefix)
  useEffect(() => {
    if (selectedTemplate === null) return
    const seededBaseUrl = selectedTemplate.baseUrl
    const seededAuthHeader = selectedTemplate.authHeader
    const seededAuthPrefix = selectedTemplate.authPrefix
    if (baseUrl === '' || baseUrl === lastAutofilledBaseUrl.current) {
      setBaseUrl(seededBaseUrl)
    }
    if (authHeader === lastAutofilledAuthHeader.current) {
      setAuthHeader(seededAuthHeader)
    }
    if (authPrefix === lastAutofilledAuthPrefix.current) {
      setAuthPrefix(seededAuthPrefix)
    }
    lastAutofilledBaseUrl.current = seededBaseUrl
    lastAutofilledAuthHeader.current = seededAuthHeader
    lastAutofilledAuthPrefix.current = seededAuthPrefix
  }, [selectedTemplate])

  useEffect(() => {
    if (selectedTemplate === null || logoDomainTouched.current) return
    if (selectedTemplate.brand !== null) {
      setLogoDomain(selectedTemplate.brand.domain)
      return
    }
    const timer = window.setTimeout(() => {
      const suggested = logoDomainFromBaseUrl(baseUrl)
      if (suggested !== null && !logoDomainTouched.current) setLogoDomain(suggested)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [baseUrl, selectedTemplate])

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
    const normalizedLogoDomain = normalizeLogoDomainInput(logoDomain)
    if (logoDomain.trim() !== '' && normalizedLogoDomain === null) {
      throw new ApiError('validation_failed', 'Check the highlighted field.', [
        { field: 'logoDomain', message: 'Enter a valid hostname or HTTP(S) URL.' },
      ])
    }
    await create.mutateAsync({
      input: {
        displayName,
        handle,
        baseUrl,
        logoDomain: normalizedLogoDomain,
        keys:
          keyInputMode === 'bulk'
            ? bulkKeys.map((b) => ({ upstreamKey: b.upstreamKey, baseUrl: b.baseUrl }))
            : keys.map((row) => ({ upstreamKey: row.upstreamKey, baseUrl: row.baseUrl })),
        allowInsecureHttp,
        templateId,
        authHeader,
        authPrefix,
      },
    })
    onCreated()
  })

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
                    logoDomain={selectedTemplate.brand?.domain ?? null}
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
            {templates.map((template) => (
              <SelectItem key={template.id} value={template.id} textValue={template.displayName}>
                <span className="flex items-center gap-2">
                  <ProviderIcon
                    logoDomain={template.brand?.domain ?? null}
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

      <LogoDomainField
        id="new-logo-domain"
        value={logoDomain}
        onChange={(value) => { logoDomainTouched.current = true; setLogoDomain(value) }}
        problem={form.problemFor('logoDomain')}
      />

      <Field
        id="new-auth-header"
        label="Authentication header"
        value={authHeader}
        onChange={setAuthHeader}
        hint="The HTTP header name for authentication."
        problem={form.problemFor('authHeader')}
      />

      <Field
        id="new-auth-prefix"
        label="Authentication prefix"
        value={authPrefix}
        onChange={setAuthPrefix}
        hint={
          authHeader
            ? `Sent as: ${authHeader}: ${authPrefix}<your-key>`
            : 'Enter a header name above to see the format.'
        }
        problem={form.problemFor('authPrefix')}
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
