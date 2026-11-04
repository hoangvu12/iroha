import { useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/** One editable row; the local id keeps React keys stable while fields change. */
export interface RewriteRow {
  readonly rowId: string
  readonly from: string
  readonly to: string
}

let rewriteRowCounter = 0
export function makeRewriteRow(from = '', to = ''): RewriteRow {
  rewriteRowCounter += 1
  return { rowId: `rw-${Date.now().toString(36)}-${rewriteRowCounter.toString(36)}`, from, to }
}

/** Builds editor rows from a stored map, always leaving one blank row to type into. */
export function rewriteRowsFromMap(map: Readonly<Record<string, string>> | null): RewriteRow[] {
  const rows = Object.entries(map ?? {}).map(([from, to]) => makeRewriteRow(from, to))
  return rows.length === 0 ? [makeRewriteRow()] : rows
}

/**
 * Collapses editor rows to the wire map: `{ requestedId: nativeId }`. Blank and
 * half-filled rows are dropped, and a row whose native ID equals the requested
 * ID is dropped too since it is the same as having no rewrite. An empty result
 * is `{}` — the caller sends that to clear every rewrite.
 */
export function rewriteMapFromRows(rows: readonly RewriteRow[]): Record<string, string> {
  const map: Record<string, string> = {}
  for (const row of rows) {
    const from = row.from.trim()
    const to = row.to.trim()
    if (from === '' || to === '' || from === to) continue
    map[from] = to
  }
  return map
}

/**
 * A small table that maps the model IDs a caller asks for to the native IDs one
 * endpoint serves them as. Left blank, an endpoint sends the requested ID
 * unchanged; a row is only needed where the endpoint's name differs.
 */
export function ModelRewritesEditor({
  rows,
  onChange,
  className,
}: {
  readonly rows: readonly RewriteRow[]
  readonly onChange: (next: readonly RewriteRow[]) => void
  readonly className?: string
}) {
  const update = (rowId: string, patch: Partial<RewriteRow>) =>
    onChange(rows.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)))
  const add = () => onChange([...rows, makeRewriteRow()])
  const remove = (rowId: string) =>
    onChange(rows.length <= 1 ? [makeRewriteRow()] : rows.filter((row) => row.rowId !== rowId))

  // A requested ID typed twice would silently lose the first mapping on save.
  const duplicates = useMemo(() => {
    const seen = new Map<string, number>()
    for (const row of rows) {
      const from = row.from.trim()
      if (from !== '') seen.set(from, (seen.get(from) ?? 0) + 1)
    }
    return new Set([...seen].filter(([, count]) => count > 1).map(([from]) => from))
  }, [rows])

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="text-muted-foreground grid grid-cols-[1fr_1fr_auto] gap-2 text-[11px] tracking-wide uppercase">
        <span>Model (caller asks for)</span>
        <span>Send to endpoint as</span>
        <span className="w-7" aria-hidden />
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => {
          const isDuplicate = row.from.trim() !== '' && duplicates.has(row.from.trim())
          return (
            <li key={row.rowId} className="grid grid-cols-[1fr_1fr_auto] items-center gap-2">
              <Input
                value={row.from}
                onChange={(event) => update(row.rowId, { from: event.target.value })}
                placeholder="gpt-6.1-sol"
                autoComplete="off"
                aria-label="Requested model ID"
                aria-invalid={isDuplicate}
                className={cn('font-mono text-xs', isDuplicate && 'border-status-danger')}
              />
              <Input
                value={row.to}
                onChange={(event) => update(row.rowId, { to: event.target.value })}
                placeholder="same name"
                autoComplete="off"
                aria-label="Native model ID sent to this endpoint"
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => remove(row.rowId)}
                aria-label="Remove mapping"
                className="w-7"
              >
                <Trash2 className="size-3.5" aria-hidden />
              </Button>
            </li>
          )
        })}
      </ul>
      {duplicates.size > 0 && (
        <p className="text-status-danger text-xs">
          Each model can map once; remove the duplicate rows.
        </p>
      )}
      <Button type="button" variant="outline" size="sm" onClick={add} className="self-start">
        <Plus className="size-3.5" aria-hidden />
        Add mapping
      </Button>
    </div>
  )
}
