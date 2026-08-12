import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  addOwnerModel,
  CatalogError,
  fetchCatalog,
  refreshCatalog,
  removeOwnerModel,
  setModelExcluded,
  updateModelOverrides,
  type CatalogEntryView,
  type CatalogOverrides,
  type CatalogView,
} from '@/lib/catalog'
import { formatTime as formatTimeWithUtc } from '@/lib/time'

interface ConnectionCatalogViewProps {
  readonly connectionId: string
  readonly csrfToken: string
}

/**
 * One Provider Connection's model catalog: the last synchronisation outcome,
 * every catalogued model with its provenance, and the Owner edits that survive
 * re-synchronisation.
 */
export function ConnectionCatalogView({
  connectionId,
  csrfToken,
}: ConnectionCatalogViewProps) {
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [error, setError] = useState<CatalogError | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [newModelId, setNewModelId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      setCatalog(await fetchCatalog(connectionId))
      setError(null)
    } catch (cause) {
      setError(
        cause instanceof CatalogError
          ? cause
          : new CatalogError('request_failed', 'Catalog could not be loaded.'),
      )
    }
  }, [connectionId])

  useEffect(() => {
    void reload()
  }, [reload])

  const refresh = async () => {
    setRefreshing(true)
    setError(null)
    try {
      setCatalog(await refreshCatalog(connectionId, csrfToken))
    } catch (cause) {
      setError(
        cause instanceof CatalogError
          ? cause
          : new CatalogError('request_failed', 'Refresh could not be completed.'),
      )
    } finally {
      setRefreshing(false)
    }
  }

  const submitNew = (event: FormEvent) => {
    event.preventDefault()
    const modelId = newModelId.trim()
    if (modelId === '' || busy !== null) return
    setBusy(`add-${modelId}`)
    addOwnerModel(connectionId, modelId, csrfToken)
      .then((value) => {
        setCatalog(value)
        setNewModelId('')
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof CatalogError
            ? cause
            : new CatalogError('request_failed', 'Could not add the model.'),
        ),
      )
      .finally(() => setBusy(null))
  }

  const toggleExcluded = (entry: CatalogEntryView) => {
    const next = !entry.excluded
    setBusy(`excluded-${entry.modelId}`)
    setModelExcluded(connectionId, entry.modelId, next, csrfToken)
      .then((value) => setCatalog(value))
      .catch((cause: unknown) =>
        setError(
          cause instanceof CatalogError
            ? cause
            : new CatalogError('request_failed', 'Could not update exclusion.'),
        ),
      )
      .finally(() => setBusy(null))
  }

  const remove = (entry: CatalogEntryView) => {
    setBusy(`remove-${entry.modelId}`)
    removeOwnerModel(connectionId, entry.modelId, csrfToken)
      .then((value) => setCatalog(value))
      .catch((cause: unknown) =>
        setError(
          cause instanceof CatalogError
            ? cause
            : new CatalogError('request_failed', 'Could not remove the model.'),
        ),
      )
      .finally(() => setBusy(null))
  }

  const updateOverrides = (entry: CatalogEntryView) => {
    const inputs = document.querySelectorAll<HTMLInputElement>(
      `input[name="overrides-${entry.modelId}"]`,
    )
    const overrides: { -readonly [K in keyof CatalogOverrides]: CatalogOverrides[K] } = {}
    for (const input of inputs) {
      const capability = input.dataset['capability']
      if (
        capability === 'chat' ||
        capability === 'streaming' ||
        capability === 'tools' ||
        capability === 'structuredOutput' ||
        capability === 'responses'
      ) {
        overrides[capability] = input.checked
      }
    }
    setBusy(`overrides-${entry.modelId}`)
    updateModelOverrides(connectionId, entry.modelId, overrides, csrfToken)
      .then((value) => setCatalog(value))
      .catch((cause: unknown) =>
        setError(
          cause instanceof CatalogError
            ? cause
            : new CatalogError('request_failed', 'Could not save capability overrides.'),
        ),
      )
      .finally(() => setBusy(null))
  }

  if (catalog === null && error === null) {
    return <Skeleton className="h-32 w-full" />
  }

  if (catalog === null && error !== null) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>Catalog unavailable</AlertTitle>
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    )
  }

  if (catalog === null) return null

  return (
    <div className="flex flex-col gap-6">
      <section>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold tracking-tight">Model catalog</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              The set of Upstream Models Iroha forwards for this connection, with its
              provenance and the last synchronisation outcome. A failed refresh retains
              the last successful catalog and marks it stale.
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
            <AlertTitle>Catalog action failed</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        <div className="bg-card mb-4 rounded-lg border p-4 text-sm">
          <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            <Row label="Last successful sync">
              {catalog.sync.lastSuccessAt === null ? 'Never' : formatTime(catalog.sync.lastSuccessAt)}
            </Row>
            <Row label="Last sync attempt">
              {catalog.sync.syncedAt === null ? 'Never' : formatTime(catalog.sync.syncedAt)}
            </Row>
            <Row label="Last failure">
              {catalog.sync.lastFailureAt === null
                ? 'None'
                : `${formatTime(catalog.sync.lastFailureAt)}${
                    catalog.sync.lastFailureMessage === null
                      ? ''
                      : ` · ${catalog.sync.lastFailureMessage}`
                  }`}
            </Row>
            <Row label="State">
              {catalog.sync.stale ? 'Stale (last refresh failed)' : 'Current'}
            </Row>
          </dl>
        </div>

        <form className="bg-card mb-4 flex items-end gap-2 rounded-lg border p-3" onSubmit={submitNew}>
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="catalog-add">Add an exact model ID</Label>
            <Input
              id="catalog-add"
              value={newModelId}
              onChange={(event) => setNewModelId(event.target.value)}
              placeholder="gpt-4o-mini"
              autoComplete="off"
            />
          </div>
          <Button type="submit" size="sm" disabled={busy !== null || newModelId.trim() === ''}>
            {busy?.startsWith('add-') ? 'Adding…' : 'Add model'}
          </Button>
        </form>

        {catalog.entries.length === 0 ? (
          <p className="text-muted-foreground py-3 text-sm">
            No catalogued models yet. Refresh to discover, or add one above.
          </p>
        ) : (
          <ul className="divide-border divide-y rounded-md border">
            {catalog.entries.map((entry) => (
              <CatalogEntryRow
                key={entry.modelId}
                entry={entry}
                busy={busy}
                onToggleExcluded={() => toggleExcluded(entry)}
                onRemove={() => remove(entry)}
                onSaveOverrides={() => updateOverrides(entry)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

const CAPABILITIES = [
  { key: 'chat', label: 'Chat' },
  { key: 'streaming', label: 'Streaming' },
  { key: 'tools', label: 'Tools' },
  { key: 'structuredOutput', label: 'Structured output' },
  { key: 'responses', label: 'Responses' },
] as const

function CatalogEntryRow({
  entry,
  busy,
  onToggleExcluded,
  onRemove,
  onSaveOverrides,
}: {
  readonly entry: CatalogEntryView
  readonly busy: string | null
  readonly onToggleExcluded: () => void
  readonly onRemove: () => void
  readonly onSaveOverrides: () => void
}) {
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{entry.modelId}</span>
        <SourceTag source={entry.source} excluded={entry.excluded} />
        <span className="text-muted-foreground ml-auto flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onToggleExcluded}
            disabled={busy !== null}
          >
            {entry.excluded ? 'Unblock' : 'Block'}
          </Button>
          {(entry.source === 'owner_added' || entry.source === 'excluded') && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onRemove}
              disabled={busy !== null}
            >
              {busy === `remove-${entry.modelId}` ? 'Removing…' : 'Remove'}
            </Button>
          )}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        {CAPABILITIES.map(({ key, label }) => (
          <label key={key} className="text-muted-foreground flex items-center gap-1">
            <input
              type="checkbox"
              name={`overrides-${entry.modelId}`}
              data-capability={key}
              defaultChecked={entry.overrides?.[key] ?? false}
              className="size-3"
            />
            {label}
          </label>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onSaveOverrides}
          disabled={busy !== null}
        >
          {busy === `overrides-${entry.modelId}` ? 'Saving…' : 'Save overrides'}
        </Button>
      </div>
    </li>
  )
}

function SourceTag({
  source,
  excluded,
}: {
  readonly source: CatalogEntryView['source']
  readonly excluded: boolean
}) {
  if (excluded) {
    return <span className="text-status-warning text-xs">Excluded</span>
  }
  switch (source) {
    case 'discovered':
      return <span className="text-status-healthy text-xs">Discovered</span>
    case 'template':
      return <span className="text-active text-xs">Template</span>
    case 'owner_added':
      return <span className="text-muted-foreground text-xs">Owner-added</span>
    case 'excluded':
      return <span className="text-status-warning text-xs">Excluded</span>
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

function formatTime(iso: string): string {
  return formatTimeWithUtc(iso, { dateStyle: 'medium', timeStyle: 'short' })
}