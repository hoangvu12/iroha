import { useQuery } from '@tanstack/react-query'
import { fetchBackgroundJobs } from './background.ts'
import { queryKeys } from './query-keys.ts'

/**
 * The background jobs and their last outcome. Unlike the Request and audit
 * reads this is live operational state rather than a historical log, so it keeps
 * refetch-on-focus: returning to the tab should not show a sync as still
 * running when it finished minutes ago.
 */
export function useBackgroundJobs() {
  return useQuery({
    queryKey: queryKeys.backgroundJobs(),
    queryFn: ({ signal }) => fetchBackgroundJobs(signal),
  })
}
