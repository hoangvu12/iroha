import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { Loader2, Plus, RefreshCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatefulButton } from '@/components/ui/stateful-button'
import { Input } from '@/components/ui/input'
import { ApiError } from '@/lib/api-client'
import { fetchCatalog, refreshCatalog, type CatalogView } from '@/lib/catalog'
import { cn } from '@/lib/utils'

/** Sentinel height for the chip area so the input row below doesn't jump. */
const CHIPS_AREA_MIN_HEIGHT = 'min-h-5'

/**
 * A chip picker for model IDs scoped to a Provider's catalog.
 * Fetches the catalog on mount, shows discovered models as toggleable chips,
 * and lets the Owner add custom IDs that aren't yet in the catalog (these
 * render with an explicit remove button since they can't be re-toggled).
 *
 * The picker is purely presentational: `selected` carries every model the
 * Owner wants on the list. An empty `selected` means "no restriction" — the
 * caller decides whether that maps to `null`, `[]`, or whatever shape its
 * own API expects.
 */
export function ModelListPicker({
  providerId,
  csrfToken,
  selected,
  onChange,
  className,
}: {
  readonly providerId: string
  readonly csrfToken: string
  readonly selected: readonly string[]
  readonly onChange: (next: readonly string[]) => void
  readonly className?: string
}) {
  const [catalog, setCatalog] = useState<CatalogView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setCatalog(await fetchCatalog(providerId))
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not load models.')
    } finally {
      setLoading(false)
    }
  }, [providerId])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = async () => {
    setCatalog(await refreshCatalog(providerId, csrfToken))
  }

  const toggle = (modelId: string) => {
    onChange(selected.includes(modelId) ? selected.filter((id) => id !== modelId) : [...selected, modelId])
  }

  const remove = (modelId: string) => {
    onChange(selected.filter((id) => id !== modelId))
  }

  const addCustom = () => {
    const value = draft.trim()
    if (value === '') return
    if (selected.includes(value)) {
      setDraftError('That model is already in the list.')
      return
    }
    onChange([...selected, value])
    setDraft('')
    setDraftError(null)
  }

  const available = (catalog?.entries ?? []).filter((entry) => !entry.excluded)
  const availableIds = new Set(available.map((entry) => entry.modelId))
  const customSelected = selected.filter((id) => !availableIds.has(id))
  const selectedSet = new Set(selected)
  const totalKnown = available.length + customSelected.length
  const hasChips = totalKnown > 0

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {/*
       * The chip area is reserved up front so the input row below never
       * jumps while the catalog loads. The summary line + chips render here
       * once they exist; loading / error / empty states collapse into a
       * single muted line that occupies the same vertical band.
       */}
      <div className={CHIPS_AREA_MIN_HEIGHT}>
        {loading ? (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="size-3 animate-spin" aria-hidden />
            Loading models…
          </div>
        ) : error ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-status-danger">{error}</span>
            <StatefulButton
              variant="ghost"
              size="xs"
              successLabel="Retried"
              onClick={async () => {
                try {
                  await load()
                } catch (cause) {
                  throw cause instanceof ApiError ? cause : new Error('Could not load models.')
                }
              }}
            >
              Retry
            </StatefulButton>
          </div>
        ) : hasChips ? (
          <div className="flex flex-col gap-1.5">
            <p className="text-muted-foreground text-xs">
              {selectedSet.size === 0
                ? 'All models'
                : `${selectedSet.size} of ${totalKnown} models`}
            </p>
            {available.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {available.map((entry) => {
                  const isSelected = selectedSet.has(entry.modelId)
                  return (
                    <button
                      key={entry.modelId}
                      type="button"
                      onClick={() => toggle(entry.modelId)}
                      className={cn(
                        'inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-xs transition-colors',
                        isSelected
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground',
                      )}
                      title={`Source: ${entry.source}`}
                    >
                      {entry.modelId}
                    </button>
                  )
                })}
              </div>
            )}
            {customSelected.length > 0 && (
              <ul className="flex flex-wrap gap-1">
                {customSelected.map((modelId) => (
                  <li key={modelId}>
                    <span className="border-border bg-muted text-foreground inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs">
                      {modelId}
                      <button
                        type="button"
                        onClick={() => remove(modelId)}
                        aria-label={`Remove ${modelId}`}
                        className="text-muted-foreground hover:text-foreground -mr-0.5 inline-flex size-3.5 items-center justify-center rounded transition-colors"
                      >
                        <X className="size-2.5" aria-hidden />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">No models discovered yet.</span>
            <StatefulButton
              variant="ghost"
              size="xs"
              successLabel="Refreshed"
              onClick={async () => {
                try {
                  await refresh()
                } catch (cause) {
                  throw cause instanceof ApiError ? cause : new Error('Could not refresh models.')
                }
              }}
            >
              <RefreshCcw className="size-3" aria-hidden /> Refresh
            </StatefulButton>
          </div>
        )}
      </div>

      <div className="flex items-start gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              if (draftError !== null) setDraftError(null)
            }}
            onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                addCustom()
              }
            }}
            placeholder={
              loading || hasChips
                ? 'Add a model ID not in the catalog'
                : 'Add a model ID'
            }
            autoComplete="off"
            className="font-mono text-xs"
            aria-invalid={draftError !== null}
          />
          {draftError && <p className="text-status-danger text-xs">{draftError}</p>}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addCustom}
          disabled={draft.trim() === ''}
        >
          <Plus className="size-3.5" aria-hidden />
          Add
        </Button>
      </div>
    </div>
  )
}