import { useCallback, useEffect, useState } from 'react'
import { Activity, SearchX } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/empty-state'
import { Dot } from '@/components/dot'
import {
  fetchProviders,
  type ProviderView,
} from '@/lib/providers'
import {
  fetchRequestDetail,
  fetchRequests,
  RequestHistoryError,
  type RequestAttemptView,
  type RequestEventDetail,
  type RequestEventView,
  type RequestFilter,
} from '@/lib/requests'
import { formatTime } from '@/lib/time'

const PAGE_SIZE = 25

/**
 * The Requests area. Shows recent inference metadata, paginates, and lets the
 * Owner filter by provider, outcome, model, or key. Nothing here surfaces
 * prompts, responses, or Upstream Key material.
 */
export function RequestsArea({ onSignedOut }: { readonly onSignedOut: () => void }) {
  const [list, setList] = useState<{
    events: readonly RequestEventView[]
    total: number
  } | null>(null)
  const [providers, setProviders] = useState<readonly ProviderView[] | null>(null)
  const [error, setError] = useState<RequestHistoryError | null>(null)
  const [filter, setFilter] = useState<RequestFilter>({})
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<RequestEventDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null)

  const reload = useCallback(
    async (currentFilter: RequestFilter, currentOffset: number) => {
      try {
        const [page, list] = await Promise.all([
          fetchRequests(currentFilter, { limit: PAGE_SIZE, offset: currentOffset }),
          providers === null ? fetchProviders() : Promise.resolve(providers),
        ])
        setList({ events: page.events, total: page.total })
        if (providers === null) setProviders(list)
        setError(null)
      } catch (cause) {
        if (cause instanceof RequestHistoryError && cause.code === 'authentication_required') {
          onSignedOut()
          return
        }
        setError(
          cause instanceof RequestHistoryError
            ? cause
            : new RequestHistoryError('request_failed', 'Request history could not be loaded.'),
        )
      }
    },
    [providers, onSignedOut],
  )

  useEffect(() => {
    void reload(filter, 0)
    setOffset(0)
    // We intentionally omit `reload` and `filter` so this only fires once;
    // user-initiated filter changes call `reload` explicitly below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyFilter = (next: RequestFilter) => {
    setFilter(next)
    setSelected(null)
    void reload(next, 0)
  }

  const open = async (id: string) => {
    setLoadingDetail(id)
    try {
      setSelected(await fetchRequestDetail(id))
      setError(null)
    } catch (cause) {
      setError(
        cause instanceof RequestHistoryError
          ? cause
          : new RequestHistoryError('request_failed', 'Could not load that request.'),
      )
    } finally {
      setLoadingDetail(null)
    }
  }

  const total = list?.total ?? null

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Requests</h1>
        {total !== null && (
          <span className="text-muted-foreground text-xs">
            {total.toLocaleString('en-US')} total
          </span>
        )}
      </header>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Request history unavailable</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <RequestsFilterBar
        providers={providers}
        filter={filter}
        onChange={applyFilter}
      />

      {list === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : list.events.length === 0 ? (
        hasFilter(filter) ? (
          <EmptyState
            icon={SearchX}
            title="No requests match this filter"
            description="Loosen the filter or clear it to see more inference activity."
            compact
          />
        ) : (
          <EmptyState
            icon={Activity}
            title="No requests recorded yet"
            description="Inference calls against the Gateway will surface here as they happen."
            compact
          />
        )
      ) : (
        <RequestsList
          events={list.events}
          total={list.total}
          offset={offset}
          loadingId={loadingDetail}
          onPage={(next) => {
            setOffset(next)
            void reload(filter, next)
          }}
          onOpen={open}
        />
      )}

      <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        {selected && <RequestDetail detail={selected} />}
      </Dialog>
    </div>
  )
}

function RequestsFilterBar({
  providers,
  filter,
  onChange,
}: {
  readonly providers: readonly ProviderView[] | null
  readonly filter: RequestFilter
  readonly onChange: (next: RequestFilter) => void
}) {
  return (
    <div className="grid gap-3 md:grid-cols-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="requests-provider" className="text-muted-foreground text-xs">
          Provider
        </label>
        <Select
          value={filter.providerId ?? '__any'}
          onValueChange={(value) =>
            onChange({
              ...filter,
              ...(value === '__any'
                ? { providerId: undefined }
                : { providerId: value }),
            })
          }
        >
          <SelectTrigger id="requests-provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">Any provider</SelectItem>
            {(providers ?? []).map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="requests-outcome" className="text-muted-foreground text-xs">
          Outcome
        </label>
        <Select
          value={filter.outcome ?? '__any'}
          onValueChange={(value) =>
            onChange({
              ...filter,
              ...(value === '__any'
                ? { outcome: undefined }
                : { outcome: value as 'success' | 'failure' }),
            })
          }
        >
          <SelectTrigger id="requests-outcome" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">Any outcome</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="failure">Failure</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="requests-model" className="text-muted-foreground text-xs">
          Model
        </label>
        <Input
          id="requests-model"
          value={filter.model ?? ''}
          onChange={(event) =>
            onChange({
              ...filter,
              ...(event.target.value === '' ? { model: undefined } : { model: event.target.value }),
            })
          }
          placeholder="Exact model ID"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="requests-key" className="text-muted-foreground text-xs">
          Key
        </label>
        <Input
          id="requests-key"
          value={filter.keyId ?? ''}
          onChange={(event) =>
            onChange({
              ...filter,
              ...(event.target.value === '' ? { keyId: undefined } : { keyId: event.target.value }),
            })
          }
          placeholder="Upstream Key id"
        />
      </div>
    </div>
  )
}

function RequestsList({
  events,
  total,
  offset,
  loadingId,
  onPage,
  onOpen,
}: {
  readonly events: readonly RequestEventView[]
  readonly total: number
  readonly offset: number
  readonly loadingId: string | null
  readonly onPage: (next: number) => void
  readonly onOpen: (id: string) => Promise<void> | void
}) {
  const hasPrev = offset > 0
  const hasNext = offset + events.length < total

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {events.map((event) => (
          <RequestRow
            key={event.id}
            event={event}
            busy={loadingId === event.id}
            onOpen={() => void onOpen(event.id)}
          />
        ))}
      </ul>
      <div className="text-muted-foreground flex items-center justify-between px-1 py-1 text-xs">
        <span>
          {offset + 1}–{offset + events.length} of {total}
        </span>
        <span className="flex items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={!hasPrev}
            onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={!hasNext}
            onClick={() => onPage(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </span>
      </div>
    </div>
  )
}

function RequestRow({
  event,
  busy,
  onOpen,
}: {
  readonly event: RequestEventView
  readonly busy: boolean
  readonly onOpen: () => void
}) {
  const tone = event.outcome === 'success' ? 'healthy' : 'danger'
  return (
    <li>
      <div
        role="button"
        tabIndex={busy ? -1 : 0}
        aria-label={`Open request ${event.model}`}
        aria-disabled={busy}
        onClick={() => {
          if (!busy) onOpen()
        }}
        onKeyDown={(event) => {
          if (busy) return
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen()
          }
        }}
        className="bg-card hover:bg-muted/40 flex cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 transition-colors aria-disabled:cursor-not-allowed aria-disabled:hover:bg-card aria-disabled:opacity-70"
      >
        <Dot tone={tone} />
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-sm">{event.model}</span>
              <span className="text-muted-foreground font-mono text-xs">
                · {event.providerId}
              </span>
            </div>
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span className="font-mono tabular-nums">{event.latencyMs} ms</span>
              <span>·</span>
              <span className="font-mono">Key {event.keyId ?? '—'}</span>
              <span>·</span>
              <span className="truncate">{formatTime(event.occurredAt)}</span>
              {event.errorCode !== null && (
                <>
                  <span>·</span>
                  <span className="text-status-danger truncate">{event.errorCode}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <span
          className="text-muted-foreground font-mono tabular-nums shrink-0 text-xs"
          title={`HTTP ${event.status}`}
        >
          {event.status}
        </span>
      </div>
    </li>
  )
}

function RequestDetail({ detail }: { readonly detail: RequestEventDetail }) {
  const { event, attempts } = detail

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Request</DialogTitle>
        <DialogDescription className="font-mono text-xs">
          {event.id}
        </DialogDescription>
      </DialogHeader>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <Detail label="Time">{formatTime(event.occurredAt)}</Detail>
        <Detail label="Provider">{event.providerId}</Detail>
        <Detail label="Model">{event.model}</Detail>
        {detail.recovered && (
          <Detail label="Recovery">
            Recovered after {detail.attemptCount - 1} failed attempt{detail.attemptCount === 2 ? '' : 's'}
          </Detail>
        )}
        <Detail label="Status">
          {event.status} ({event.outcome}
          {event.errorCode === null ? '' : ` · ${event.errorCode}`})
        </Detail>
        <Detail label="Latency">{event.latencyMs} ms</Detail>
        <Detail label="Streaming">{event.isStreaming ? 'Yes' : 'No'}</Detail>
        <Detail label="Prompt tokens">{event.promptTokens ?? '—'}</Detail>
        <Detail label="Completion tokens">{event.completionTokens ?? '—'}</Detail>
        <Detail label="Total tokens">{event.totalTokens ?? '—'}</Detail>
        <Detail label="Upstream Key">{event.keyId ?? '—'}</Detail>
      </dl>

      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-xs">Attempts</span>
        <ol className="flex flex-col gap-1 text-xs">
          {attempts.map((attempt) => (
            <AttemptLine key={attempt.id} attempt={attempt} totalAttempts={attempts.length} />
          ))}
        </ol>
      </div>
    </DialogContent>
  )
}

function AttemptLine({ attempt, totalAttempts }: {
  readonly attempt: RequestAttemptView
  readonly totalAttempts: number
}) {
  const tone =
    attempt.outcome === 'success'
      ? 'text-status-healthy'
      : attempt.outcome === 'skipped'
        ? 'text-muted-foreground'
        : 'text-status-danger'

  return (
    <li className="bg-muted/40 flex min-w-0 flex-col gap-2 rounded-md px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono">#{attempt.attemptNumber}</span>
        {attempt.attemptNumber > 1 && <span className="text-muted-foreground">Alternate</span>}
        <span className={tone}>{attempt.outcome}</span>
        {attempt.status !== null && <span className="font-mono">HTTP {attempt.status}</span>}
        {attempt.errorCode !== null && (
          <span className="text-muted-foreground break-all">{attempt.errorCode}</span>
        )}
        <span className="text-muted-foreground ml-auto break-all font-mono text-[10px]">
          {attempt.keyId ?? '—'}
        </span>
      </div>
      <AttemptDiagnostics attempt={attempt} totalAttempts={totalAttempts} />
    </li>
  )
}

function AttemptDiagnostics({ attempt, totalAttempts }: {
  readonly attempt: RequestAttemptView
  readonly totalAttempts: number
}) {
  const diagnostics = attempt.diagnostics
  const facts = [
    diagnostics.providerCode === undefined ? null : ['Provider code', diagnostics.providerCode],
    diagnostics.providerType === undefined ? null : ['Provider type', diagnostics.providerType],
    diagnostics.classification === undefined ? null : ['Classification', diagnostics.classification],
    diagnostics.capacityScope === undefined ? null : ['Capacity scope', diagnostics.capacityScope],
    diagnostics.limitingWindow === undefined ? null : ['Limiting window', diagnostics.limitingWindow.replaceAll('_', ' ')],
    diagnostics.remaining === undefined ? null : ['Remaining', String(diagnostics.remaining)],
    diagnostics.remainingPercent === undefined ? null : ['Remaining', `${diagnostics.remainingPercent}%`],
    diagnostics.evidenceAuthority === undefined ? null : ['Evidence', diagnostics.evidenceAuthority],
    diagnostics.evidenceObservedAt === undefined ? null : ['Evidence observed', formatTime(diagnostics.evidenceObservedAt)],
    diagnostics.evidenceFreshUntil === undefined ? null : ['Evidence fresh until', formatTime(diagnostics.evidenceFreshUntil)],
  ].filter((fact): fact is [string, string] => fact !== null)
  const retrySeconds = diagnostics.retryAfterSeconds ?? attempt.retryAfterSeconds
  const retryTime = diagnostics.retryAt ?? diagnostics.recheckAt

  if (facts.length === 0 && retrySeconds === null && retryTime === undefined && totalAttempts < 2) {
    return null
  }

  return (
    <dl className="grid min-w-0 gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
      {facts.map(([label, value]) => (
        <div key={`${label}-${value}`} className="flex min-w-0 gap-1.5">
          <dt className="text-muted-foreground shrink-0">{label}</dt>
          <dd className="min-w-0 break-all font-mono">{value}</dd>
        </div>
      ))}
      {retrySeconds !== null && (
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Retry after</dt>
          <dd className="font-mono">{retrySeconds}s</dd>
        </div>
      )}
      {retryTime !== undefined && (
        <div className="flex min-w-0 gap-1.5">
          <dt className="text-muted-foreground shrink-0">{diagnostics.recheckAt === retryTime ? 'Recheck' : 'Retry'}</dt>
          <dd className="min-w-0 truncate" title={retryTime}>{formatTime(retryTime)}</dd>
        </div>
      )}
      {totalAttempts > 1 && (
        <div className="flex gap-1.5">
          <dt className="text-muted-foreground">Trail</dt>
          <dd>{attempt.attemptNumber} of {totalAttempts}</dd>
        </div>
      )}
    </dl>
  )
}

function Detail({
  label,
  children,
}: {
  readonly label: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-[10px] tracking-wide uppercase">{label}</dt>
      <dd className="font-mono text-xs">{children}</dd>
    </div>
  )
}

function hasFilter(filter: RequestFilter): boolean {
  return (
    (filter.providerId !== undefined && filter.providerId !== '') ||
    filter.outcome !== undefined ||
    (filter.model !== undefined && filter.model !== '') ||
    (filter.keyId !== undefined && filter.keyId !== '')
  )
}
