import { useRefresh } from "@/pages/providers/api";

/**
 * How a record's sheet refreshes after a change: `refresh` reloads every list the change can
 * show in (`useRefresh`) and the sheet's own record together, so a result shows once both
 * do; `refreshAll` is the lists alone, for a change whose sheet closes (a delete, its Undo).
 */
export function useSheetRefresh(refetch: () => Promise<unknown>) {
  const refreshAll = useRefresh();
  return { refreshAll, refresh: () => Promise.all([refreshAll(), refetch()]) };
}
