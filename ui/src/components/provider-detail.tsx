import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft,
  Archive,
  Check,
  Copy,
  Eye,
  Info,
  KeyRound,
  Loader2,
  RefreshCcw,
  Settings,
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { MoreHorizontal } from 'lucide-react'
import { ProviderIcon } from '@/components/provider-icon'
import { EditProviderForm } from '@/components/edit-provider-form'
import { ModelListPicker } from '@/components/model-list-picker'
import { CodeSnippetCard } from '@/components/code-snippet-card'
import {
  HEALTH_LABELS,
  HEALTH_ORDER,
  KeyHealthBadge,
} from '@/components/key-health'
import { Dot } from '@/components/dot'
import { LineChart, Line } from '@/components/charts/line-chart'
import { describeProviderStatus } from '@/lib/provider-status'
import {
  activateKey,
  addKey,
  archiveProvider,
  disableKey,
  duplicateProvider,
  fetchProviders,
  ManagementError,
  purgeProvider,
  removeKey,
  revealKey,
  testKey,
  updateKeySettings,
  type KeyView,
  type ProviderView,
} from '@/lib/providers'
import { fetchRequests, type RequestEventView } from '@/lib/requests'
import { refreshCatalog } from '@/lib/catalog'
import { fetchUsage, type UsageView } from '@/lib/usage'
import { formatTime as formatTimeWithUtc } from '@/lib/time'

interface ProviderDetailProps {
  readonly providerId: string
  readonly csrfToken: string
  readonly onBack: () => void
  readonly onDeleted: () => void
}

interface ProviderAnalytics {
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

export function ProviderDetail({
  providerId,
  csrfToken,
  onBack,
  onDeleted,
}: ProviderDetailProps) {
  const [provider, setProvider] = useState<ProviderView | null>(null)
  const [analytics, setAnalytics] = useState<ProviderAnalytics | null>(null)
  const [usage, setUsage] = useState<UsageView | null>(null)
  const [usageLoading, setUsageLoading] = useState(true)
  const [error, setError] = useState<ManagementError | null>(null)

  const reload = useCallback(async () => {
    try {
      const all = await fetchProviders()
      const match = all.find((c) => c.id === providerId)
      if (match === undefined) {
        setError(new ManagementError('provider_not_found', 'No such Provider.'))
        setProvider(null)
        return
      }
      setProvider(match)
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
  }, [providerId, onBack])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    let cancelled = false
    void fetchRequests({ providerId }, { limit: 800 })
      .then((page) => {
        if (cancelled) return
        setAnalytics(buildProviderAnalytics(page.events))
      })
      .catch(() => {
        if (cancelled) return
        setAnalytics(null)
      })
    return () => {
      cancelled = true
    }
  }, [providerId])

  useEffect(() => {
    let cancelled = false
    setUsageLoading(true)
    void fetchUsage(providerId)
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
  }, [providerId])

  if (provider === null && error === null) {
    return <Skeleton className="h-48 w-full" />
  }

  if (provider === null && error !== null) {
    return (
      <div className="flex flex-col gap-4">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-3.5" aria-hidden /> Back to Providers
        </Button>
        <Alert variant="destructive" role="alert">
          <AlertTitle>Provider unavailable</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </div>
    )
  }

  if (provider === null) return null

  const status = describeProviderStatus(provider.keys)
  const archived = provider.archived

  return (
    <div className="flex flex-col gap-6">
      <ProviderHeader
        provider={provider}
        status={status}
        archived={archived}
        onBack={onBack}
      />

      <ProviderAnalyticsStrip analytics={analytics} />

      <ProviderActions
        provider={provider}
        csrfToken={csrfToken}
        onChanged={reload}
        onDeleted={onDeleted}
      />

      <UpstreamKeysCard
        provider={provider}
        csrfToken={csrfToken}
        onChanged={reload}
      />

      <CodeSnippetCard provider={provider} />

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <KeyHealthCard provider={provider} />
        <ProviderDetailsCard provider={provider} />
        {usage !== null ? (
          <UsageAdapterCard usage={usage} providerId={providerId} />
        ) : usageLoading ? (
          <UsageAdapterSkeleton />
        ) : null}
      </div>
    </div>
  )
}

function ProviderHeader({
  provider,
  status,
  archived,
  onBack,
}: {
  readonly provider: ProviderView
  readonly status: ReturnType<typeof describeProviderStatus>
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
          displayName={provider.displayName}
          baseUrl={provider.baseUrl}
          {...(provider.templateId === null ? {} : { templateId: provider.templateId })}
        />
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-2xl font-semibold tracking-tight">{provider.displayName}</h1>
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
            {!archived && !provider.enabled && (
              <span className="border-border bg-muted text-muted-foreground inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium">
                Disabled
              </span>
            )}
          </div>
          <span className="text-muted-foreground font-mono text-xs">{provider.id}</span>
        </div>
      </div>
    </div>
  )
}

function ProviderAnalyticsStrip({
  analytics,
}: {
  readonly analytics: ProviderAnalytics | null
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
        No traffic recorded for this provider in the last 24 hours.
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

function ProviderActions({
  provider,
  csrfToken,
  onChanged,
  onDeleted,
}: {
  readonly provider: ProviderView
  readonly csrfToken: string
  readonly onChanged: () => void
  readonly onDeleted: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const [confirmingPurge, setConfirmingPurge] = useState(false)
  const [rowError, setRowError] = useState<ManagementError | null>(null)
  const archived = provider.archived

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
            <DialogTitle>Edit {provider.displayName}</DialogTitle>
            <DialogDescription>
              Editing keeps the provider's ID unchanged, so client URLs stay valid.
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

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
          <Settings className="size-3.5" aria-hidden /> Edit settings
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void run('refresh', () => refreshCatalog(provider.id, csrfToken))}
          disabled={busy !== null || archived}
        >
          <RefreshCcw className="size-3.5" aria-hidden />
          {busy === 'refresh' ? 'Refreshing…' : 'Refresh catalog'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void run('duplicate', () => duplicateProvider(provider.id, csrfToken))}
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
                void run('archive', () => archiveProvider(provider.id, csrfToken))
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
                  await purgeProvider(provider.id, csrfToken)
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
  provider,
  csrfToken,
  onChanged,
}: {
  readonly provider: ProviderView
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
            {provider.keys.length}
          </span>
        </div>
        {!provider.archived && (
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

      {adding && !provider.archived && (
        <AddKeyDialog
          providerId={provider.id}
          defaultBaseUrl={provider.baseUrl}
          csrfToken={csrfToken}
          onAdd={(input) =>
            run('add-key', () => addKey(provider.id, input, csrfToken))
          }
          onDone={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      )}

      {configuring !== null && !provider.archived && (
        <ConfigureKeyDialog
          providerId={provider.id}
          defaultBaseUrl={provider.baseUrl}
          keyView={configuring}
          csrfToken={csrfToken}
          onDone={() => {
            setConfiguring(null)
            onChanged()
          }}
          onCancel={() => setConfiguring(null)}
        />
      )}

      {provider.keys.length === 0 ? (
        <p className="text-muted-foreground px-5 py-6 text-sm">
          No Upstream Keys yet. Add one to give this provider inference capacity.
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
                  base url
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
              {provider.keys.map((key) => (
                <UpstreamKeyRow
                  key={key.id}
                  providerId={provider.id}
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
  providerId,
  defaultBaseUrl,
  csrfToken,
  onAdd,
  onDone,
  onCancel,
}: {
  readonly providerId: string
  readonly defaultBaseUrl: string
  readonly csrfToken: string
  readonly onAdd: (input: {
    readonly upstreamKey: string
    readonly baseUrl?: string | null
    readonly accountId: string | null
    readonly allowedModels: readonly string[] | null
    readonly deniedModels: readonly string[] | null
  }) => Promise<void>
  readonly onDone: () => void
  readonly onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl)
  const [allowedModels, setAllowedModels] = useState<readonly string[]>([])
  const [deniedModels, setDeniedModels] = useState<readonly string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ManagementError | null>(null)

  const trimmedBaseUrl = baseUrl.trim()
  const explicitOverride = trimmedBaseUrl !== '' && trimmedBaseUrl !== defaultBaseUrl

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || value === '') return
    setBusy(true)
    setError(null)
    void onAdd({
      upstreamKey: value,
      baseUrl: explicitOverride ? trimmedBaseUrl : null,
      accountId: null,
      allowedModels: allowedModels.length === 0 ? null : allowedModels,
      deniedModels: deniedModels.length === 0 ? null : deniedModels,
    })
      .then(() => {
        setValue('')
        setBaseUrl(defaultBaseUrl)
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
              htmlFor="add-key-base-url"
              className="text-foreground text-sm font-medium"
            >
              Base URL override
            </label>
            <p className="text-muted-foreground text-xs">
              Optional. Leave blank or set to the Provider default to inherit it. Set a
              different URL to send requests from this key to a separate endpoint.
            </p>
            <input
              id="add-key-base-url"
              type="url"
              autoComplete="off"
              placeholder={defaultBaseUrl}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="border-input bg-background h-9 rounded-md border px-2 font-mono text-sm"
            />
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
              providerId={providerId}
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
              providerId={providerId}
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
  providerId,
  defaultBaseUrl,
  keyView,
  csrfToken,
  onDone,
  onCancel,
}: {
  readonly providerId: string
  readonly defaultBaseUrl: string
  readonly keyView: KeyView
  readonly csrfToken: string
  readonly onDone: () => void
  readonly onCancel: () => void
}) {
  const [baseUrl, setBaseUrl] = useState(keyView.baseUrl ?? '')
  const [allowedModels, setAllowedModels] = useState<readonly string[]>(keyView.allowedModels ?? [])
  const [deniedModels, setDeniedModels] = useState<readonly string[]>(keyView.deniedModels ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ManagementError | null>(null)

  const trimmedBaseUrl = baseUrl.trim()
  const explicitOverride = trimmedBaseUrl !== '' && trimmedBaseUrl !== defaultBaseUrl
  const clearingOverride = trimmedBaseUrl === '' && keyView.baseUrl !== null

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    void updateKeySettings(
      providerId,
      keyView.id,
      {
        accountId: null,
        baseUrl: explicitOverride ? trimmedBaseUrl : clearingOverride ? null : undefined,
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
              htmlFor={`key-${keyView.id}-base-url`}
              className="text-muted-foreground text-xs tracking-wide uppercase"
            >
              Base URL override
            </label>
            <p className="text-muted-foreground text-xs">
              The key currently reaches{' '}
              <span className="font-mono">{keyView.effectiveBaseUrl}</span>.
              {keyView.baseUrl === null ? (
                <>
                  {' '}
                  To override the Provider default (
                  <span className="font-mono">{defaultBaseUrl}</span>) with a separate
                  endpoint, enter a URL. Leave blank to keep inheriting the default.
                </>
              ) : (
                <>
                  {' '}
                  Clear the field to fall back to the Provider default (
                  <span className="font-mono">{defaultBaseUrl}</span>).
                </>
              )}
            </p>
            <input
              id={`key-${keyView.id}-base-url`}
              type="url"
              autoComplete="off"
              placeholder={defaultBaseUrl}
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              className="border-input bg-background h-9 rounded-md border px-2 font-mono text-sm"
            />
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
              providerId={providerId}
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
              providerId={providerId}
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
  providerId,
  csrfToken,
  busy,
  run,
  onConfigure,
  onReveal,
  revealing,
  revealed,
}: {
  readonly keyView: KeyView
  readonly providerId: string
  readonly csrfToken: string
  readonly busy: string | null
  readonly run: (label: string, perform: () => Promise<unknown>) => Promise<void>
  readonly onConfigure: () => void
  readonly onReveal: () => void
  readonly revealing: boolean
  readonly revealed: boolean
}) {
  const [removing, setRemoving] = useState(false)
  const onConfirmRemove = () => {
    void run(`remove-${keyView.id}`, () => removeKey(providerId, keyView.id, csrfToken))
  }
  return (
    <>
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
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={onConfigure} disabled={busy !== null}>
            Configure
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={onReveal}
            disabled={busy !== null || revealing}
          >
            <Eye className="size-3.5" aria-hidden />
            {revealing ? 'Revealing…' : revealed ? 'Reveal again' : 'Reveal value'}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              void run(`test-${keyView.id}`, () => testKey(providerId, keyView.id, csrfToken))
            }
            disabled={busy !== null}
          >
            {busy === `test-${keyView.id}` ? 'Testing…' : 'Test'}
          </DropdownMenuItem>
          {keyView.health !== 'active' && (
            <DropdownMenuItem
              onSelect={() =>
                void run(`activate-${keyView.id}`, () =>
                  activateKey(providerId, keyView.id, csrfToken),
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
                  disableKey(providerId, keyView.id, csrfToken),
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
            onSelect={() => setRemoving(true)}
            disabled={busy !== null}
          >
            Remove
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove upstream key?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently deletes the upstream key and its history. Other keys on
              this Provider are unaffected. The encrypted key value is discarded and cannot
              be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === `remove-${keyView.id}`}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy === `remove-${keyView.id}`}
              onClick={onConfirmRemove}
            >
              {busy === `remove-${keyView.id}` ? 'Removing…' : 'Remove key'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function UpstreamKeyRow({
  providerId,
  keyView,
  csrfToken,
  busy,
  run,
  onConfigure,
}: {
  readonly providerId: string
  readonly keyView: KeyView
  readonly csrfToken: string
  readonly busy: string | null
  readonly run: (label: string, perform: () => Promise<unknown>) => Promise<void>
  readonly onConfigure: () => void
}) {
  const [reveal, setReveal] = useState<{
    readonly value: string
  } | null>(null)
  const [revealing, setRevealing] = useState(false)
  const [revealError, setRevealError] = useState<ManagementError | null>(null)
  const [copied, setCopied] = useState(false)

  const onReveal = async () => {
    setRevealing(true)
    setRevealError(null)
    try {
      const result = await revealKey(providerId, keyView.id)
      setReveal({ value: result.value })
    } catch (cause) {
      setRevealError(
        cause instanceof ManagementError
          ? cause
          : new ManagementError('request_failed', 'Could not reveal the key.'),
      )
    } finally {
      setRevealing(false)
    }
  }

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const onCopy = async () => {
    if (reveal === null) return
    try {
      if (navigator.clipboard?.writeText !== undefined) {
        await navigator.clipboard.writeText(reveal.value)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = reveal.value
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
    <tr className="hover:bg-muted/30 group transition-colors">
      <td className="px-5 py-3.5 align-top">
        <TestStatusBadge
          health={keyView.health}
          lastProbe={keyView.lastProbe}
          healthReason={keyView.healthReason}
          pending={busy === `test-${keyView.id}`}
        />
      </td>
      <td className="px-5 py-3.5 align-top">
        <span className="font-mono text-xs" title={keyView.effectiveBaseUrl}>
          {keyView.effectiveBaseUrl}
        </span>
      </td>
      <td className="px-5 py-3.5 align-top text-xs">
        {keyView.allowedModels !== null
          ? `Only ${keyView.allowedModels.join(', ')}`
          : keyView.deniedModels !== null
            ? `All except ${keyView.deniedModels.join(', ')}`
            : 'All models'}
      </td>
      <td className="px-5 py-3.5 text-right align-top">
        <div className="flex items-center justify-end gap-1">
          <div className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
            <KeyActionsMenu
              keyView={keyView}
              providerId={providerId}
              csrfToken={csrfToken}
              busy={busy}
              run={run}
              onConfigure={onConfigure}
              onReveal={() => void onReveal()}
              revealing={revealing}
              revealed={reveal !== null}
            />
          </div>
          {revealError !== null && (
            <span
              className="text-status-danger ml-2 text-xs"
              role="alert"
              title={revealError.message}
            >
              Reveal failed
            </span>
          )}
        </div>
      </td>
      {reveal !== null && (
        <RevealedValueDialog
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setReveal(null)
              setCopied(false)
            }
          }}
          value={reveal.value}
          copied={copied}
          onCopy={() => void onCopy()}
        />
      )}
    </tr>
  )
}

function RevealedValueDialog({
  open,
  onOpenChange,
  value,
  copied,
  onCopy,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly value: string
  readonly copied: boolean
  readonly onCopy: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upstream key value</DialogTitle>
          <DialogDescription>
            This is the secret the Provider holds for this key. Copy it once and store it in
            your own secret manager — every reveal is recorded in the audit log.
          </DialogDescription>
        </DialogHeader>
        <code className="bg-muted text-foreground block max-h-72 w-full overflow-y-auto whitespace-pre-wrap break-all rounded-md px-3 py-2 font-mono text-xs">
          {value}
        </code>
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={onCopy}>
            {copied ? (
              <>
                <Check className="size-3.5" aria-hidden />
                Copied
              </>
            ) : (
              <>
                <Copy className="size-3.5" aria-hidden />
                Copy
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TestStatusBadge({
  health,
  lastProbe,
  healthReason,
  pending,
}: {
  readonly health: KeyView['health']
  readonly lastProbe: KeyView['lastProbe']
  readonly healthReason: string | null
  readonly pending: boolean
}) {
  // The tooltip shows the most specific reason we have. The test reason
  // wins when present; otherwise we fall back to the durable health reason
  // (e.g. an upstream that 401'd during real inference, not a test).
  const testReason = lastProbe?.reason ?? null
  const reason =
    testReason ??
    (keyNeedsAttentionFor(health) ? healthReason : null)
  const badge = pending ? <PendingTestBadge /> : <KeyHealthBadge health={health} />
  if (pending || reason === null) {
    return badge
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {badge}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground inline-flex size-4 cursor-help items-center justify-center rounded"
            aria-label={`Reason: ${reason}`}
          >
            <Info className="size-3" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          {reason}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

function keyNeedsAttentionFor(health: KeyView['health']): boolean {
  return (
    health === 'cooling_down' ||
    health === 'invalid_authentication' ||
    health === 'exhausted'
  )
}

function PendingTestBadge() {
  return (
    <span
      role="status"
      aria-live="polite"
      className="border-border bg-muted text-muted-foreground inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium"
    >
      <Loader2 className="size-2.5 animate-spin" aria-hidden />
      <span>Testing…</span>
    </span>
  )
}

function KeyHealthCard({ provider }: { readonly provider: ProviderView }) {
  const counts = countByHealth(provider)
  const total = provider.keys.length
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
        Breakdown for this provider only. {total} keys total.
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

function ProviderDetailsCard({ provider }: { readonly provider: ProviderView }) {
  return (
    <section className="bg-card rounded-xl border p-5">
      <h3 className="text-sm font-semibold tracking-tight">Provider details</h3>
      <dl className="mt-4 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <DetailRow label="Base URL">
          <span className="font-mono break-all">{provider.baseUrl}</span>
        </DetailRow>
        <DetailRow label="Retry policy">
          {provider.retryMaxAttempts} {provider.retryMaxAttempts === 1 ? 'attempt' : 'attempts'}
          {provider.retryAmbiguousNetwork ? ' · Ambiguous net on' : ' · Ambiguous net off'}
        </DetailRow>
        <DetailRow label="Insecure HTTP">
          {provider.allowInsecureHttp ? (
            <span className="text-status-danger">Allowed (plain HTTP)</span>
          ) : (
            'Off'
          )}
        </DetailRow>
        <DetailRow label="Created">{formatTime(provider.createdAt)}</DetailRow>
        <DetailRow label="Updated">{formatTime(provider.updatedAt)}</DetailRow>
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
  providerId,
}: {
  readonly usage: UsageView
  readonly providerId: string
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
      const next = await fetchUsage(providerId)
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

function countByHealth(provider: ProviderView): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(HEALTH_ORDER.map((key) => [key, 0]))
  for (const key of provider.keys) {
    counts[key.health] = (counts[key.health] ?? 0) + 1
  }
  return counts
}

function formatTime(iso: string): string {
  return formatTimeWithUtc(iso, { dateStyle: 'medium', timeStyle: 'short' })
}

function buildProviderAnalytics(events: readonly RequestEventView[]): ProviderAnalytics {
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
