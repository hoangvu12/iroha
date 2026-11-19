import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

/** Phones get the bottom tab bar and full-page chat (C30-C33). Matches Tailwind's md breakpoint. */
export const PHONE_QUERY = "(max-width: 767px)";

export function useIsPhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
