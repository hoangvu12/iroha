import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { patchParams } from "@/lib/url-state";
import { useSheets } from "@/sheets/stack";
import type { Query } from "./api";

// Everything the Requests page shows is in its URL, so a view can be
// bookmarked or sent to someone: filters, time range, hidden columns and
// the open sheets (/requests?caller=Test%20(as%20zeron-fleet)&status=failed&range=24h&hide=key,shape&sheet=request:req_...).

export const RANGES = [
  { id: "15m", label: "Last 15 minutes", since: "15m", phrase: "in the last 15 minutes" },
  { id: "1h", label: "Last hour", since: "1h", phrase: "in the last hour" },
  { id: "24h", label: "Last 24 hours", since: "24h", phrase: "in the last 24 hours" },
  { id: "7d", label: "Last 7 days", since: "168h", phrase: "in the last 7 days" },
  { id: "30d", label: "Last 30 days", since: "720h", phrase: "in the last 30 days" },
] as const;
export type RangeId = (typeof RANGES)[number]["id"];
export const DEFAULT_RANGE: RangeId = "1h";

export const STATUSES = [
  { id: "failed", label: "Failed" },
  { id: "2xx", label: "2xx" },
  { id: "4xx", label: "4xx" },
  { id: "429", label: "429" },
  { id: "5xx", label: "5xx" },
] as const;

export const COLUMNS = [
  { id: "time", label: "Time" },
  { id: "status", label: "Status" },
  { id: "caller", label: "Caller" },
  { id: "model", label: "Model" },
  { id: "provider", label: "Provider" },
  { id: "key", label: "Key" },
  { id: "shape", label: "Shape" },
  { id: "attempts", label: "Attempts", right: true },
  { id: "first_token", label: "First token", right: true },
  { id: "duration", label: "Duration", right: true },
  { id: "input", label: "Input", right: true },
  { id: "output", label: "Output", right: true },
] as const;
export type ColumnId = (typeof COLUMNS)[number]["id"];

/** The filters chips and menus edit; the time range is separate (it is never "a filter" to clear). */
export const FILTER_KEYS = ["q", "caller", "provider", "pool", "model", "status"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export function useRequestsUrl() {
  const [params, setParams] = useSearchParams();

  const range = (RANGES.find((r) => r.id === params.get("range"))?.id ?? DEFAULT_RANGE) as RangeId;
  const rangeInfo = RANGES.find((r) => r.id === range)!;
  const filters = useMemo(() => {
    const f: Partial<Record<FilterKey, string>> = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [params]);
  const hidden = useMemo(() => new Set((params.get("hide") ?? "").split(",").filter(Boolean)), [params]);
  // The open Request is the stack's first sheet (spec "Stacked sheets"); ?request=<id> still opens it.
  const sheets = useSheets();
  const first = sheets.stack[0]?.record;
  const selected = first?.kind === "request" ? first.id : undefined;

  const query: Query = useMemo(() => ({ ...filters, since: rangeInfo.since }), [filters, rangeInfo.since]);

  const update = useCallback(
    (changes: Record<string, string | undefined>, push = false) => setParams((p) => patchParams(p, changes), { replace: !push }),
    [setParams],
  );

  return {
    range,
    rangeInfo,
    filters,
    query,
    hidden,
    selected,
    setFilter: (k: FilterKey, v: string | undefined) => update({ [k]: v }),
    setFilters: (changes: Partial<Record<FilterKey, string | undefined>>) => update(changes),
    clearFilters: () => update(Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined]))),
    setRange: (r: RangeId) => update({ range: r === DEFAULT_RANGE ? undefined : r }),
    toggleColumn: (c: ColumnId) => {
      const n = new Set(hidden);
      if (n.has(c)) n.delete(c);
      else n.add(c);
      update({ hide: COLUMNS.filter((x) => n.has(x.id)).map((x) => x.id).join(",") || undefined });
    },
    resetColumns: () => update({ hide: undefined }),
    select: (id: string | undefined) => (id ? sheets.open({ kind: "request", id }) : sheets.close(0)),
  };
}

export type RequestsUrl = ReturnType<typeof useRequestsUrl>;
