import { formatNumber } from "@/lib/format";

/** The token counts a cached share is made of: a Request's or Attempt's usage, or summed stats. */
type CacheCounts = { input: number; cache_read: number };

/** The share of input tokens read from the Provider's prompt cache; undefined when nothing was input. */
export const cachedShare = (t?: CacheCounts): number | undefined => (t && t.input > 0 ? t.cache_read / t.input : undefined);

/** "1,000 of 4,000 input tokens read from the cache", or "1,000 of 4,000 input" for a row already labelled Cache read. */
export const cacheReadText = (t: CacheCounts, form?: "short"): string =>
  `${formatNumber(t.cache_read)} of ${formatNumber(t.input)} input${form === "short" ? "" : " tokens read from the cache"}`;
