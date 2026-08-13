import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Archive,
  Copy,
  KeyRound,
  RefreshCcw,
  Settings,
  Users,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MoreHorizontal } from 'lucide-react'
import { ProviderIcon } from '@/components/provider-icon'
import { EditConnectionForm } from '@/components/edit-connection-form'
import { ModelListPicker } from '@/components/model-list-picker'
import {
  HEALTH_LABELS,
  HEALTH_ORDER,
  KeyHealthBadge,
  keyNeedsAttention,
} from '@/components/key-health'
import { Dot } from '@/components/dot'
import { LineChart, Line } from '@/components/charts/line-chart'
import { describeConnectionStatus } from '@/lib/connection-status'
import {
  activateKey,
  addKey,
  archiveConnection,
  createUpstreamAccount,
  deleteUpstreamAccount,
  disableKey,
  duplicateConnection,
  fetchConnections,
  ManagementError,
  purgeConnection,
  removeKey,
  testKey,
  updateKeySettings,
  type ConnectionView,
  type KeyView,
} from '@/lib/providers'
import { fetchRequests, type RequestEventView } from '@/lib/requests'
import { refreshCatalog } from '@/lib/catalog'
import { fetchUsage, type UsageView } from '@/lib/usage'
import { formatTime as formatTimeWithUtc } from '@/lib/time'

interface ConnectionDetailProps {
  readonly connectionId: string
  readonly csrfToken: string
  readonly onBack: () => void
  readonly onDeleted: () => void
}

interface ConnectionAnalytics {
  readonly hourlyCounts: readonly number[]
  readonly peakRpm: number
  readonly errorRate: number
  readonly p95LatencyMs: number
  readonly topModel: string | null
  readonly totalRequests: number
}

const HOUR_MS = 60 * 60 * 1000
const ANALYTICS_HOURS = 24
const FIVE_MIN_MS = 5 * 60 * 1000

export function ConnectionDetail({
  connectionId,
  csrfToken,
  onBack,
  onDeleted,
}: ConnectionDetailProps) {
  const [connection, setConnection] = useState<ConnectionView | null>(null)
  const [analytics, setAnalytics] = useState<ConnectionAnalytics | null>(null)
  const [usage, setUsage] = useState<UsageView | null>(null)
  const [usageLoading, setUsageLoading] = useState(true)
  const [error, setError] = useState<ManagementError | null>(null)

  const reload = useCallback(async () => {
    try {
      const all = await fetchConnections()
      const match = all.find((c) => c.id === connectionId)
      if (match === undefined) {
        setError(new ManagementError('connection_not_found', 'No such Provider Connection.'))
        setConnection(null)
        return
      }
      setConnection(match)
      setError(null)
    } catch (cause) {
      if (cause instanceof ManagementError && cause.code === 'authentication_required') {
        onBack()
        return
      }
      setError(
        cause instanceof ManagementError ? cause : new ManagementError('request_failed', 'Load failed.'),
      )
    }
  }, [connectionId, onBack])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    let cancelled = false
    void fetchRequests({ connectionId }, { limit: 800 })
      .then((page) => {
        if (cancelled) return
        setAnalytics(buildConnectionAnalytics(page.events))
      })
      .catch(() => {
        if (cancelled) return
        setAnalytics(null)
      })
    return () => {
      cancelled = true
    }
  }, [connectionId])

  useEffect(() => {
    let cancelled = false
    setUsageLoading(true)
    void fetchUsage(connectionId)
      .then((value) => {
        if (cancelled) return
        setUsage(value)
      })
      .catch(() => {
        if (cancelled) return
        setUsage(null)
      })
      .finally(() => {
        if (cancelled) return
        setUsageLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [connectionId])

  if (connection === null && error === null) {
    return <Skeleton className="h-48 w-full" />
  }

  if (connection === null && error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5" aria-hidden /> Back to Providers
        </Button>
        <Alert variant="destructive" role="alert">
          <AlertTitle>Connection unavailable</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (connection === null) return null

  const status = describeConnectionStatus(connection.keys)
  const archived = connection.archived

  return (
    <div className="flex flex-col gap-6">
      <ConnectionHeader
        connection={connection}
        status={status}
        archived={archived}
        onBack={onBack}
      />

      <ConnectionAnalyticsStrip analytics={analytics} />

      <ConnectionActions
        connection={connection}
        csrfToken={csrfToken}
        onChanged={reload}
        onDeleted={onDeleted}
      />

      <UpstreamKeysCard
        connection={connection}
        csrfToken={csrfToken}
        onChanged={reload}
      />

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <KeyHealthCard connection={connection} />
        <SharedAccountsCard
          connection={connection}
          csrfToken={csrfToken}
          onChanged={reload}
        />
        <ConnectionDetailsCard connection={connection} />
        {usage !== null ? (
          <UsageAdapterCard usage={usage} connectionId={connectionId} />
        ) : usageLoading ? (
          <UsageAdapterSkeleton />
        ) : null}
      </div>
    </div>
  )
}

function ConnectionHeader({
  connection,
  status,
  archived,
  onBack,
}: {
  readonly connection: ConnectionView
  readonly status: ReturnType<typeof describeConnectionStatus>
  readonly archived: boolean
  readonly onBack: () => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <Button type="button" variant="ghost" size="sm" onClick={onBack} className="self-start">
        <ArrowLeft className="size-3.5" aria-hidden /> Back to Providers
      </Button>

      <div className="flex items-center gap-3">
        <ProviderIcon
          displayName={connection.displayName}
          baseUrl={connection.baseUrl}
        />
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{connection.displayName}</h1>
            <span
              className="border-border bg-card text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium"
              title={status.label}
            >
              <Dot tone={status.tone} />
              {status.label}
            </span>
            {archived && (
              <span className="border-border bg-muted text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium">
                Archived
              </span>
            )}
            {!archived && !connection.enabled && (
              <span className="border-border bg-muted text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium">
                Disabled
              </span>
            )}
          </div>
          <span className="text-muted-foreground font-mono text-xs">{connection.id}</span>
        </div>
      </div>
    </div>
  )
}

function ConnectionAnalyticsStrip({
  analytics,
}: {
  readonly analytics: ConnectionAnalytics | null
}) {
  if (analytics === null) {
    return (
      <div className="bg-card flex items-center gap-6 rounded-lg border px-4 py-3">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-20" />
        <Skeleton className="h-6 w-20" />
      </div>
    )
  }

  if (analytics.totalRequests === 0) {
    return (
      <div className="bg-card text-muted-foreground rounded-lg border px-4 py-3 text-sm">
        No traffic recorded for this connection in the last 24 hours.
      </div>
    )
  }

  const peakLabel = analytics.peakRpm === 0 ? '—' : analytics.peakRpm.toLocaleString()
  const errorRateLabel = `${(analytics.errorRate * 100).toFixed(2)}%`
  const p95Label = `${Math.round(analytics.p95LatencyMs).toLocaleString()}ms`

  return (
    <div className="bg-card flex items-center gap-6 overflow-x-auto rounded-lg border px-4 py-3">
      <div className="flex shrink-0 flex-col gap-1 border-r pr-6 min-w-[140px]">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          24h rate
        </span>
        <AnalyticsSparkline hourlyCounts={analytics.hourlyCounts} />
      </div>
      <Stat label="RPM (peak)" value={peakLabel} />
      <Stat label="Error rate" value={errorRateLabel} />
      <Stat label="p95 latency" value={p95Label} />
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Top model
        </span>
        <span className="border-border bg-muted inline-flex items-center rounded-md border px-2 py-0.5 text-sm font-medium">
          {analytics.topModel ?? '—'}
        </span>
      </div>
    </div>
  )
}

function Stat({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </span>
      <span className="font-mono text-sm font-medium">{value}</span>
    </div>
  )
}

function AnalyticsSparkline({ hourlyCounts }: { readonly hourlyCounts: readonly number[] }) {
  const data = useMemo(() => {
    const now = Date.now()
    const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS
    return hourlyCounts.map((count, index) => ({
      date: new Date(currentHourStart - (hourlyCounts.length - 1 - index) * HOUR_MS),
      count,
    }))
  }, [hourlyCounts])

  if (data.length < 2) {
    return <span className="text-muted-foreground text-xs">—</span>
  }

  return (
    <div className="text-primary h-7 w-32" aria-hidden>
      <LineChart
        data={data}
        aspectRatio="32 / 7"
        margin={{ top: 2, right: 2, bottom: 2, left: 2 }}
        animationDuration={0}
        status="ready"
      >
        <Line dataKey="count" stroke="var(--primary)" strokeWidth={1.25} />
      </LineChart>
    </div>
  )
}

function ConnectionActions({
  connection,
  csrfToken,
  onChanged,
  onDeleted,
}: {
  readonly connection: ConnectionView
  readonly csrfToken: string
  readonly onChanged: () => void
  readonly onDeleted: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const [confirmingPurge, setConfirmingPurge] = useState(false)
  const [rowError, setRowError] = useState<ManagementError | null>(null)
  const archived = connection.archived

  const run = async (label: string, perform: () => Promise<unknown>) => {
    setBusy(label)
    setRowError(null)
    try {
      await perform()
      onChanged()
    } catch (cause) {
      setRowError(
        cause instanceof ManagementError
          ? cause
          : new ManagementError('request_failed', 'That did not work.'),
      )
    } finally {
      setBusy(null)
      setConfirmingArchive(false)
      setConfirmingPurge(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {connection.displayName}</DialogTitle>
            <DialogDescription>
              Editing keeps the connection's ID unchanged, so client URLs stay valid.
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

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
          <Settings className="size-3.5" aria-hidden /> Edit settings
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void run('refresh', () => refreshCatalog(connection.id, csrfToken))}
          disabled={busy !== null || archived}
        >
          <RefreshCcw className="size-3.5" aria-hidden />
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh catalog'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void run('duplicate', () => duplicateConnection(connection.id, csrfToken))}
          disabled={busy !== null}
        >
          <Copy className="size-3.5" aria-hidden />
          {busy === 'duplicate' ? 'Duplicating…' : 'Duplicate'}
        </Button>
        <span className="bg-border mx-1 h-4 w-px" aria-hidden />
        {!archived && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirmingArchive) {
                void run('archive', () => archiveConnection(connection.id, csrfToken))
              } else {
                setConfirmingArchive(true)
              }
            }}
            onBlur={() => setConfirmingArchive(false)}
            disabled={busy !== null}
            className="text-status-danger hover:border-status-danger/40 hover:bg-status-danger/5"
          >
            <Archive className="size-3.5" aria-hidden />
            {busy === 'archive'
              ? 'Archiving…'
              : confirmingArchive
                ? 'Confirm archive'
                : 'Archive'}
          </Button>
        )}
        {archived && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (confirmingPurge) {
                void run('purge', async () => {
                  await purgeConnection(connection.id, csrfToken)
                  onDeleted()
                })
              } else {
                setConfirmingPurge(true)
              }
            }}
            onBlur={() => setConfirmingPurge(false)}
            disabled={busy !== null}
            className="text-status-danger hover:border-status-danger/40 hover:bg-status-danger/5"
          >
            {busy === 'purge'
              ? 'Purging…'
              : confirmingPurge
                ? 'Confirm purge'
                : 'Purge permanently'}
          </Button>
        )}
      </div>

      {rowError && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{rowError.message}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

function UpstreamKeysCard({
  connection,
  csrfToken,
  onChanged,
}: {
  readonly connection: ConnectionView
  readonly csrfToken: string
  readonly onChanged: () => void
}) {
  const [adding, setAdding] = useState(false)
  const [configuring, setConfiguring] = useState<KeyView | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<ManagementError | null>(null)

  const run = async (label: string, perform: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await perform()
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof ManagementError
          ? cause
          : new ManagementError('request_failed', 'That did not work.'),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="bg-card rounded-xl border overflow-hidden">
      <div className="border-border flex items-center justify-between border-b px-5 py-4">
        <div className="flex items-center gap-2">
          <KeyRound className="text-muted-foreground size-4" aria-hidden />
          <h2 className="text-sm font-semibold tracking-tight">Upstream keys</h2>
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 font-mono text-xs">
            {connection.keys.length}
          </span>
        </div>
        {!connection.archived && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAdding(true)}
            disabled={busy !== null}
          >
            Add key
          </Button>
        )}
      </div>

      {error && (
        <Alert variant="destructive" role="alert" className="m-5">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {adding && !connection.archived && (
        <AddKeyDialog
          connectionId={connection.id}
          csrfToken={csrfToken}
          accounts={connection.accounts}
          onAdd={(input) =>
            run('add-key', () => addKey(connection.id, input, csrfToken))
          }
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}

      {configuring !== null && !connection.archived && (
        <ConfigureKeyDialog
          connectionId={connection.id}
          keyView={configuring}
          accounts={connection.accounts}
          csrfToken={csrfToken}
          onDone={() => {
            setConfiguring(null)
            onChanged()
          }}
          onCancel={() => setConfiguring(null)}
        />
      )}

      {connection.keys.length === 0 ? (
        <p className="text-muted-foreground px-5 py-6 text-sm">
          No Upstream Keys yet. Add one to give this connection inference capacity.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left">
            <thead>
              <tr>
                <th className="text-muted-foreground border-border border-b px-5 py-3 text-xs font-medium tracking-wide uppercase">
                  Status
                </th>
                <th className="text-muted-foreground border-border border-b px-5 py-3 text-xs font-medium tracking-wide uppercase">
                  Key ID
                </th>
                <th className="text-muted-foreground border-border border-b px-5 py-3 text-xs font-medium tracking-wide uppercase">
                  Account
                </th>
                <th className="text-muted-foreground border-border border-b px-5 py-3 text-xs font-medium tracking-wide uppercase">
                  Model access
                </th>
                <th className="text-muted-foreground border-border border-b px-5 py-3 text-right text-xs font-medium tracking-wide uppercase">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {connection.keys.map((key) => (
                <UpstreamKeyRow
                  key={key.id}
                  connectionId={connection.id}
                  accounts={connection.accounts}
                  keyView={key}
                  csrfToken={csrfToken}
                  busy={busy}
                  run={run}
                  onConfigure={() => setConfiguring(key)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function AddKeyDialog({
  connectionId,
  csrfToken,
  accounts,
  onAdd,
  onDone,
  onCancel,
}: {
  readonly connectionId: string
  readonly csrfToken: string
  readonly accounts: ConnectionView['accounts']
  readonly onAdd: (input: {
    readonly upstreamKey: string
    readonly accountId: string | null
    readonly allowedModels: readonly string[] | null
    readonly deniedModels: readonly string[] | null
  }) => Promise<void>
  readonly onDone: () => void
  readonly onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const [accountId, setAccountId] = useState<string>('')
  const [allowedModels, setAllowedModels] = useState<readonly string[]>([])
  const [deniedModels, setDeniedModels] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ManagementError | null>(null)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || value === '') return
    setBusy(true)
    setError(null)
    void onAdd({
      upstreamKey: value,
      accountId: accountId === '' ? null : accountId,
      allowedModels: allowedModels.length === 0 ? null : allowedModels,
      deniedModels: deniedModels.length === 0 ? null : deniedModels,
    })
      .then(() => {
        setValue('')
        onDone()
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof ManagementError
            ? cause
            : new ManagementError('request_failed', 'Could not save.'),
        ),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add upstream key</DialogTitle>
          <DialogDescription>
            Encrypted with the installation master key and never shown again. Settings below
            are optional and can be reconfigured later.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="upstream-add-key"
              className="text-foreground text-sm font-medium"
            >
              Upstream key
            </label>
            <input
              id="upstream-add-key"
              type="password"
              autoComplete="off"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="add-key-account"
              className="text-foreground text-sm font-medium"
            >
              Shared account
            </label>
            <Select
              value={accountId === '' ? '__independent' : accountId}
              onValueChange={(value) => setAccountId(value === '__independent' ? '' : value)}
            >
              <SelectTrigger id="add-key-account" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__independent">Independent</SelectItem>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-foreground text-sm font-medium">
              Only allow models
            </label>
            <p className="text-muted-foreground text-xs">
              Restrict this upstream key to a subset of the catalog. Leave empty to allow
              everything.
            </p>
            <ModelListPicker
              connectionId={connectionId}
              csrfToken={csrfToken}
              selected={allowedModels}
              onChange={setAllowedModels}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-foreground text-sm font-medium">
              Exclude models
            </label>
            <p className="text-muted-foreground text-xs">
              Block specific model IDs even when the key would otherwise reach them. Leave
              empty to exclude nothing.
            </p>
            <ModelListPicker
              connectionId={connectionId}
              csrfToken={csrfToken}
              selected={deniedModels}
              onChange={setDeniedModels}
            />
          </div>

          {error !== null && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Could not save</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy || value === ''}>
              {busy ? 'Adding…' : 'Add key'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ConfigureKeyDialog({
  connectionId,
  keyView,
  accounts,
  csrfToken,
  onDone,
  onCancel,
}: {
  readonly connectionId: string
  readonly keyView: KeyView
  readonly accounts: ConnectionView['accounts']
  readonly csrfToken: string
  readonly onDone: () => void
  readonly onCancel: () => void
}) {
  const [accountId, setAccountId] = useState(keyView.accountId ?? '')
  const [allowedModels, setAllowedModels] = useState<readonly string[]>(keyView.allowedModels ?? [])
  const [deniedModels, setDeniedModels] = useState<readonly string[]>(keyView.deniedModels ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ManagementError | null>(null)

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    void updateKeySettings(
      connectionId,
      keyView.id,
      {
        accountId: accountId === '' ? null : accountId,
        allowedModels: allowedModels.length === 0 ? null : [...allowedModels],
        deniedModels: deniedModels.length === 0 ? null : [...deniedModels],
      },
      csrfToken,
    )
      .then(() => onDone())
      .catch((cause: unknown) =>
        setError(
          cause instanceof ManagementError
            ? cause
            : new ManagementError('request_failed', 'Could not save.'),
        ),
      )
      .finally(() => setBusy(false))
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure key</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{keyView.id}</span>
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`key-${keyView.id}-account`}
              className="text-muted-foreground text-xs tracking-wide uppercase"
            >
              Shared account
            </label>
            <Select
              value={accountId === '' ? '__independent' : accountId}
              onValueChange={(value) => setAccountId(value === '__independent' ? '' : value)}
            >
              <SelectTrigger id={`key-${keyView.id}-account`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__independent">Independent</SelectItem>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-foreground text-sm font-medium">
              Only allow models
            </label>
            <p className="text-muted-foreground text-xs">
              Restrict this upstream key to a subset of the catalog. Leave empty to allow
              everything.
            </p>
            <ModelListPicker
              connectionId={connectionId}
              csrfToken={csrfToken}
              selected={allowedModels}
              onChange={setAllowedModels}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label className="text-foreground text-sm font-medium">
              Exclude models
            </label>
            <p className="text-muted-foreground text-xs">
              Block specific model IDs even when the key would otherwise reach them. Leave
              empty to exclude nothing.
            </p>
            <ModelListPicker
              connectionId={connectionId}
              csrfToken={csrfToken}
              selected={deniedModels}
              onChange={setDeniedModels}
            />
          </div>

          {error !== null && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Could not save</AlertTitle>
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : 'Save key settings'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function KeyActionsMenu({
  keyView,
  connectionId,
  csrfToken,
  busy,
  run,
  onConfigure,
}: {
  readonly keyView: KeyView
  readonly connectionId: string
  readonly csrfToken: string
  readonly busy: string | null
  readonly run: (label: string, perform: () => Promise<unknown>) => Promise<void>
  readonly onConfigure: () => void
}) {
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`Actions for ${keyView.id}`}
        >
          <MoreHorizontal className="size-3.5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onSelect={onConfigure} disabled={busy !== null}>
          Configure
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() =>
            void run(`test-${keyView.id}`, () => testKey(connectionId, keyView.id, csrfToken))
          }
          disabled={busy !== null}
        >
          {busy === `test-${keyView.id}` ? 'Testing…' : 'Test'}
        </DropdownMenuItem>
        {keyView.health !== 'active' && (
          <DropdownMenuItem
            onSelect={() =>
              void run(`activate-${keyView.id}`, () =>
                activateKey(connectionId, keyView.id, csrfToken),
              )
            }
            disabled={busy !== null}
          >
            {busy === `activate-${keyView.id}` ? 'Activating…' : 'Activate'}
          </DropdownMenuItem>
        )}
        {keyView.health !== 'disabled' && (
          <DropdownMenuItem
            onSelect={() =>
              void run(`disable-${keyView.id}`, () =>
                disableKey(connectionId, keyView.id, csrfToken),
              )
            }
            disabled={busy !== null}
          >
            {busy === `disable-${keyView.id}` ? 'Disabling…' : 'Disable'}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => {
            if (confirmingRemove) {
              void run(`remove-${keyView.id}`, () => removeKey(connectionId, keyView.id, csrfToken))
            } else {
              setConfirmingRemove(true)
            }
          }}
          disabled={busy !== null}
        >
          {busy === `remove-${keyView.id}`
            ? 'Removing…'
            : confirmingRemove
              ? 'Confirm remove'
              : 'Remove'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function UpstreamKeyRow({
  connectionId,
  accounts,
  keyView,
  csrfToken,
  busy,
  run,
  onConfigure,
}: {
  readonly connectionId: string
  readonly accounts: ConnectionView['accounts']
  readonly keyView: KeyView
  readonly csrfToken: string
  readonly busy: string | null
  readonly run: (label: string, perform: () => Promise<unknown>) => Promise<void>
  readonly onConfigure: () => void
}) {
  const account = accounts.find((candidate) => candidate.id === keyView.accountId)

  return (
    <tr className="hover:bg-muted/30 group transition-colors">
      <td className="px-5 py-3.5 align-top">
        <KeyHealthBadge health={keyView.health} />
        {keyNeedsAttention(keyView) && keyView.healthReason !== null && (
          <p className="text-muted-foreground mt-1 text-xs">{keyView.healthReason}</p>
        )}
      </td>
      <td className="px-5 py-3.5 align-top">
        <span className="text-muted-foreground font-mono text-xs">{keyView.id}</span>
      </td>
      <td className="px-5 py-3.5 align-top text-sm">
        {account === undefined ? (
          <span className="text-muted-foreground italic">Independent</span>
        ) : (
          <span>{account.displayName}</span>
        )}
      </td>
      <td className="px-5 py-3.5 align-top text-xs">
        {keyView.allowedModels !== null
          ? `Only ${keyView.allowedModels.join(', ')}`
          : keyView.deniedModels !== null
            ? `All except ${keyView.deniedModels.join(', ')}`
            : 'All models'}
      </td>
      <td className="px-5 py-3.5 text-right align-top">
        <div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <KeyActionsMenu
            keyView={keyView}
            connectionId={connectionId}
            csrfToken={csrfToken}
            busy={busy}
            run={run}
            onConfigure={onConfigure}
          />
        </div>
      </td>
    </tr>
  )
}

function KeyHealthCard({ connection }: { readonly connection: ConnectionView }) {
  const counts = countByHealth(connection)
  const total = connection.keys.length
  const palette: Record<typeof HEALTH_ORDER[number], string> = {
    active: 'bg-status-healthy',
    unverified: 'bg-status-warning',
    cooling_down: 'bg-status-warning',
    invalid_authentication: 'bg-status-danger',
    exhausted: 'bg-status-danger',
    disabled: 'bg-muted-foreground/40',
  }

  return (
    <section className="bg-card rounded-xl border p-5">
      <h3 className="text-sm font-semibold tracking-tight">Key health</h3>
      <p className="text-muted-foreground mt-1 text-xs">
        Breakdown for this connection only. {total} keys total.
      </p>
      <div className="bg-muted mt-4 flex h-2 w-full overflow-hidden rounded-full">
        {HEALTH_ORDER.map((key) => {
          const count = counts[key] ?? 0
          if (count === 0) return null
          const pct = (count / total) * 100
          return (
            <span
              key={key}
              className={`${palette[key]} h-full`}
              style={{ width: `${pct}%` }}
              title={`${HEALTH_LABELS[key]}: ${count}`}
            />
          )
        })}
      </div>
      <ul className="mt-4 grid grid-cols-2 gap-2 text-xs">
        {HEALTH_ORDER.map((key) => (
          <li key={key} className="flex items-center gap-2">
            <span className={`${palette[key]} size-2 rounded-full`} aria-hidden />
            <span className="text-muted-foreground">
              {counts[key] ?? 0} {HEALTH_LABELS[key]}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SharedAccountsCard({
  connection,
  csrfToken,
  onChanged,
}: {
  readonly connection: ConnectionView
  readonly csrfToken: string
  readonly onChanged: () => void
}) {
  const [accountName, setAccountName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<ManagementError | null>(null)

  const run = async (label: string, perform: () => Promise<unknown>) => {
    setBusy(label)
    setError(null)
    try {
      await perform()
      onChanged()
    } catch (cause) {
      setError(
        cause instanceof ManagementError
          ? cause
          : new ManagementError('request_failed', 'That did not work.'),
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="bg-card rounded-xl border p-5">
      <div>
        <h3 className="text-sm font-semibold tracking-tight">Shared accounts</h3>
        <p className="text-muted-foreground mt-1 text-xs">
          Keys that share capacity pool their rate limits and billing.
        </p>
      </div>

      {error && (
        <Alert variant="destructive" role="alert" className="mt-3">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      {connection.accounts.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-xs">No shared accounts yet.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2">
          {connection.accounts.map((account) => {
            const memberKeys = connection.keys.filter((key) => key.accountId === account.id)
            return (
              <li
                key={account.id}
                className="border-border bg-muted/40 flex items-center justify-between rounded-lg border px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <Users className="text-muted-foreground size-3.5" aria-hidden />
                  <span className="text-sm font-medium">{account.displayName}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-muted-foreground text-xs">
                    {memberKeys.length} {memberKeys.length === 1 ? 'key' : 'keys'}
                  </span>
                  {!connection.archived && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() =>
                        void run(`delete-account-${account.id}`, () =>
                          deleteUpstreamAccount(connection.id, account.id, csrfToken),
                        )
                      }
                      disabled={busy !== null}
                    >
                      {busy === `delete-account-${account.id}` ? 'Deleting…' : 'Delete'}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {!connection.archived && (
        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (accountName.trim() === '') return
            void run('create-account', async () => {
              await createUpstreamAccount(connection.id, accountName, csrfToken)
              setAccountName('')
            })
          }}
        >
          <div className="flex flex-1 flex-col gap-1.5">
            <label
              htmlFor="account-name"
              className="text-muted-foreground text-xs tracking-wide uppercase"
            >
              New account name
            </label>
            <input
              id="account-name"
              type="text"
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
            />
          </div>
          <Button type="submit" size="sm" disabled={busy !== null || accountName.trim() === ''}>
            {busy === 'create-account' ? 'Creating…' : 'Create account'}
          </Button>
        </form>
      )}
    </section>
  )
}

function ConnectionDetailsCard({ connection }: { readonly connection: ConnectionView }) {
  return (
    <section className="bg-card rounded-xl border p-5">
      <h3 className="text-sm font-semibold tracking-tight">Connection details</h3>
      <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <DetailRow label="Base URL">
          <span className="font-mono break-all">{connection.baseUrl}</span>
        </DetailRow>
        <DetailRow label="Retry policy">
          {connection.retryMaxAttempts} {connection.retryMaxAttempts === 1 ? 'attempt' : 'attempts'}
          {connection.retryAmbiguousNetwork ? ' · Ambiguous net on' : ' · Ambiguous net off'}
        </DetailRow>
        <DetailRow label="Insecure HTTP">
          {connection.allowInsecureHttp ? (
            <span className="text-status-danger">Allowed (plain HTTP)</span>
          ) : (
            'Off'
          )}
        </DetailRow>
        <DetailRow label="Created">{formatTime(connection.createdAt)}</DetailRow>
        <DetailRow label="Updated">{formatTime(connection.updatedAt)}</DetailRow>
      </dl>
    </section>
  )
}

function DetailRow({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs tracking-wide uppercase">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function UsageAdapterCard({
  usage,
  connectionId,
}: {
  readonly usage: UsageView
  readonly connectionId: string
}) {
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [snapshot, setSnapshot] = useState<UsageView>(usage)

  useEffect(() => {
    setSnapshot(usage)
  }, [usage])

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      const next = await fetchUsage(connectionId)
      setSnapshot(next)
    } catch (cause) {
      setError(cause)
    } finally {
      setRefreshing(false)
    }
  }

  const visibility =
    snapshot.visibility === 'authoritative' ? 'Authoritative' : 'Reactive-only'

  return (
    <section className="bg-card rounded-xl border p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold tracking-tight">Usage adapter</h3>
        <span className="border-border bg-muted text-muted-foreground rounded-full border px-2 py-0.5 text-xs font-medium">
          {visibility}
        </span>
      </div>
      {error !== null && (
        <Alert variant="destructive" role="alert" className="mt-3">
          <AlertTitle>Usage refresh failed</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'Try again.'}
          </AlertDescription>
        </Alert>
      )}
      <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <DetailRow label="Last successful poll">
          {snapshot.lastSuccessAt === null ? 'Never' : formatTime(snapshot.lastSuccessAt)}
        </DetailRow>
        <DetailRow label="Last failure">
          {snapshot.lastFailureAt === null
            ? 'None'
            : `${formatTime(snapshot.lastFailureAt)}${snapshot.lastFailureCode === null ? '' : ` · ${snapshot.lastFailureCode}`}`}
        </DetailRow>
        <DetailRow label="Catalog stale">{snapshot.stale ? 'Yes' : 'No'}</DetailRow>
        {snapshot.reading !== null && (
          <>
            <DetailRow label="Unit">{snapshot.reading.unit}</DetailRow>
            <DetailRow label="Balance">{snapshot.reading.balance ?? 'Unknown'}</DetailRow>
            <DetailRow label="Used">{snapshot.reading.used ?? '—'}</DetailRow>
            <DetailRow label="Limit">{snapshot.reading.limit ?? '—'}</DetailRow>
            <DetailRow label="Reset at">
              {snapshot.reading.resetAt === null ? '—' : formatTime(snapshot.reading.resetAt)}
            </DetailRow>
          </>
        )}
      </dl>
      <div className="mt-4 flex items-center justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={refreshing}
        >
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </Button>
      </div>
    </section>
  )
}

function UsageAdapterSkeleton() {
  return (
    <section className="bg-card rounded-xl border p-5">
      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-4 h-12 w-full" />
    </section>
  )
}

function countByHealth(connection: ConnectionView): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(HEALTH_ORDER.map((key) => [key, 0]))
  for (const key of connection.keys) {
    counts[key.health] = (counts[key.health] ?? 0) + 1
  }
  return counts
}

function formatTime(iso: string): string {
  return formatTimeWithUtc(iso, { dateStyle: 'medium', timeStyle: 'short' })
}

function buildConnectionAnalytics(events: readonly RequestEventView[]): ConnectionAnalytics {
  const now = Date.now()
  const currentHourStart = Math.floor(now / HOUR_MS) * HOUR_MS
  const firstHourStart = currentHourStart - (ANALYTICS_HOURS - 1) * HOUR_MS
  const hourlyCounts = new Array<number>(ANALYTICS_HOURS).fill(0)
  const windowCounts = new Map<number, number>()
  const modelCounts = new Map<string, number>()
  let failures = 0
  const latencies: number[] = []

  for (const event of events) {
    const ts = new Date(event.occurredAt).getTime()
    if (Number.isNaN(ts)) continue
    if (ts < firstHourStart) continue

    const hourIndex = Math.floor((ts - firstHourStart) / HOUR_MS)
    if (hourIndex >= 0 && hourIndex < ANALYTICS_HOURS) {
      hourlyCounts[hourIndex] = (hourlyCounts[hourIndex] ?? 0) + 1
    }

    const windowStart = Math.floor(ts / FIVE_MIN_MS) * FIVE_MIN_MS
    windowCounts.set(windowStart, (windowCounts.get(windowStart) ?? 0) + 1)

    if (event.outcome === 'failure') failures += 1

    latencies.push(event.latencyMs)
    modelCounts.set(event.model, (modelCounts.get(event.model) ?? 0) + 1)
  }

  let peakWindow = 0
  for (const count of windowCounts.values()) {
    if (count > peakWindow) peakWindow = count
  }
  const peakRpm = Math.round(peakWindow / 5)

  let topModel: string | null = null
  let topCount = 0
  for (const [model, count] of modelCounts) {
    if (count > topCount) {
      topCount = count
      topModel = model
    }
  }

  const totalRequests = hourlyCounts.reduce((sum, count) => sum + count, 0)
  const errorRate = totalRequests === 0 ? 0 : failures / totalRequests

  return {
    hourlyCounts,
    peakRpm,
    errorRate,
    p95LatencyMs: percentile(latencies, 0.95),
    topModel,
    totalRequests,
  }
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (sorted.length - 1) * p
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  const lowerValue = sorted[lower] ?? 0
  const upperValue = sorted[upper] ?? lowerValue
  if (lower === upper) return lowerValue
  const weight = rank - lower
  return lowerValue + (upperValue - lowerValue) * weight
}