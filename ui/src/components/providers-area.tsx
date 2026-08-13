import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { MoreHorizontal, Plus, Server, Wind } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { Dot } from '@/components/dot'
import { healthTone } from '@/components/key-health'
import { LineChart, Line } from '@/components/charts/line-chart'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  archiveConnection,
  createConnection,
  duplicateConnection,
  fetchConnections,
  ManagementError,
  purgeConnection,
  updateConnection,
  type ConnectionView,
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

function ProviderIcon({
  displayName,
  baseUrl,
}: {
  readonly displayName: string
  readonly baseUrl: string
}) {
  const kind = detectProviderKind(displayName, baseUrl)
  const baseClasses = 'flex size-8 shrink-0 items-center justify-center rounded-lg border'

  if (kind === 'openai') {
    return (
      <span className={`${baseClasses} border-black/10 bg-white`}>
        <OpenAIMark />
      </span>
    )
  }
  if (kind === 'anthropic') {
    return (
      <span className={`${baseClasses} border-[#E5E1D8] bg-[#F0EBE1]`}>
        <span className="font-serif text-sm font-bold leading-none text-stone-800">A</span>
      </span>
    )
  }
  if (kind === 'mistral') {
    return (
      <span className={`${baseClasses} border-orange-100 bg-orange-50 text-orange-500`}>
        <Wind className="size-4" aria-hidden strokeWidth={1.75} />
      </span>
    )
  }
  return (
    <span className={`${baseClasses} border-border bg-muted text-muted-foreground`}>
      <Server className="size-4" aria-hidden strokeWidth={1.5} />
    </span>
  )
}

function OpenAIMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="currentColor" aria-hidden>
      <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A6.0651 6.0651 0 0 0 19.0192 19.82a5.9847 5.9847 0 0 0 3.9977-2.9 6.0462 6.0462 0 0 0-.735-7.0988zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.8956zm16.0993 3.8558L12.5973 8.3829a.0804.0804 0 0 1 .0332-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.1408 1.6464 4.4708 4.4708 0 0 1 .5346 3.0137l-.1416-.0852-4.783-2.7582a.7712.7712 0 0 0-.7806 0l-5.8428 3.3685v-2.3324l.0006 2.3324zm-1.12-3.8558a4.485 4.485 0 0 1-2.3655 1.9728V4.1818a.7664.7664 0 0 0-.3879-.6765L8.7523.151a.0757.0757 0 0 1 .071 0l4.8303 2.7865a4.504 4.504 0 0 1 3.6666 4.9123zm-3.218 2.0526l-2.102-1.2132-2.102 1.2132V8.6722l2.102-1.2133 2.102 1.2133v2.4276z" />
    </svg>
  )
}

function detectProviderKind(
  displayName: string,
  baseUrl: string,
): 'openai' | 'anthropic' | 'mistral' | 'unknown' {
  const haystack = `${displayName} ${baseUrl}`.toLowerCase()
  if (haystack.includes('openai')) return 'openai'
  if (haystack.includes('anthropic') || haystack.includes('claude')) return 'anthropic'
  if (haystack.includes('mistral')) return 'mistral'
  return 'unknown'
}

function describeConnectionStatus(keys: readonly { health: 'unverified' | 'active' | 'cooling_down' | 'invalid_authentication' | 'exhausted' | 'disabled' }[]): {
  readonly tone: 'healthy' | 'warning' | 'danger' | 'neutral'
  readonly label: string
} {
  if (keys.length === 0) return { tone: 'neutral', label: 'No keys' }
  const tones = keys.map((key) => healthTone(key.health))
  if (tones.every((tone) => tone === 'healthy')) return { tone: 'healthy', label: 'Healthy' }
  if (tones.some((tone) => tone === 'danger')) return { tone: 'warning', label: 'Degraded' }
  return { tone: 'warning', label: 'Partial' }
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
  const form = useSubmission(async () => {
    await createConnection({ displayName, baseUrl, upstreamKey, allowInsecureHttp }, csrfToken)
    onCreated()
  }, onFailure)

  return (
    <form className="flex flex-col gap-4" onSubmit={form.submit} noValidate>
      <Field
        id="new-display-name"
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        problem={form.problemFor('displayName')}
      />
      <Field
        id="new-base-url"
        label="Base URL"
        hint="The provider’s OpenAI-compatible base URL, such as https://api.openai.com/v1."
        value={baseUrl}
        onChange={setBaseUrl}
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

function EditConnectionForm({
  connection,
  csrfToken,
  onDone,
  onCancel,
}: {
  readonly connection: ConnectionView
  readonly csrfToken: string
  readonly onDone: () => void
  readonly onCancel: () => void
}) {
  const [displayName, setDisplayName] = useState(connection.displayName)
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl)
  const [allowInsecureHttp, setAllowInsecureHttp] = useState(connection.allowInsecureHttp)
  const [enabled, setEnabled] = useState(connection.enabled)
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(String(connection.retryMaxAttempts))
  const [retryAmbiguousNetwork, setRetryAmbiguousNetwork] = useState(
    connection.retryAmbiguousNetwork,
  )
  const form = useSubmission(async () => {
    await updateConnection(
      connection.id,
      {
        displayName,
        baseUrl,
        allowInsecureHttp,
        enabled,
        retryMaxAttempts: Number(retryMaxAttempts),
        retryAmbiguousNetwork,
      },
      csrfToken,
    )
    onDone()
  })

  return (
    <form className="flex flex-col gap-3" onSubmit={form.submit} noValidate>
      <Field
        id={`edit-${connection.id}-name`}
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        problem={form.problemFor('displayName')}
      />
      <Field
        id={`edit-${connection.id}-url`}
        label="Base URL"
        value={baseUrl}
        onChange={setBaseUrl}
        problem={form.problemFor('baseUrl')}
      />
      <div className="flex flex-col gap-1.5">
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <Checkbox
            checked={enabled}
            onCheckedChange={(value) => setEnabled(value === true)}
          />
          Enabled for inference
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <Checkbox
            checked={allowInsecureHttp}
            onCheckedChange={(value) => setAllowInsecureHttp(value === true)}
          />
          Allow plain HTTP
        </label>
        <label className="text-muted-foreground flex items-center gap-2 text-xs">
          <Checkbox
            checked={retryAmbiguousNetwork}
            onCheckedChange={(value) => setRetryAmbiguousNetwork(value === true)}
          />
          Retry ambiguous network failures. Off by default because a generation may have
          completed.
        </label>
      </div>
      <Field
        id={`edit-${connection.id}-retry-attempts`}
        label="Maximum attempts"
        type="number"
        hint="One to five attempts across retries and alternate credentials."
        value={retryMaxAttempts}
        onChange={setRetryMaxAttempts}
        problem={form.problemFor('retryMaxAttempts')}
      />

      <Failure error={form.error} />

      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={form.busy}>
          {form.busy ? 'Saving…' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={form.busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  hint,
  problem,
}: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly type?: string
  readonly autoComplete?: string
  readonly hint?: string
  readonly problem?: string | undefined
}) {
  const describedBy = [problem ? `${id}-problem` : null, hint ? `${id}-hint` : null]
    .filter(Boolean)
    .join(' ')

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        aria-invalid={problem ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {hint}
        </p>
      )}
      {problem && (
        <p id={`${id}-problem`} className="text-status-danger text-xs">
          {problem}
        </p>
      )}
    </div>
  )
}

function Failure({ error }: { error: ManagementError | null }) {
  if (error === null) return null

  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{TITLES[error.code] ?? 'That did not work'}</AlertTitle>
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  )
}

const TITLES: Record<string, string> = {
  validation_failed: 'Check these values',
  connection_not_found: 'Connection not found',
  key_not_found: 'Key not found',
  connection_archived: 'Connection archived',
  stored_key_unreadable: 'Stored key unreadable',
  authentication_required: 'Signed out',
  unreachable: 'Gateway unreachable',
}

function toManagementError(cause: unknown): ManagementError {
  return cause instanceof ManagementError
    ? cause
    : new ManagementError('request_failed', 'That request could not be completed.')
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

function useSubmission(run: () => Promise<void>, onFatal?: (error: ManagementError) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ManagementError | null>(null)

  return {
    busy,
    error,

    problemFor(field: string): string | undefined {
      return error?.problems.find((problem) => problem.field === field)?.message
    },

    submit(event: FormEvent) {
      event.preventDefault()
      if (busy) return

      setBusy(true)
      setError(null)

      void run()
        .catch((cause: unknown) => {
          const failure = toManagementError(cause)
          if (failure.code === 'authentication_required' && onFatal) {
            onFatal(failure)
            return
          }
          setError(failure)
        })
        .finally(() => setBusy(false))
    },
  }
}