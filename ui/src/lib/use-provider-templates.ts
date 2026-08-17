import { useQuery } from '@tanstack/react-query'
import { fetchProviderTemplates } from './providers.ts'
import { queryKeys } from './query-keys.ts'

/**
 * The built-in Provider Templates, which change only when Iroha is upgraded.
 * They used to be held in a module-scope map behind a hand-rolled in-flight
 * latch; the shared cache does the same deduplication for every screen that
 * asks, and one navigation still costs no fetch.
 */
export function useProviderTemplates() {
  return useQuery({
    queryKey: queryKeys.providerTemplates(),
    queryFn: ({ signal }) => fetchProviderTemplates(signal),
  })
}
