import { useCallback, useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { BarChart } from '@/components/bar-chart'
import { HealthDistribution } from '@/components/health-distribution'
import { KeyHealthBadge, HEALTH_LABELS, HEALTH_ORDER, keyNeedsAttention } from '@/components/key-health'
import { fetchBackgroundJobs, type BackgroundJobView } from '@/lib/background'
import { fetchConnections, activateKey, disableKey, testKey, type ConnectionView } from '@/lib/providers'
import { fetchRequests, type RequestEventView } from '@/lib/requests'
import { fetchRetention, type RetentionView } from '@/lib/settings'
import type { Readiness } from '@/lib/health'
import type { AuthState } from '@/lib/auth'
import { formatTime as formatTimeWithUtc } from '@/lib/time'

interface OverviewProps {
  readonly auth: AuthState
  readonly readiness: Readiness | null
  readonly csrfToken: string
}

/**
 * The exception-first Overview. Leads with attention rows, then quiet inline
 * summaries, then one volume trend and one health distribution, then recent
 * failures. No grid of summary cards.
 */
export function Overview({ auth, readiness, csrfToken }: OverviewProps) {
  const [connections, setConnections] = useState<readonly ConnectionView[] | null>(null)
  const [jobs, setJobs] = useState<readonly BackgroundJobView[] | null>(null)
  const [requests, setRequests] = useState<readonly RequestEventView[] | null>(null)
  const [retention, setRetention] = useState<RetentionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const [conns, jobList, page, ret] = await Promise.all([
        fetchConnections(),
        fetchBackgroundJobs(),
        fetchRequests({}, { limit: 100 }),
        fetchRetention().catch(() => null),
      ])
      setConnections(conns)
      setJobs(jobList)
      setRequests(page.events)
      if (ret !== null) setRetention(ret)
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Overview could not be loaded.')
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const run = async (label: string, perform: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await perform()
      await reload()
    } finally {
      setBusy(null)
    }
  }

  const attention = (connections ?? [])
    .filter((c) => !c.archived)
    .flatMap((connection) =>
      connection.keys
        .filter(keyNeedsAttention)
        .map((key) => ({ connection, key })),
    )

  const jobsList = jobs ?? []
  const failedJobs = jobsList.filter(
    (job) => job.lastOutcome === 'failure' || job.status === 'failed',
  )

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="text-base font-semibold tracking-tight">Runtime</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Iroha validated its configuration, applied every pending migration, and bound its
          port before accepting this request.
        </p>
        <Separator className="my-4" />

        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Overview unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 md:grid-cols-4">
          <Fact label="Readiness">
            {readiness === null ? <Skeleton className="h-4 w-24" /> : readinessText(readiness)}
          </Fact>
          <Fact label="Database engine">
            {readiness === null ? (
              <Skeleton className="h-4 w-20" />
            ) : readiness.state === 'ready' ? (
              readiness.dialect === 'sqlite' ? 'SQLite' : 'PostgreSQL'
            ) : (
              'Unknown'
            )}
          </Fact>
          <Fact label="Owner">{auth.owner?.username ?? '—'}</Fact>
          <Fact label="Recovery">
            {auth.recoveryEnabled ? 'Token configured' : 'Not configured'}
          </Fact>
        </dl>
      </section>

      <section>
        <h2 className="text-base font-semibold tracking-tight">Attention required</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Upstream Keys whose health is not Active and not Disabled by Owner choice. Test,
          activate, or disable them inline.
        </p>
        <Separator className="my-4" />

        {connections === null ? (
          <Skeleton className="h-24 w-full" />
        ) : attention.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing needs attention. All keys are Active or Disabled by Owner choice.
          </p>
        ) : (
          <ul className="divide-border divide-y rounded-md border">
            {attention.slice(0, 8).map(({ connection, key }) => (
              <li
                key={`${connection.id}-${key.id}`}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <KeyHealthBadge health={key.health} />
                  <span className="font-medium">{connection.displayName}</span>
                  <span className="text-muted-foreground font-mono text-xs">{key.id}</span>
                  {key.healthReason !== null && (
                    <span className="text-muted-foreground text-xs">{key.healthReason}</span>
                  )}
                  {key.retryAfterAt !== null && (
                    <span className="text-muted-foreground text-xs">
                      retry eligible {formatTime(key.retryAfterAt)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void run(`test-${key.id}`, () => testKey(connection.id, key.id, csrfToken))}
                    disabled={busy !== null}
                  >
                    {busy === `test-${key.id}` ? 'Testing…' : 'Test'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void run(`activate-${key.id}`, () => activateKey(connection.id, key.id, csrfToken))}
                    disabled={busy !== null}
                  >
                    {busy === `activate-${key.id}` ? 'Activating…' : 'Activate'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={() => void run(`disable-${key.id}`, () => disableKey(connection.id, key.id, csrfToken))}
                    disabled={busy !== null}
                  >
                    {busy === `disable-${key.id}` ? 'Disabling…' : 'Disable'}
                  </Button>
                </div>
              </li>
            ))}
            {attention.length > 8 && (
              <li className="text-muted-foreground px-3 py-2 text-xs">
                + {attention.length - 8} more — visit the Provider area to act on them.
              </li>
            )}
          </ul>
        )}
      </section>

      {failedJobs.length > 0 && (
        <section>
          <h2 className="text-base font-semibold tracking-tight">Background jobs that failed</h2>
          <Separator className="my-4" />
          <ul className="divide-border divide-y rounded-md border">
            {failedJobs.map((job) => (
              <li
                key={job.jobId}
                className="text-muted-foreground flex flex-col gap-1 px-3 py-2 text-sm"
              >
                <span className="text-foreground font-medium">{job.label}</span>
                <span className="text-xs">
                  {job.lastErrorCode ?? ''} {job.lastErrorMessage ?? ''}
                  {job.lastCompletedAt === null ? '' : ` · last ${formatTime(job.lastCompletedAt)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="text-base font-semibold tracking-tight">Volume</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          One quiet request-volume trend, grouped by hour. The most recent bucket is
          highlighted.
        </p>
        <Separator className="my-4" />
        <div className="bg-card rounded-lg border p-4">
          {requests === null ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <BarChart
              values={bucketByHour(requests)}
              height={64}
              ariaLabel={`Request volume by hour, ${requests.length} requests captured`}
            />
          )}
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold tracking-tight">Key Health</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          One distribution across every Provider Connection.
        </p>
        <Separator className="my-4" />
        <div className="bg-card rounded-lg border p-4">
          {connections === null ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <HealthDistribution
              counts={countByHealth(connections)}
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
          )}
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold tracking-tight">Recent failures</h2>
        <p className="text-muted-foreground mt-1 text-sm">
          The last ten failures Iroha recorded. Prompts and responses are never stored.
        </p>
        <Separator className="my-4" />
        {requests === null ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <RecentFailures events={requests} />
        )}
      </section>

      {retention !== null && (
        <section>
          <h2 className="text-base font-semibold tracking-tight">Settings</h2>
          <Separator className="my-4" />
          <p className="text-muted-foreground text-sm">
            Request-history retention is {retention.enabled ? `${retention.days} days` : 'disabled'}.
            Adjust it in the Settings area.
          </p>
        </section>
      )}
    </div>
  )
}

function RecentFailures({ events }: { readonly events: readonly RequestEventView[] }) {
  const failures = events.filter((event) => event.outcome === 'failure').slice(0, 10)
  if (failures.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No failures in the recent request window.
      </p>
    )
  }
  return (
    <ul className="divide-border divide-y rounded-md border">
      {failures.map((event) => (
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
            Connection {event.connectionId} · Key {event.keyId ?? '—'} · {event.latencyMs} ms
          </p>
        </li>
      ))}
    </ul>
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

function countByHealth(
  connections: readonly ConnectionView[],
): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(HEALTH_ORDER.map((key) => [key, 0]))
  for (const connection of connections) {
    for (const key of connection.keys) {
      counts[key.health] = (counts[key.health] ?? 0) + 1
    }
  }
  return counts
}

function readinessText(readiness: Readiness): string {
  switch (readiness.state) {
    case 'ready':
      return 'Accepting traffic'
    case 'not_ready':
      return `Not accepting traffic (${readiness.reason.replace(/_/g, ' ')})`
    case 'unreachable':
      return 'Gateway did not answer'
  }
}

function Fact({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-muted-foreground text-xs tracking-wide uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  )
}

function formatTime(iso: string): string {
  return formatTimeWithUtc(iso, { dateStyle: 'short', timeStyle: 'short' })
}