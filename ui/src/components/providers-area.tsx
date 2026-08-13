import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { MoreHorizontal, Plus, Server } from 'lucide-react'
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
  EditConnectionForm,
  toManagementError,
  useSubmission,
} from '@/components/edit-connection-form'
import { describeConnectionStatus } from '@/lib/connection-status'
import {
  archiveConnection,
  createConnection,
  duplicateConnection,
  fetchConnections,
  fetchProviderTemplates,
  ManagementError,
  purgeConnection,
  type ConnectionView,
  type ProviderTemplateView,
} from '@/lib/providers'
import { fetchRequests } from '@/lib/requests'

interface ProvidersAreaProps {
  readonly csrfToken: string
  readonly onSignedOut: () => void
}

interface ConnectionTraffic {
  readonly hourlyCounts: readonly number[]
  readonly reqPerMin: number
}

const HOUR_MS = 60 * 60 * 1000
const TRAFFIC_HOURS = 12

export function ProvidersArea({ csrfToken, onSignedOut }: ProvidersAreaProps) {
  const [connections, setConnections] = useState<readonly ConnectionView[] | null>(null)
  const [traffic, setTraffic] = useState<ReadonlyMap<string, ConnectionTraffic>>(new Map())
  const [error, setError] = useState<ManagementError | null>(null)
  const [creating, setCreating] = useState(false)
  const navigate = useNavigate()

  const reload = useCallback(async () => {
    try {
      const [conns, page] = await Promise.all([
        fetchConnections(),
        fetchRequests({}, { limit: 800 }),
      ])
      setConnections(conns)
      setTraffic(buildTrafficByConnection(page.events))
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

  const active = connections?.filter((c) => !c.archived) ?? null
  const archived = connections?.filter((c) => c.archived) ?? null

  const openConnection = (id: string) => {
    void navigate({ to: '/providers/$connectionId', params: { connectionId: id } })
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Provider Connections</h1>
        {(active === null || active.length > 0) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setCreating(true)}
            disabled={connections === null}
          >
            <Plus className="size-3.5" aria-hidden />
            New connection
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
            <DialogTitle>New Provider Connection</DialogTitle>
            <DialogDescription>
              A name, the provider’s OpenAI-compatible base URL, and one Upstream Key.
            </DialogDescription>
          </DialogHeader>
          <CreateConnectionForm
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
            title="No Provider Connections yet"
            description="Create the first one to give your applications an upstream to call."
            action={{ label: 'New connection', onClick: () => setCreating(true) }}
          />
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {active.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              csrfToken={csrfToken}
              traffic={traffic.get(connection.id)}
              onOpen={() => openConnection(connection.id)}
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
            {archived.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                csrfToken={csrfToken}
                traffic={traffic.get(connection.id)}
                onOpen={() => openConnection(connection.id)}
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

function ConnectionRow({
  connection,
  csrfToken,
  traffic,
  onOpen,
  onChanged,
  archived = false,
}: {
  readonly connection: ConnectionView
  readonly csrfToken: string
  readonly traffic: ConnectionTraffic | undefined
  readonly onOpen: () => void
  readonly onChanged: () => void
  readonly archived?: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [rowError, setRowError] = useState<ManagementError | null>(null)
  const status = describeConnectionStatus(connection.keys)

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
            <DialogTitle>Edit {connection.displayName}</DialogTitle>
            <DialogDescription>
              Editing keeps the connection’s ID unchanged, so client URLs stay valid.
            </DialogDescription>
          </DialogHeader>
          <EditConnectionForm
            connection={connection}
            csrfToken={csrfToken}
            onDone={() => {
              setEditing(false)
              onChanged()
            }}
            onCancel={() => setEditing(false)}
          />
        </DialogContent>
      </Dialog>
      <div className="bg-card hover:bg-muted/40 group flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors">
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${connection.displayName}`}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <ProviderIcon
            displayName={connection.displayName}
            baseUrl={connection.baseUrl}
            {...(connection.templateId === null ? {} : { templateId: connection.templateId })}
          />
          <span className="truncate text-sm font-medium tracking-tight">
            {connection.displayName}
          </span>
          {archived && <StatusBadge tone="neutral" label="Archived" />}
          {!archived && !connection.enabled && (
            <StatusBadge tone="neutral" label="Disabled" />
          )}
          <span className="text-muted-foreground ml-auto hidden items-center gap-1.5 text-xs sm:flex">
            <Dot tone={status.tone} />
            <span className="text-foreground">{status.label}</span>
          </span>
        </button>

        <ConnectionSparkline traffic={traffic} />

        <ConnectionMenu
          archived={archived}
          busy={busy}
          onEdit={() => setEditing(true)}
          onArchive={() =>
            void run('archive', () => archiveConnection(connection.id, csrfToken))
          }
          onDuplicate={() =>
            void run('duplicate', () => duplicateConnection(connection.id, csrfToken))
          }
          onPurge={() => void run('purge', () => purgeConnection(connection.id, csrfToken))}
        />
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

function ConnectionMenu({
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
          aria-label="Connection actions"
          disabled={busy !== null}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onSelect={onEdit}>Edit connection</DropdownMenuItem>
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

function CreateConnectionForm({
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
  const [baseUrl, setBaseUrl] = useState('')
  const [upstreamKey, setUpstreamKey] = useState('')
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(false)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [baseUrlDirty, setBaseUrlDirty] = useState(false)
  const [templates, setTemplates] = useState<readonly ProviderTemplateView[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    fetchProviderTemplates(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return
        setTemplates(list)
        setLoadError(null)
        const fallback =
          list.find((template) => template.id === 'generic-openai-compatible') ?? list[0]
        if (fallback !== undefined) {
          setTemplateId(fallback.id)
          if (!baseUrlDirty) setBaseUrl(fallback.baseUrl)
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
      : (templates?.find((template) => template.id === templateId) ?? null)

  const handleTemplateChange = (next: string) => {
    setTemplateId(next)
    const template = templates?.find((candidate) => candidate.id === next)
    if (template !== undefined && !baseUrlDirty) setBaseUrl(template.baseUrl)
  }

  const templateStatus =
    loadError !== null
      ? 'Could not load templates'
      : templates === null
        ? 'Loading templates…'
        : templates.length === 0
          ? 'No templates available'
          : selectedTemplate?.displayName ?? 'Pick a template'

  const form = useSubmission(async () => {
    await createConnection(
      { displayName, baseUrl, upstreamKey, allowInsecureHttp, templateId },
      csrfToken,
    )
    onCreated()
  }, onFailure)

  const baseUrlHint =
    templateId === 'generic-openai-compatible'
      ? 'Prefilled from the Generic OpenAI-compatible template. Override for a custom endpoint.'
      : selectedTemplate !== null
        ? `Prefilled from ${selectedTemplate.displayName}. Override for a self-hosted or proxy URL.`
        : 'The provider’s OpenAI-compatible base URL, such as https://api.openai.com/v1.'

  return (
    <form className="flex flex-col gap-4" onSubmit={form.submit} noValidate>
      <Field
        id="new-display-name"
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        problem={form.problemFor('displayName')}
      />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-provider-template">Provider template</Label>
        <Select
          value={templateId ?? ''}
          onValueChange={handleTemplateChange}
          disabled={templates === null || templates.length === 0}
        >
          <SelectTrigger id="new-provider-template" className="w-full" size="sm">
            <SelectValue>{templateStatus}</SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            {templates?.map((template) => (
              <SelectItem key={template.id} value={template.id} textValue={template.displayName}>
                <span className="flex items-center gap-2">
                  <ProviderIcon
                    displayName={template.displayName}
                    baseUrl={template.baseUrl}
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
        label="Base URL"
        hint={baseUrlHint}
        value={baseUrl}
        onChange={(value) => {
          setBaseUrl(value)
          setBaseUrlDirty(true)
        }}
        problem={form.problemFor('baseUrl')}
      />
      <Field
        id="new-upstream-key"
        label="Upstream key"
        type="password"
        autoComplete="off"
        hint="Encrypted with the installation master key and never shown again."
        value={upstreamKey}
        onChange={setUpstreamKey}
        problem={form.problemFor('upstreamKey')}
      />

      <label className="text-muted-foreground flex items-start gap-2 text-xs">
        <Checkbox
          checked={allowInsecureHttp}
          onCheckedChange={(value) => setAllowInsecureHttp(value === true)}
          className="mt-0.5"
        />
        <span>
          Allow plain HTTP for this connection. Only for private or local servers — the Upstream
          Key travels unencrypted.
        </span>
      </label>

      <Failure error={form.error} />

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={form.busy}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={form.busy}>
          {form.busy ? 'Creating…' : 'Create connection'}
        </Button>
      </div>
    </form>
  )
}

function ConnectionSparkline({
  traffic,
}: {
  readonly traffic: ConnectionTraffic | undefined
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

function buildTrafficByConnection(
  events: readonly import('@/lib/requests').RequestEventView[],
): ReadonlyMap<string, ConnectionTraffic> {
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

    let arr = buckets.get(event.connectionId)
    if (arr === undefined) {
      arr = new Array(TRAFFIC_HOURS).fill(0)
      buckets.set(event.connectionId, arr)
    }
    arr[hourIndex] = (arr[hourIndex] ?? 0) + 1

    if (ts >= now - 5 * 60 * 1000) {
      minuteCounts.set(event.connectionId, (minuteCounts.get(event.connectionId) ?? 0) + 1)
    }
  }

  const result = new Map<string, ConnectionTraffic>()
  for (const [id, arr] of buckets) {
    const last5min = minuteCounts.get(id) ?? 0
    result.set(id, {
      hourlyCounts: arr,
      reqPerMin: Math.round(last5min / 5),
    })
  }
  return result
}