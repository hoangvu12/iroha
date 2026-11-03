import { useState } from 'react'
import { Loader2, Plus, RefreshCcw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatefulButton } from '@/components/ui/stateful-button'
import type { CatalogEntryView } from '@/lib/catalog'
import type { ProviderView } from '@/lib/providers'
import {
  parseModelIds,
  useAddOwnerModels,
  useCatalog,
  useRefreshProviderCatalog,
  useRemoveOwnerModel,
} from '@/lib/use-catalog'
import { toApiError } from '@/lib/api-client'
import { cn } from '@/lib/utils'

const SOURCE_LABELS: Record<CatalogEntryView['source'], string> = {
  discovered: 'Discovered from GET /models',
  template: 'Known to the provider template',
  owner_added: 'Added by hand',
  excluded: 'Excluded',
}

export const MODEL_IDS_TEXTAREA_CLASS =
  'border-input bg-transparent placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[4.5rem] w-full resize-y rounded-md border px-3 py-2 font-mono text-xs shadow-xs focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30'

/**
 * The Provider's Model Catalog: what it reports through the Directory and
 * `/v1/models`. Models the Owner adds by hand survive every refresh, which is
 * the only way a Provider whose model list is off gets any.
 */
export function ProviderModelsCard({
  provider,
  csrfToken,
}: {
  readonly provider: ProviderView
  readonly csrfToken: string
}) {
  const catalog = useCatalog(provider.id)
  const add = useAddOwnerModels(provider.id, csrfToken)
  const remove = useRemoveOwnerModel(provider.id, csrfToken)
  const refresh = useRefreshProviderCatalog(provider.id, csrfToken)
  const [draft, setDraft] = useState('')

  const discoveryOff = provider.modelDiscovery === 'unsupported'
  const entries = catalog.data?.entries ?? []
  const failure = catalog.data?.sync.lastFailureMessage ?? null
  const pending = parseModelIds(draft)
  const editable = !provider.archived

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (pending.length === 0 || add.isPending) return
    add.mutate(pending, { onSuccess: () => setDraft('') })
  }

  return (
    <section className="bg-card rounded-xl border p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold tracking-tight">
          Models{' '}
          <span className="text-muted-foreground font-normal">{entries.length}</span>
        </h3>
        {editable && !discoveryOff && (
          <StatefulButton
            variant="ghost"
            size="xs"
            successLabel="Refreshed"
            onClick={async () => {
              await refresh.mutateAsync(undefined)
            }}
          >
            <RefreshCcw className="size-3" aria-hidden /> Refresh
          </StatefulButton>
        )}
      </div>

      <p className="text-muted-foreground mt-1 text-xs">
        {discoveryOff
          ? 'Model list is off for this provider, so iroha never reads GET /models. Add the model IDs it serves; they are what /v1/models lists.'
          : 'What this provider lists through /v1/models. Models you add by hand stay through every refresh.'}
      </p>

      {failure !== null && !discoveryOff && (
        <p className="text-status-warning mt-2 text-xs">Last refresh: {failure}</p>
      )}

      <div className="mt-3 min-h-5">
        {catalog.isPending ? (
          <span className="text-muted-foreground flex items-center gap-2 text-xs">
            <Loader2 className="size-3 animate-spin" aria-hidden /> Loading models…
          </span>
        ) : catalog.isError ? (
          <span className="text-status-danger text-xs">{toApiError(catalog.error).message}</span>
        ) : entries.length === 0 ? (
          <span className="text-muted-foreground text-xs">No models yet.</span>
        ) : (
          <ul className="flex flex-wrap gap-1">
            {entries.map((entry) => (
              <li key={entry.modelId}>
                <span
                  title={SOURCE_LABELS[entry.excluded ? 'excluded' : entry.source]}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-xs',
                    entry.source === 'owner_added'
                      ? 'border-border bg-muted text-foreground'
                      : 'border-border bg-background text-muted-foreground',
                    entry.excluded && 'line-through opacity-60',
                  )}
                >
                  {entry.modelId}
                  {editable && entry.source === 'owner_added' && (
                    <button
                      type="button"
                      onClick={() => remove.mutate(entry.modelId)}
                      disabled={remove.isPending}
                      aria-label={`Remove ${entry.modelId}`}
                      className="text-muted-foreground hover:text-foreground -mr-0.5 inline-flex size-3.5 items-center justify-center rounded transition-colors"
                    >
                      <X className="size-2.5" aria-hidden />
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editable && (
        <form className="mt-3 flex flex-col gap-2" onSubmit={submit} noValidate>
          <textarea
            aria-label="Model IDs to add"
            className={MODEL_IDS_TEXTAREA_CLASS}
            rows={2}
            placeholder="gpt-6.1-sol, another-model — one per line or comma-separated"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit(event)
            }}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={pending.length === 0 || add.isPending}
          >
            <Plus className="size-3.5" aria-hidden />
            {add.isPending
              ? 'Adding…'
              : pending.length > 1
                ? `Add ${pending.length} models`
                : 'Add model'}
          </Button>
        </form>
      )}
    </section>
  )
}
