import { formatNumber } from "@/lib/format";

type CacheCounts = { input: number; cache_read: number };

export const cachedShare = (t?: CacheCounts): number | undefined => (t && t.input > 0 ? t.cache_read / t.input : undefined);

export const cacheReadText = (t: CacheCounts, form?: "short"): string =>
  `${formatNumber(t.cache_read)} of ${formatNumber(t.input)} input${form === "short" ? "" : " tokens read from the cache"}`;
