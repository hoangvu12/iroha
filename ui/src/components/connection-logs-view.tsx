import { useCallback, useEffect, useState } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { Separator } from '@/components/ui/separator'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  fetchRequests,
  RequestHistoryError,
  type RequestEventView,
} from '@/lib/requests'
import { fetchUsage, type UsageView } from '@/lib/usage'
import { fetchCatalog, type CatalogView } from '@/lib/catalog'
import { fetchBackgroundJobs, type BackgroundJobView } from '@/lib/background'
import { BarChart } from '@/components/bar-chart'

interface ConnectionLogsViewProps {
  readonly connectionId: string
}

/**
 * One Provider Connection's Logs tab: a quiet summary of the inference calls
 * served on this connection, the related background jobs, and the recent
 * failures so the Owner can see whether the connection itself is misbehaving.
 */
export function ConnectionLogsView({ connectionId }: ConnectionLogsViewProps) {
  const [events, setEvents] = useState<readonly RequestEventView[] | null>(null)
  const [usage, setUsage] = useState<UsageView | null>(null)
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [jobs, setJobs] = useState<readonly BackgroundJobView[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [page, usageView, catalogView, jobList] = await Promise.all([
        fetchRequests({ connectionId }, { limit: 100 }),
        fetchUsage(connectionId).catch(() => null),
        fetchCatalog(connectionId).catch(() => null),
        fetchBackgroundJobs(),
      ])
      setEvents(page.events)
      setUsage(usageView)
      setCatalog(catalogView)
      setJobs(jobList)
      setError(null)
    } catch (cause) {
      setError(
        cause instanceof RequestHistoryError
          ? cause.message
          : 'Logs could not be loaded. Try refreshing.',
      )
    }
  }, [connectionId])

  useEffect(() => {
    void reload()
  }, [reload])

  if (events === null && error === null) {
    return <Skeleton className="h-32 w-full" />
  }

  if (error !== null && events === null) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Logs unavailable</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    )
  }

  const list = events ?? []
  const failures = list.filter((event) => event.outcome === 'failure')
  const hourly = bucketByHour(list)
  const relatedJobs = (jobs ?? []).filter((job) =>
    ['model_sync', 'usage_poll', 'cooldown_recovery'].includes(job.jobId),
  )

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-base font-semibold tracking-tight">Request volume</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Calls served on this connection over the most recent log window. The last hour
          is highlighted.
        </p>

        <Separator className="my-4" />

        <div className="bg-card rounded-lg border p-4">
          <BarChart
            values={hourly}
            height={80}
            ariaLabel={`Request volume by hour, ${hourly.length} buckets`}
          />
          <p className="text-muted-foreground mt-3 text-xs">
            {list.length} request{list.length === 1 ? '' : 's'} captured, {failures.length}{' '}
            failure{failures.length === 1 ? '' : 's'}.
          </p>
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold tracking-tight">Recent failures</h2>
        <Separator className="my-4" />
        {failures.length === 0 ? (
          <p className="text-muted-foreground text-sm">No failures recorded on this connection.</p>
        ) : (
          <ul className="divide-border divide-y rounded-md border">
            {failures.slice(0, 10).map((event) => (
              <li key={event.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs">{event.model}</span>
                  <span className="text-status-danger text-xs">
                    {event.errorCode ?? `HTTP ${event.status}`}
                  </span>
                  <span className="text-muted-foreground ml-auto text-xs">
                    {formatTime(event.occurredAt)}
                  </span>
                </div>
                <p className="text-muted-foreground font-mono text-[10px] break-all">
                  Key {event.keyId ?? '—'} · {event.latencyMs} ms
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-base font-semibold tracking-tight">Background jobs</h2>
        <Separator className="my-4" />
        <div className="bg-card rounded-lg border p-4 text-sm">
          <dl className="grid gap-x-8 gap-y-3">
            {relatedJobs.map((job) => (
              <div key={job.jobId} className="flex flex-col gap-0.5">
                <dt className="text-muted-foreground text-xs tracking-wide uppercase">
                  {job.label}
                </dt>
                <dd>
                  <span className="font-medium">{job.status}</span>
                  {job.lastCompletedAt === null
                    ? ' · never run'
                    : ` · last run ${formatTime(job.lastCompletedAt)}`}
                  {job.lastErrorMessage === null
                    ? ''
                    : ` · ${job.lastErrorCode ?? ''} ${job.lastErrorMessage}`}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {usage !== null && (
        <section>
          <h2 className="text-base font-semibold tracking-tight">Usage Adapter</h2>
          <Separator className="my-4" />
          <div className="bg-card rounded-lg border p-4 text-sm">
            <p>
              Visibility: {usage.visibility === 'authoritative' ? 'Authoritative' : 'Reactive only'}.
              {usage.reading === null
                ? ' No reading yet.'
                : ` Reading ${usage.reading.balance === null ? 'unknown' : usage.reading.balance} ${usage.reading.unit}.`}
            </p>
          </div>
        </section>
      )}

      {catalog !== null && (
        <section>
          <h2 className="text-base font-semibold tracking-tight">Catalog freshness</h2>
          <Separator className="my-4" />
          <div className="bg-card rounded-lg border p-4 text-sm">
            <p>
              {catalog.sync.lastSuccessAt === null
                ? 'Never synchronised.'
                : `Last successful synchronisation ${formatTime(catalog.sync.lastSuccessAt)}.`}
              {catalog.sync.stale && ' Catalog is stale.'}
            </p>
          </div>
        </section>
      )}
    </div>
  )
}

function bucketByHour(events: readonly RequestEventView[]): number[] {
  if (events.length === 0) return []
  const now = Date.now()
  const buckets = new Array<number>(12).fill(0)
  const hourMs = 60 * 60 * 1000
  for (const event of events) {
    const ts = new Date(event.occurredAt).getTime()
    if (Number.isNaN(ts)) continue
    const offset = Math.floor((now - ts) / hourMs)
    if (offset >= 0 && offset < buckets.length) {
      buckets[buckets.length - 1 - offset] = (buckets[buckets.length - 1 - offset] ?? 0) + 1
    }
  }
  return buckets
}

/** Stored in UTC, shown in the reader's own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'
  return at.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })
}