import { useCallback, useEffect, useState } from 'react'
import { ClipboardList, SearchX } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { StatefulButton } from '@/components/ui/stateful-button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/empty-state'
import { Dot } from '@/components/dot'
import { ApiError } from '@/lib/api-client'
import { clearAudit, fetchAudit, type AuditEventView, type AuditFilter } from '@/lib/audit'
import { formatTime } from '@/lib/time'

const PAGE_SIZE = 25

/**
 * The Audit area. Lists every administrative change retained by Iroha, with
 * pagination, action-prefix filtering, and an explicit clear action. The
 * clear is itself audited.
 */
export function AuditArea({ csrfToken }: { readonly csrfToken: string }) {
  const [list, setList] = useState<{
    events: readonly AuditEventView[]
    total: number
  } | null>(null)
  const [filter, setFilter] = useState<AuditFilter>({})
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<ApiError | null>(null)

  const reload = useCallback(
    async (currentFilter: AuditFilter, currentOffset: number) => {
      try {
        const page = await fetchAudit(currentFilter, { limit: PAGE_SIZE, offset: currentOffset })
        setList({ events: page.events, total: page.total })
        setError(null)
      } catch (cause) {
        setError(cause instanceof ApiError ? cause : new ApiError('request_failed', 'Load failed.'))
      }
    },
    [],
  )

  useEffect(() => {
    void reload(filter, 0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const applyFilter = (next: AuditFilter) => {
    setFilter(next)
    setOffset(0)
    void reload(next, 0)
  }

  const doClear = async () => {
    await clearAudit(csrfToken)
    await reload(filter, 0)
    setOffset(0)
  }

  const total = list?.total ?? null

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Audit</h1>
        <div className="flex items-center gap-2">
          {total !== null && (
            <span className="text-muted-foreground text-xs">
              {total.toLocaleString('en-US')} total
            </span>
          )}
          <StatefulButton
            variant="outline"
            size="sm"
            disabled={list === null || list.total === 0}
            successLabel="Cleared"
            onClick={async () => {
              try {
                await doClear()
              } catch (cause) {
                setError(
                  cause instanceof ApiError
                    ? cause
                    : new ApiError('request_failed', 'Could not clear the audit feed.'),
                )
                throw cause
              }
            }}
          >
            Clear feed
          </StatefulButton>
        </div>
      </header>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>Audit feed unavailable</AlertTitle>
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      )}

      <AuditFilterBar filter={filter} onChange={applyFilter} />

      {list === null ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : list.events.length === 0 ? (
        filter.actionPrefix !== undefined || filter.outcome !== undefined ? (
          <EmptyState
            icon={SearchX}
            title="No audit events match this filter"
            description="Widen the filter or clear it to see the full audit trail."
            compact
          />
        ) : (
          <EmptyState
            icon={ClipboardList}
            title="No audit events yet"
            description="Owner actions and management events will appear here."
            compact
          />
        )
      ) : (
        <AuditList
          events={list.events}
          total={list.total}
          offset={offset}
          onPage={(next) => {
            setOffset(next)
            void reload(filter, next)
          }}
        />
      )}
    </div>
  )
}

function AuditFilterBar({
  filter,
  onChange,
}: {
  readonly filter: AuditFilter
  readonly onChange: (next: AuditFilter) => void
}) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-action" className="text-muted-foreground text-xs">
          Action starts with
        </label>
        <Input
          id="audit-action"
          value={filter.actionPrefix ?? ''}
          onChange={(event) =>
            onChange({
              ...filter,
              ...(event.target.value === ''
                ? { actionPrefix: undefined }
                : { actionPrefix: event.target.value }),
            })
          }
          placeholder="provider, gateway_key, audit, settings…"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="audit-outcome" className="text-muted-foreground text-xs">
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
          <SelectTrigger id="audit-outcome" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__any">Any outcome</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="failure">Failure</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}

function AuditList({
  events,
  total,
  offset,
  onPage,
}: {
  readonly events: readonly AuditEventView[]
  readonly total: number
  readonly offset: number
  readonly onPage: (next: number) => void
}) {
  const hasPrev = offset > 0
  const hasNext = offset + events.length < total

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {events.map((event) => (
          <AuditRow key={event.id} event={event} />
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

function AuditRow({ event }: { readonly event: AuditEventView }) {
  const tone = event.outcome === 'success' ? 'healthy' : 'danger'
  return (
    <li>
      <div className="bg-card hover:bg-muted/40 flex items-center gap-3 rounded-lg border px-4 py-3 transition-colors">
        <Dot tone={tone} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-sm">{event.action}</span>
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <span className="font-mono truncate">{summariseDetail(event.detail)}</span>
            <span>·</span>
            <span className="shrink-0">{formatTime(event.occurredAt)}</span>
          </div>
        </div>
      </div>
    </li>
  )
}

function summariseDetail(detail: unknown): string {
  if (detail === null || detail === undefined) return '—'
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return '—'
  }
}