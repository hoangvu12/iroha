import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { fetchUsage, refreshUsage, UsageError, type UsageView } from '@/lib/usage'

interface ConnectionUsageViewProps {
  readonly connectionId: string
  readonly csrfToken: string
}

/**
 * One Provider Connection's Usage Adapter reading: visibility, last successful
 * reading, freshness, the latest polling failure, and a manual Refresh action.
 */
export function ConnectionUsageView({ connectionId, csrfToken }: ConnectionUsageViewProps) {
  const [usage, setUsage] = useState<UsageView | null>(null)
  const [error, setError] = useState<UsageError | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetchUsage(connectionId)
      .then((value) => {
        if (!cancelled) setUsage(value)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(
          cause instanceof UsageError
            ? cause
            : new UsageError('request_failed', 'Usage data could not be loaded.'),
        )
      })
    return () => {
      cancelled = true
    }
  }, [connectionId])

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      setUsage(await refreshUsage(connectionId, csrfToken))
    } catch (cause) {
      setError(
        cause instanceof UsageError
          ? cause
          : new UsageError('request_failed', 'Usage refresh could not be completed.'),
      )
    } finally {
      setRefreshing(false)
    }
  }

  if (usage === null && error === null) {
    return <Skeleton className="h-24 w-full" />
  }

  if (error !== null && usage === null) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Usage unavailable</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  if (usage === null) return null

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Usage</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Authoritative remaining balance comes from the Provider-specific Usage Adapter
              when one is configured. Generic connections report reactive-only with no
              authoritative balance.
            </p>
          </div>
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

        <Separator className="my-4" />

        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Usage refresh failed</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        <div className="bg-card rounded-lg border p-4">
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <Row label="Visibility">
              {usage.visibility === 'authoritative' ? 'Authoritative' : 'Reactive only'}
            </Row>
            <Row label="Last successful poll">
              {usage.lastSuccessAt === null ? 'Never' : formatTime(usage.lastSuccessAt)}
            </Row>
            <Row label="Last failure">
              {usage.lastFailureAt === null
                ? 'None'
                : `${formatTime(usage.lastFailureAt)}${
                    usage.lastFailureCode === null ? '' : ` · ${usage.lastFailureCode}`
                  }`}
            </Row>
            <Row label="Catalog stale">
              {usage.stale ? 'Yes — last poll failed' : 'No'}
            </Row>
          </dl>
        </div>
      </section>

      <section>
        <h2 className="text-base font-semibold tracking-tight">Last reading</h2>
        <Separator className="my-4" />
        {usage.reading === null ? (
          <p className="text-muted-foreground text-sm">
            {usage.visibility === 'authoritative'
              ? 'No reading yet. The polling job will produce one on its next tick.'
              : 'No reading — this connection uses reactive-only visibility.'}
          </p>
        ) : (
          <div className="bg-card rounded-lg border p-4">
            <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <Row label="Unit">{usage.reading.unit}</Row>
              <Row label="Balance">
                {usage.reading.balance === null ? 'Unknown' : usage.reading.balance}
              </Row>
              <Row label="Used">{usage.reading.used ?? '—'}</Row>
              <Row label="Limit">{usage.reading.limit ?? '—'}</Row>
              <Row label="Reset at">
                {usage.reading.resetAt === null ? '—' : formatTime(usage.reading.resetAt)}
              </Row>
              <Row label="Scope">{describeScope(usage.reading.scope)}</Row>
              <Row label="Confidence">
                {usage.reading.confidence === 'confirmed' ? 'Confirmed' : 'Unknown'}
              </Row>
            </dl>
            {Object.keys(usage.reading.diagnostics).length > 0 && (
              <>
                <Separator className="my-3" />
                <pre className="text-muted-foreground overflow-x-auto text-[10px] font-mono break-all">
                  {JSON.stringify(usage.reading.diagnostics)}
                </pre>
              </>
            )}
          </div>
        )}
      </section>
    </div>
  )
}

function describeScope(scope: NonNullable<UsageView['reading']>['scope']): string {
  switch (scope.kind) {
    case 'key':
      return `Key ${scope.keyId ?? ''}`
    case 'account':
      return `Account ${scope.accountId ?? ''}`
    case 'connection_model':
      return `Connection · model ${scope.model ?? ''}`
    case 'provider':
      return 'Provider-wide'
    case 'unknown':
      return 'Unknown scope'
  }
}

function Row({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs tracking-wide uppercase">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/** Stored in UTC, shown in the reader's own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'
  return at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}