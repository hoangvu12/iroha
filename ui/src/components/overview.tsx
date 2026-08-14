import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Calendar,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  KeyRound,
  RefreshCcw,
  Server,
  SlidersHorizontal,
} from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { StatefulButton } from '@/components/ui/stateful-button'
import { Skeleton } from '@/components/ui/skeleton'
import { AreaChart, Area } from '@/components/charts/area-chart'
import { LineChart, Line } from '@/components/charts/line-chart'
import { Grid } from '@/components/charts/grid'
import { XAxis } from '@/components/charts/x-axis'
import { ChartTooltip } from '@/components/charts/tooltip/chart-tooltip'
import { Card } from '@/components/card'
import { EmptyState } from '@/components/empty-state'
import { HealthDistribution } from '@/components/health-distribution'
import { Dot } from '@/components/dot'
import { Sparkline } from '@/components/sparkline'
import {
  HEALTH_LABELS,
  HEALTH_ORDER,
  healthTone,
  keyNeedsAttention,
} from '@/components/key-health'
import { fetchBackgroundJobs, type BackgroundJobView } from '@/lib/background'
import { fetchProviders, type ProviderView } from '@/lib/providers'
import { fetchRequests, type RequestEventView } from '@/lib/requests'
import { formatTime as formatTimeWithUtc } from '@/lib/time'

interface OverviewProps {
  readonly csrfToken: string
}

const HOUR_MS = 60 * 60 * 1000
const BUCKET_HOURS = 12

interface HourBucket {
  date: Date
  status2xx: number
  status4xx: number
  status5xx: number
  latencies: number[]
}

interface VolumePoint {
  date: Date
  '2xx': number
  '4xx': number
  '5xx': number
  [key: string]: unknown
}

interface LatencyPoint {
  date: Date
  p50: number
  p95: number
  p99: number
  [key: string]: unknown
}

interface TopModelPoint {
  model: string
  count: number
  [key: string]: unknown
}

interface SparklineBundle {
  providers: number[]
  keys: number[]
  attention: number[]
  requests: number[]
}

/**
 * The exception-first Overview. Five glances, top to bottom:
 *
 *   1. Page header
 *   2. Four KPI cards (each with an inline sparkline)
 *   3. Two chart cards: request volume stacked by status class, latency p50/p95/p99
 *   4. Top models card: horizontal bar list of the busiest models
 *   5. Two list cards: recent failures, upstream key state
 *
 * All charts are fed by `request_events` (the only true time-series in the
 * data model). The status-class stack uses 2xx / 4xx / 5xx so a rising error
 * share is visible at a glance; the latency line shows p99 (danger), p95
 * (warning), and p50 (healthy) over the same window.
 */
export function Overview(_props: OverviewProps) {
  const [providers, setProviders] = useState<readonly ProviderView[] | null>(null)
  const [requests, setRequests] = useState<readonly RequestEventView[] | null>(null)
  const [jobs, setJobs] = useState<readonly BackgroundJobView[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      const [list, page, jobList] = await Promise.all([
        fetchProviders(),
        fetchRequests({}, { limit: 200 }),
        fetchBackgroundJobs(),
      ])
      setProviders(list)
      setRequests(page.events)
      setJobs(jobList)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Overview could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const activeProviders = (providers ?? []).filter((p) => !p.archived)
  const allKeys = activeProviders.flatMap((p) => p.keys)
  const attentionCount = allKeys.filter(keyNeedsAttention).length
  const requestCount = requests?.length ?? null
  const metricsLoading = providers === null || requests === null
  const recentFailures = (requests ?? [])
    .filter((event) => event.outcome === 'failure')
    .slice(0, 5)
  const failedJobs = (jobs ?? []).filter(
    (job) => job.lastOutcome === 'failure' || job.status === 'failed',
  )

  const { volumeData, latencyData, topModels, sparklines } = useMemo(
    () => buildChartData(requests ?? []),
    [requests],
  )

  return (
    <div className="flex flex-col gap-4">
      <PageHeader />

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Overview unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <KpiRow
        providerCount={activeProviders.length}
        totalKeyCount={allKeys.length}
        attentionCount={attentionCount}
        requestCount={requestCount}
        loading={metricsLoading}
        sparklines={sparklines}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <Card
          title="Request volume"
          loading={requests === null}
          rightSlot={
            requests !== null && (
              <span className="text-muted-foreground text-xs">
                {requests.length} in last {BUCKET_HOURS}h
              </span>
            )
          }
        >
          {requests === null ? (
            <Skeleton className="h-32 w-full" />
          ) : volumeData.every((row) => row['2xx'] + row['4xx'] + row['5xx'] === 0) ? (
            <EmptyChartPlaceholder label="No traffic in the last 12 hours" />
          ) : (
            <AreaChart data={volumeData} status="ready" aspectRatio="16 / 9">
              <Grid horizontal />
              <Area
                dataKey="2xx"
                fill="var(--status-healthy)"
                fillOpacity={0.45}
                stroke="var(--status-healthy)"
                strokeWidth={1.5}
                fadeEdges
              />
              <Area
                dataKey="4xx"
                fill="var(--status-warning)"
                fillOpacity={0.55}
                stroke="var(--status-warning)"
                strokeWidth={1.5}
                fadeEdges
              />
              <Area
                dataKey="5xx"
                fill="var(--status-danger)"
                fillOpacity={0.65}
                stroke="var(--status-danger)"
                strokeWidth={1.5}
                fadeEdges
              />
              <XAxis />
              <ChartTooltip />
            </AreaChart>
          )}
        </Card>

        <Card
          title="Latency"
          loading={requests === null}
          rightSlot={
            requests !== null && (
              <span className="text-muted-foreground text-xs">
                p50 · p95 · p99 (ms)
              </span>
            )
          }
        >
          {requests === null ? (
            <Skeleton className="h-32 w-full" />
          ) : latencyData.every((row) => row.p50 + row.p95 + row.p99 === 0) ? (
            <EmptyChartPlaceholder label="No latency samples yet" />
          ) : (
            <LineChart data={latencyData} status="ready" aspectRatio="16 / 9">
              <Grid horizontal />
              <Line dataKey="p50" stroke="var(--status-healthy)" strokeWidth={1.5} />
              <Line dataKey="p95" stroke="var(--status-warning)" strokeWidth={1.5} />
              <Line dataKey="p99" stroke="var(--status-danger)" strokeWidth={2} />
              <XAxis />
              <ChartTooltip />
            </LineChart>
          )}
        </Card>
      </div>

      <Card
        title="Top models"
        loading={requests === null}
        rightSlot={
          requests !== null && (
            <span className="text-muted-foreground text-xs">{requests.length} requests</span>
          )
        }
      >
        {requests === null ? (
          <Skeleton className="h-24 w-full" />
        ) : topModels.length === 0 ? (
          <EmptyChartPlaceholder label="No traffic in the last 200 requests" />
        ) : (
          <TopModelsList models={topModels} />
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card
          title="Recent failures"
          loading={requests === null}
          rightSlot={
            <StatefulButton
              variant="ghost"
              size="xs"
              successLabel="Refreshed"
              aria-label="Refresh overview"
              onClick={() => void reload()}
            >
              <RefreshCcw className="size-3" aria-hidden /> Refresh
            </StatefulButton>
          }
        >
          {requests === null ? (
            <Skeleton className="h-32 w-full" />
          ) : recentFailures.length === 0 ? (
            <EmptyState
              icon={CheckCircle2}
              title="Nothing has failed recently"
              description="The last 200 requests returned without an error. New failures will surface here."
              compact
            />
          ) : (
            <ul className="divide-border -mx-2 divide-y">
              {recentFailures.map((event) => (
                <li
                  key={event.id}
                  className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 px-2 py-2 text-sm"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{event.model}</span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      · {event.providerId}
                    </span>
                  </div>
                  <span className="text-status-danger text-xs font-medium">
                    {event.errorCode ?? `HTTP ${event.status}`}
                  </span>
                  <div className="text-muted-foreground col-span-2 flex items-center gap-2 text-xs">
                    <span className="font-mono shrink-0">Key {event.keyId ?? '—'}</span>
                    <span>·</span>
                    <span className="font-mono tabular-nums shrink-0">{event.latencyMs} ms</span>
                    <span>·</span>
                    <span className="truncate">{formatTime(event.occurredAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Upstream keys" loading={providers === null}>
          {providers === null ? (
            <Skeleton className="h-32 w-full" />
          ) : allKeys.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="No upstream keys yet"
              description="Add a Provider and an Upstream Key to start routing traffic."
              compact
            />
          ) : (
            <div className="flex flex-col gap-3">
              <HealthDistribution
                counts={countByHealth(providers)}
                order={HEALTH_ORDER}
                labels={HEALTH_LABELS}
                tones={{
                  active: 'healthy',
                  unverified: 'warning',
                  cooling_down: 'warning',
                  invalid_authentication: 'danger',
                  exhausted: 'danger',
                  disabled: 'neutral',
                }}
              />
              <KeyStateList counts={countByHealth(providers)} failedJobsCount={failedJobs.length} />
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

interface KpiRowProps {
  readonly providerCount: number
  readonly totalKeyCount: number
  readonly attentionCount: number
  readonly requestCount: number | null
  readonly loading: boolean
  readonly sparklines: SparklineBundle
}

function PageHeader() {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
      </div>
      <div className="flex items-center gap-2">
        <KbdHint />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-muted-foreground font-normal"
        >
          <SlidersHorizontal className="size-3.5" aria-hidden />
          Filter
          <Kbd>R</Kbd>
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="text-muted-foreground font-normal"
        >
          <Calendar className="size-3.5" aria-hidden />
          Last 24 hours
          <ChevronDown className="size-3.5" aria-hidden />
        </Button>
        <KbdZx />
      </div>
    </div>
  )
}

function KbdHint() {
  return (
    <span
      aria-hidden
      className="border-border bg-background grid grid-cols-2 gap-[3px] rounded-md border p-1.5"
    >
      <span className="bg-muted-foreground/40 size-1 rounded-full" />
      <span className="bg-muted-foreground/40 size-1 rounded-full" />
      <span className="bg-muted-foreground/40 size-1 rounded-full" />
      <span className="bg-muted-foreground/40 size-1 rounded-full" />
    </span>
  )
}

function KbdZx() {
  return (
    <div
      aria-hidden
      className="border-border bg-background grid grid-cols-2 gap-[2px] rounded-md border p-1"
    >
      <span className="text-muted-foreground flex h-4 w-4 items-center justify-center text-[10px] font-mono">z</span>
      <span className="text-muted-foreground flex h-4 w-4 items-center justify-center text-[10px] font-mono">→</span>
      <span className="text-muted-foreground flex h-4 w-4 items-center justify-center text-[10px] font-mono">x</span>
      <span className="text-muted-foreground flex h-4 w-4 items-center justify-center text-[10px] font-mono">→</span>
    </div>
  )
}

function Kbd({ children }: { readonly children: React.ReactNode }) {
  return (
    <span
      aria-hidden
      className="border-border bg-background text-muted-foreground ml-1 inline-flex h-4 w-4 items-center justify-center rounded border text-[10px] font-mono"
    >
      {children}
    </span>
  )
}

function KpiRow({
  providerCount,
  totalKeyCount,
  attentionCount,
  requestCount,
  loading,
  sparklines,
}: KpiRowProps) {
  const formatCount = (value: number | null): string =>
    value === null ? '—' : value.toLocaleString('en-US')

  return (
    <div className="bg-card divide-border grid grid-cols-2 divide-y rounded-lg border md:grid-cols-4 md:divide-y-0 md:divide-x shadow-card">
      <Kpi
        icon={Server}
        label="Providers"
        loading={loading}
        sparkline={sparklines.providers}
        sparklineTone="primary"
        value={formatCount(providerCount)}
      />
      <Kpi
        icon={KeyRound}
        label="Upstream keys"
        loading={loading}
        sparkline={sparklines.keys}
        sparklineTone="healthy"
        value={formatCount(totalKeyCount)}
      />
      <Kpi
        icon={CircleAlert}
        label="Needs attention"
        loading={loading}
        tone={attentionCount > 0 ? 'warning' : 'healthy'}
        sparkline={sparklines.attention}
        sparklineTone={attentionCount > 0 ? 'warning' : 'healthy'}
        value={formatCount(attentionCount)}
      />
      <Kpi
        icon={Activity}
        label="Recent requests"
        loading={loading}
        sparkline={sparklines.requests}
        sparklineTone="primary"
        value={formatCount(requestCount)}
      />
    </div>
  )
}

interface KpiProps {
  readonly icon: typeof Activity
  readonly label: string
  readonly loading: boolean
  readonly subtitle?: string
  readonly tone?: 'healthy' | 'warning'
  readonly value: string
  readonly sparkline: readonly number[]
  readonly sparklineTone: 'primary' | 'healthy' | 'warning'
}

function Kpi({
  icon: Icon,
  label,
  loading,
  subtitle,
  tone = 'healthy',
  value,
  sparkline,
  sparklineTone,
}: KpiProps) {
  return (
    <div className="flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <Icon className="text-muted-foreground size-4" aria-hidden strokeWidth={1.5} />
        <span className="text-muted-foreground text-xs font-medium">{label}</span>
        {tone === 'warning' && <Dot tone="warning" />}
      </div>
      {loading ? (
        <Skeleton className="h-7 w-16" />
      ) : (
        <span className="text-foreground text-2xl font-semibold leading-none tracking-tight tabular-nums">
          {value}
        </span>
      )}
      <div className="-mb-1 -mx-4">
        <Sparkline data={sparkline} tone={sparklineTone} height={28} />
      </div>
      <span className="text-muted-foreground h-3.5 text-xs">{subtitle ?? ''}</span>
    </div>
  )
}

function KeyStateList({
  counts,
  failedJobsCount,
}: {
  readonly counts: Readonly<Record<string, number>>
  readonly failedJobsCount: number
}) {
  const entries = HEALTH_ORDER.map((health) => ({
    health,
    label: HEALTH_LABELS[health],
    tone: healthTone(health),
    count: counts[health] ?? 0,
  })).filter((entry) => entry.count > 0)

  return (
    <ul className="-mx-2 divide-y divide-border">
      {entries.map(({ health, label, tone, count }) => (
        <li
          key={health}
          className="flex items-center gap-2 px-2 py-2 text-sm"
        >
          <Dot tone={tone} />
          <span className="font-medium">{label}</span>
          <span className="text-muted-foreground ml-auto text-xs">
            {count.toLocaleString('en-US')}
            {health === 'cooling_down' && failedJobsCount > 0 && (
              <span className="text-status-danger ml-2">+ {failedJobsCount} job</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

function EmptyChartPlaceholder({ label }: { readonly label: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="border-border bg-muted/40 flex h-32 flex-col items-center justify-center gap-1 rounded-md border border-dashed text-center"
    >
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
    </div>
  )
}

function buildChartData(events: readonly RequestEventView[]): {
  readonly volumeData: VolumePoint[]
  readonly latencyData: LatencyPoint[]
  readonly topModels: TopModelPoint[]
  readonly sparklines: SparklineBundle
} {
  const now = Date.now()
  const currentBucketStart = Math.floor(now / HOUR_MS) * HOUR_MS
  const buckets: HourBucket[] = []
  for (let i = BUCKET_HOURS - 1; i >= 0; i--) {
    buckets.push({
      date: new Date(currentBucketStart - i * HOUR_MS),
      status2xx: 0,
      status4xx: 0,
      status5xx: 0,
      latencies: [],
    })
  }

  for (const event of events) {
    const ts = new Date(event.occurredAt).getTime()
    if (Number.isNaN(ts)) continue
    const eventBucketStart = Math.floor(ts / HOUR_MS) * HOUR_MS
    const offset = Math.floor((currentBucketStart - eventBucketStart) / HOUR_MS)
    if (offset < 0 || offset >= BUCKET_HOURS) continue
    const bucket = buckets[BUCKET_HOURS - 1 - offset]
    if (!bucket) continue
    const status = event.status
    if (status >= 200 && status < 300) {
      bucket.status2xx++
    } else if (status >= 400 && status < 500) {
      bucket.status4xx++
    } else if (status >= 500) {
      bucket.status5xx++
    }
    bucket.latencies.push(event.latencyMs)
  }

  const volumeData: VolumePoint[] = buckets.map((b) => ({
    date: b.date,
    '2xx': b.status2xx,
    '4xx': b.status4xx,
    '5xx': b.status5xx,
  }))

  const latencyData: LatencyPoint[] = buckets.map((b) => ({
    date: b.date,
    p50: percentile(b.latencies, 50),
    p95: percentile(b.latencies, 95),
    p99: percentile(b.latencies, 99),
  }))

  const topModels = buildTopModels(events)

  const sparklines: SparklineBundle = {
    providers: buckets.map((b) => b.status2xx + b.status4xx + b.status5xx),
    keys: buckets.map((b) => b.status2xx),
    attention: buckets.map((b) => b.status4xx + b.status5xx),
    requests: buckets.map((b) => b.status2xx + b.status4xx + b.status5xx),
  }

  return { volumeData, latencyData, topModels, sparklines }
}

function buildTopModels(events: readonly RequestEventView[]): TopModelPoint[] {
  const counts = new Map<string, number>()
  for (const event of events) {
    counts.set(event.model, (counts.get(event.model) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([model, count]) => ({ model, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)
}

function TopModelsList({ models }: { readonly models: readonly TopModelPoint[] }) {
  const total = models.reduce((sum, row) => sum + row.count, 0) || 1
  return (
    <ul className="-my-1 flex flex-col">
      {models.map((row, index) => (
        <li
          key={row.model}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2.5 text-sm"
        >
          <span className="text-muted-foreground tabular-nums w-4 text-xs">{index + 1}</span>
          <span className="text-foreground truncate font-mono text-xs">{row.model}</span>
          <span className="text-muted-foreground tabular-nums text-xs">
            <span className="text-foreground font-medium">{row.count}</span> ·{' '}
            {Math.round((row.count / total) * 100)}%
          </span>
        </li>
      ))}
    </ul>
  )
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (p / 100) * (sorted.length - 1)
  const lower = Math.floor(rank)
  const upper = Math.ceil(rank)
  const lowerValue = sorted[lower] ?? 0
  const upperValue = sorted[upper] ?? 0
  if (lower === upper) return lowerValue
  return lowerValue + (upperValue - lowerValue) * (rank - lower)
}

function countByHealth(
  providers: readonly ProviderView[],
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(HEALTH_ORDER.map((key) => [key, 0]))
  for (const provider of providers) {
    for (const key of provider.keys) {
      counts[key.health] = (counts[key.health] ?? 0) + 1
    }
  }
  return counts
}

function formatTime(iso: string): string {
  return formatTimeWithUtc(iso, { dateStyle: 'short', timeStyle: 'short' })
}