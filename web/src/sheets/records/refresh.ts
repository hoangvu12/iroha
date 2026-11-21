import { useRefresh } from "@/pages/providers/api";

export function useSheetRefresh(refetch: () => Promise<unknown>) {
  const refreshAll = useRefresh();
  return { refreshAll, refresh: () => Promise.all([refreshAll(), refetch()]) };
}
