import { useCallback, useEffect, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  AuditError,
  clearAudit,
  fetchAudit,
  type AuditEventView,
  type AuditFilter,
} from '@/lib/audit'

const PAGE_SIZE = 25

/**
 * The Audit area. Lists every administrative change retained by Iroha, with
 * pagination, action-prefix filtering, and an explicit clear action. The
 * clear is itself audited.
 */
export function AuditArea({
  csrfToken,
  onSignedOut,
}: {
  readonly csrfToken: string
  readonly onSignedOut: () => void
}) {
  const [list, setList] = useState<{
    events: readonly AuditEventView[]
    total: number
  } | null>(null)
  const [filter, setFilter] = useState<AuditFilter>({})
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<AuditError | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(
    async (currentFilter: AuditFilter, currentOffset: number) => {
      try {
        const page = await fetchAudit(currentFilter, { limit: PAGE_SIZE, offset: currentOffset })
        setList({ events: page.events, total: page.total })
        setError(null)
      } catch (cause) {
        if (cause instanceof AuditError && cause.code === 'authentication_required') {
          onSignedOut()
          return
        }
        setError(
          cause instanceof AuditError ? cause : new AuditError('request_failed', 'Load failed.'),
        )
      }
    },
    [onSignedOut],
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
    setBusy(true)
    setError(null)
    try {
      await clearAudit(csrfToken)
      await reload(filter, 0)
      setOffset(0)
    } catch (cause) {
      setError(
        cause instanceof AuditError
          ? cause
          : new AuditError('request_failed', 'Could not clear the audit feed.'),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Audit history</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              Every administrative change is recorded here. The Owner clears the feed
              explicitly; clearings are themselves audited.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void doClear()}
            disabled={busy || list === null || list.total === 0}
          >
            {busy ? 'Clearing…' : 'Clear feed'}
          </Button>
        </div>

        <Separator className="my-4" />

        <div className="bg-card mb-4 grid gap-3 rounded-lg border p-3 md:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-action">Action starts with</Label>
            <Input
              id="audit-action"
              value={filter.actionPrefix ?? ''}
              onChange={(event) =>
                applyFilter({
                  ...filter,
                  ...(event.target.value === ''
                    ? { actionPrefix: undefined }
                    : { actionPrefix: event.target.value }),
                })
              }
              placeholder="connection, gateway_key, audit, settings…"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-outcome">Outcome</Label>
            <select
              id="audit-outcome"
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={filter.outcome ?? ''}
              onChange={(event) =>
                applyFilter({
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
        </div>

        {error && (
          <Alert variant="destructive" role="alert" className="mb-4">
            <AlertTitle>Audit feed unavailable</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {list === null ? (
          <Skeleton className="h-32 w-full" />
        ) : list.events.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">
            {filter.actionPrefix !== undefined || filter.outcome !== undefined
              ? 'No audit events match this filter.'
              : 'No audit events yet.'}
          </p>
        ) : (
          <AuditTable
            events={list.events}
            total={list.total}
            offset={offset}
            onPage={(next) => {
              setOffset(next)
              void reload(filter, next)
            }}
          />
        )}
      </section>
    </div>
  )
}

function AuditTable({
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
    <div className="border-border bg-card rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-muted-foreground border-b text-left text-xs tracking-wide uppercase">
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Action</th>
            <th className="px-3 py-2 font-medium">Outcome</th>
            <th className="px-3 py-2 font-medium">Detail</th>
          </tr>
        </thead>
        <tbody>
          {events.map((event) => (
            <tr key={event.id} className="border-b last:border-b-0 align-top">
              <td className="px-3 py-2">{formatTime(event.occurredAt)}</td>
              <td className="px-3 py-2 font-mono text-xs">{event.action}</td>
              <td className="px-3 py-2">
                <Badge variant={event.outcome === 'success' ? 'default' : 'destructive'}>
                  {event.outcome}
                </Badge>
              </td>
              <td className="text-muted-foreground px-3 py-2 font-mono text-[10px] break-all">
                {event.detail === null || event.detail === undefined
                  ? '—'
                  : JSON.stringify(event.detail)}
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

/** Stored in UTC, shown in the reader's own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return 'unknown'
  return at.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })
}