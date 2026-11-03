import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { toApiError } from './api-client.ts'
import {
  addOwnerModel,
  fetchCatalog,
  refreshCatalog,
  removeOwnerModel,
  type CatalogView,
} from './catalog.ts'
import { queryKeys } from './query-keys.ts'

export function useCatalog(providerId: string) {
  return useQuery({
    queryKey: queryKeys.catalog(providerId),
    queryFn: ({ signal }) => fetchCatalog(providerId, signal),
  })
}

/**
 * Splits pasted model IDs on newlines, commas, and whitespace. Model IDs never
 * contain those, so a list copied from anywhere reads the same.
 */
export function parseModelIds(text: string): readonly string[] {
  return [...new Set(text.split(/[\s,]+/).map((id) => id.trim()).filter((id) => id !== ''))]
}

/**
 * Every catalog write answers with the whole catalog, so each one replaces the
 * cached view rather than invalidating it. Each is also audited.
 */
function useCatalogMutation<TVariables>(
  providerId: string,
  perform: (variables: TVariables) => Promise<CatalogView>,
  failureTitle: string,
) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: perform,
    onSuccess(view) {
      queryClient.setQueryData(queryKeys.catalog(providerId), view)
    },
    onError(cause) {
      toast.error(failureTitle, { description: toApiError(cause).message })
    },
    onSettled() {
      void queryClient.invalidateQueries({ queryKey: queryKeys.catalog(providerId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditAll() })
    },
  })
}

/** Adds the Owner's model IDs one by one; the last answer carries all of them. */
export function useAddOwnerModels(providerId: string, csrfToken: string) {
  return useCatalogMutation(
    providerId,
    async (modelIds: readonly string[]) => {
      let view: CatalogView | null = null
      for (const modelId of modelIds) view = await addOwnerModel(providerId, modelId, csrfToken)
      return view ?? (await fetchCatalog(providerId))
    },
    'Could not add models',
  )
}

export function useRemoveOwnerModel(providerId: string, csrfToken: string) {
  return useCatalogMutation(
    providerId,
    (modelId: string) => removeOwnerModel(providerId, modelId, csrfToken),
    'Could not remove model',
  )
}

export function useRefreshProviderCatalog(providerId: string, csrfToken: string) {
  return useCatalogMutation(
    providerId,
    () => refreshCatalog(providerId, csrfToken),
    'Could not refresh models',
  )
}
