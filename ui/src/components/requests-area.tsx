import { useCallback, useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  fetchConnections,
  type ConnectionView,
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
import { formatTime as formatTimeWithUtc } from '@/lib/time'

const PAGE_SIZE = 25

/**
 * The Requests area. Shows recent inference metadata, paginates, and lets the
 * Owner filter by connection, outcome, model, or key. Nothing here surfaces
 * prompts, responses, or Upstream Key material.
 */
export function RequestsArea({ onSignedOut }: { readonly onSignedOut: () => void }) {
  const [list, setList] = useState<{
    events: readonly RequestEventView[]
    total: number
  } | null>(null)
  const [connections, setConnections] = useState<readonly ConnectionView[] | null>(null)
  const [error, setError] = useState<RequestHistoryError | null>(null)
  const [filter, setFilter] = useState<RequestFilter>({})
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState<RequestEventDetail | null>(null)
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null)

  const reload = useCallback(
    async (currentFilter: RequestFilter, currentOffset: number) => {
      try {
        const [page, conns] = await Promise.all([
          fetchRequests(currentFilter, { limit: PAGE_SIZE, offset: currentOffset }),
          connections === null ? fetchConnections() : Promise.resolve(connections),
        ])
        setList({ events: page.events, total: page.total })
        if (connections === null) setConnections(conns)
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
    [connections, onSignedOut],
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

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div>
          <h2 className="text-base font-semibold tracking-tight">Request history</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Recent inference metadata — the connection, model, key identity, status, and
            Provider-supplied usage. Prompts and responses are never stored.
          </p>
        </div>

        <Separator className="my-4" />

        <RequestsFilterBar
          connections={connections}
          filter={filter}
          onChange={applyFilter}
        />

        {error && (
          <Alert variant="destructive" role="alert" className="my-4">
            <AlertTitle>Request history unavailable</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {list === null ? (
          <Skeleton className="h-32 w-full" />
        ) : list.events.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">
            {hasFilter(filter)
              ? 'No requests match this filter.'
              : 'No requests recorded yet. Inference calls will appear here.'}
          </p>
        ) : (
          <RequestsTable
            events={list.events}
            total={list.total}
            offset={offset}
            onPage={(next) => {
              setOffset(next)
              void reload(filter, next)
            }}
            onOpen={open}
            loadingId={loadingDetail}
          />
        )}

        {selected && <RequestDetail detail={selected} onClose={() => setSelected(null)} />}
      </section>
    </div>
  )
}

function RequestsFilterBar({
  connections,
  filter,
  onChange,
}: {
  readonly connections: readonly ConnectionView[] | null
  readonly filter: RequestFilter
  readonly onChange: (next: RequestFilter) => void
}) {
  return (
    <div className="bg-card mb-4 grid gap-3 rounded-lg border p-3 md:grid-cols-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="requests-connection">Connection</Label>
        <select
          id="requests-connection"
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={filter.connectionId ?? ''}
          onChange={(event) =>
            onChange({
              ...filter,
              ...(event.target.value === ''
                ? { connectionId: undefined }
                : { connectionId: event.target.value }),
            })
          }
        >
          <option value="">Any connection</option>
          {(connections ?? []).map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.displayName}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="requests-outcome">Outcome</Label>
        <select
          id="requests-outcome"
          className="border-input bg-background h-9 rounded-md border px-2 text-sm"
          value={filter.outcome ?? ''}
          onChange={(event) =>
            onChange({
              ...filter,
              ...(event.target.value === ''
                ? { outcome: undefined }
                : { outcome: event.target.value as 'success' | 'failure' }),
            })
          }
        >
          <option value="">Any outcome</option>
          <option value="success">Success</option>
          <option value="failure">Failure</option>
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="requests-model">Model</Label>
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
        <Label htmlFor="requests-key">Key</Label>
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

function RequestsTable({
  events,
  total,
  offset,
  onPage,
  onOpen,
  loadingId,
}: {
  readonly events: readonly RequestEventView[]
  readonly total: number
  readonly offset: number
  readonly onPage: (next: number) => void
  readonly onOpen: (id: string) => Promise<void> | void
  readonly loadingId: string | null
}) {
  const hasPrev = offset > 0
  const hasNext = offset + events.length < total

  return (
    <div className="border-border bg-card rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs tracking-wide uppercase">
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Connection</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Latency</th>
            <th className="px-3 py-2 font-medium">Key</th>
            <th className="px-3 py-2 font-medium" aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} className="border-b last:border-b-0">
              <td className="px-3 py-2 align-top">{formatTime(event.occurredAt)}</td>
              <td className="px-3 py-2 align-top font-mono text-xs">
                {event.connectionId}
              </td>
              <td className="px-3 py-2 align-top font-mono text-xs">{event.model}</td>
              <td className="px-3 py-2 align-top">
                <StatusFor event={event} />
              </td>
              <td className="px-3 py-2 align-top tabular-nums">{event.latencyMs} ms</td>
              <td className="px-3 py-2 align-top font-mono text-xs">
                {event.keyId ?? '—'}
              </td>
              <td className="px-3 py-2 text-right align-top">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => void onOpen(event.id)}
                  disabled={loadingId === event.id}
                  aria-label={`Inspect request ${event.id}`}
                >
                  {loadingId === event.id ? '…' : 'Inspect'}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="text-muted-foreground flex items-center justify-between border-t px-3 py-2 text-xs">
        <span>
          {offset + 1}–{offset + events.length} of {total}
        </span>
        <span className="flex items-center gap-2">
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

function StatusFor({ event }: { readonly event: RequestEventView }) {
  if (event.outcome === 'success') {
    return <Badge variant="default">Success · {event.status}</Badge>
  }
  return (
    <Badge variant="destructive">
      Failure · {event.status}
      {event.errorCode === null ? '' : ` · ${event.errorCode}`}
    </Badge>
  )
}

function RequestDetail({
  detail,
  onClose,
}: {
  readonly detail: RequestEventDetail
  readonly onClose: () => void
}) {
  const { event, attempts } = detail

  return (
    <Alert role="dialog" className="mt-4">
      <AlertTitle className="flex items-center justify-between gap-2">
        <span className="truncate font-mono text-xs">Request {event.id}</span>
        <Button type="button" size="xs" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </AlertTitle>
      <AlertDescription>
        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <Detail label="Time">{formatTime(event.occurredAt)}</Detail>
          <Detail label="Connection">{event.connectionId}</Detail>
          <Detail label="Model">{event.model}</Detail>
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

        <Separator className="my-3" />

        <p className="text-muted-foreground mb-2 text-xs">
          Attempts (oldest first):
        </p>
        <ol className="space-y-1 text-xs">
          {attempts.map((attempt) => (
            <AttemptLine key={attempt.id} attempt={attempt} />
          ))}
        </ol>
      </AlertDescription>
    </Alert>
  )
}

function AttemptLine({ attempt }: { readonly attempt: RequestAttemptView }) {
  const tone =
    attempt.outcome === 'success'
      ? 'text-status-healthy'
      : attempt.outcome === 'skipped'
        ? 'text-muted-foreground'
        : 'text-status-danger'

  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span className="font-mono">#{attempt.attemptNumber}</span>
      <span className={tone}>{attempt.outcome}</span>
      {attempt.status !== null && <span className="font-mono">{attempt.status}</span>}
      {attempt.errorCode !== null && (
        <span className="text-muted-foreground">{attempt.errorCode}</span>
      )}
      {attempt.retryAfterSeconds !== null && (
        <span className="text-muted-foreground">retry after {attempt.retryAfterSeconds}s</span>
      )}
      <span className="text-muted-foreground ml-auto font-mono text-[10px]">
        {attempt.keyId ?? '—'}
      </span>
    </li>
  )
}

function Detail({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-[10px] tracking-wide uppercase">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function hasFilter(filter: RequestFilter): boolean {
  return (
    (filter.connectionId !== undefined && filter.connectionId !== '') ||
    filter.outcome !== undefined ||
    (filter.model !== undefined && filter.model !== '') ||
    (filter.keyId !== undefined && filter.keyId !== '')
  )
}

function formatTime(iso: string): string {
  return formatTimeWithUtc(iso, { dateStyle: 'short', timeStyle: 'medium' })
}