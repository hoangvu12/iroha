import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, seg } from "@/api/client";

// Types and hooks of the Requests page. They mirror the Go types in
// internal/requests (GET /api/requests, /stats, /filters, /{id}, /{id}/capture).
// Fields ticket 05 adds to Attempts are read in attempt-info.ts only.

export type Shape = "openai-chat" | "openai-responses" | "anthropic-messages" | "gemini";

export type Usage = { input: number; output: number; cache_read: number; reasoning: number };

export type Attempt = {
  seq: number;
  started_at: string;
  provider_id: string;
  provider: string;
  endpoint_id: string;
  endpoint: string;
  endpoint_url: string;
  upstream_key_id: string;
  upstream_key: string;
  wire_model: string;
  /** The model the Provider's answer said served it (ticket 32); read through attempt-info.ts. */
  reported_model?: string;
  shape: Shape;
  status: number;
  error?: string;
  first_byte_ms?: number;
  duration_ms?: number;
  usage?: Usage;
  // Set on failed Attempts (ticket 05); read through attempt-info.ts.
  rule?: string;
  outcome?: string;
  reason?: string;
  action?: string;
  failure_headers?: Record<string, string>;
  failure_body?: string;
};

export type RequestRecord = {
  id: string;
  started_at: string;
  finished_at?: string;
  state: "in_progress" | "completed" | "interrupted";
  status: number;
  error?: { code: string; message: string };
  /** One line saying what happened at each Attempt, for Requests with a failed or more than one Attempt. */
  summary?: string;
  caller: { kind: "gateway_key" | "test"; gateway_key_id?: string; name: string };
  route: string;
  shape_in: Shape;
  shape_out?: Shape;
  model: string;
  pool?: string;
  stream: boolean;
  provider_id?: string;
  provider?: string;
  endpoint_id?: string;
  endpoint?: string;
  upstream_key_id?: string;
  upstream_key?: string;
  wire_model?: string;
  first_byte_ms?: number;
  duration_ms?: number;
  usage?: Usage;
  attempt_count: number;
  captured: boolean;
  attempts?: Attempt[];
};

export type RequestPage = { requests: RequestRecord[]; next_before?: string; cursor: number };

export type Stats = {
  requests: number;
  in_progress: number;
  succeeded: number;
  failed: number;
  retried: number;
  median_duration_ms?: number;
  median_first_byte_ms?: number;
  tokens: { input: number; output: number; cache_read: number; reasoning: number; total: number };
};

export type CallerOption = { name: string; kind: "gateway_key" | "test"; gateway_key_id?: string; requests: number };
export type Option = { name: string; requests: number };
export type FilterOptions = { callers: CallerOption[]; providers: Option[]; pools: Option[]; models: Option[] };

export type CapturedBody = { content_type?: string; body: unknown; truncated?: boolean };
export type Capture = {
  request_id: string;
  captured_at: string;
  request: CapturedBody;
  response: CapturedBody & { status: number; stream?: string };
};

/** The filters of GET /api/requests and /stats, as the URL holds them. */
export type Query = {
  q?: string;
  caller?: string;
  provider?: string;
  pool?: string;
  model?: string;
  status?: string;
  since?: string;
};

export const keys = {
  all: ["requests"] as const,
  list: (q: Query) => ["requests", "list", q] as const,
  stats: (q: Query) => ["requests", "stats", q] as const,
  filters: (since?: string) => ["requests", "filters", since ?? ""] as const,
  one: (id: string) => ["requests", "one", id] as const,
  capture: (id: string) => ["requests", "capture", id] as const,
};

const PAGE = 100;
const POLL_MS = 2000;

const byNewest = (a: RequestRecord, b: RequestRecord) =>
  a.started_at === b.started_at ? (a.id < b.id ? 1 : -1) : a.started_at < b.started_at ? 1 : -1;

/**
 * The live feed: the newest page of Requests for q, older pages on demand,
 * and, while live, everything that started or changed since, polled with
 * the page's cursor (GET /api/requests?changed_after=). Updated Requests
 * replace their rows; new ones go on top.
 */
export function useRequestFeed(q: Query, live: boolean) {
  const pages = useInfiniteQuery({
    queryKey: keys.list(q),
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => api.get<RequestPage>("/api/requests", { signal, query: { ...q, before: pageParam, limit: PAGE } }),
    getNextPageParam: (last) => last.next_before ?? undefined,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    // A filter change is a new query: keep the old rows until the new ones land, so no skeleton flashes.
    placeholderData: keepPreviousData,
  });
  const placeholder = pages.isPlaceholderData;

  // Changes seen since the first page was read, keyed by Request ID.
  const [changes, setChanges] = useState<Map<string, RequestRecord>>(new Map());
  const cursor = useRef<number | undefined>(undefined);
  const firstPage = pages.data?.pages[0];

  // A new first page (filters changed, or refetched) restarts the changes.
  useEffect(() => {
    cursor.current = firstPage?.cursor;
    setChanges(new Map());
  }, [firstPage]);

  const qKey = JSON.stringify(q);
  useEffect(() => {
    // The rows on screen are the previous filter's until the new page lands: nothing to poll for yet.
    if (!live || placeholder || cursor.current === undefined) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const ctrl = new AbortController();
    const tick = async () => {
      try {
        // Drain: a full page means more changes wait.
        for (let i = 0; i < 5 && !stopped; i++) {
          const from = cursor.current;
          if (from === undefined) return;
          const p = await api.get<RequestPage>("/api/requests", { signal: ctrl.signal, query: { ...q, changed_after: from, limit: PAGE } });
          if (stopped || cursor.current !== from) return;
          cursor.current = p.cursor;
          if (p.requests.length > 0) {
            setChanges((m) => {
              const n = new Map(m);
              for (const r of p.requests) n.set(r.id, r);
              return n;
            });
          }
          if (p.requests.length < PAGE) break;
        }
      } catch {
        // A missed poll is retried on the next tick; the page keeps what it has.
      } finally {
        if (!stopped) timer = setTimeout(tick, POLL_MS);
      }
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [live, qKey, firstPage, placeholder]); // q is read through qKey

  // Rows that arrived live are in `added` (the table fades them in once).
  const { rows, added } = useMemo(() => {
    const listed = pages.data?.pages.flatMap((p) => p.requests) ?? [];
    const added = new Set<string>();
    if (changes.size === 0) return { rows: listed, added };
    const seen = new Set<string>();
    const out: RequestRecord[] = [];
    for (const r of listed) {
      seen.add(r.id);
      out.push(changes.get(r.id) ?? r);
    }
    const extra = [...changes.values()].filter((r) => !seen.has(r.id));
    for (const r of extra) added.add(r.id);
    return { rows: extra.length ? [...extra, ...out].sort(byNewest) : out, added };
  }, [pages.data, changes]);

  return { pages, rows, added };
}

export function useRequestStats(q: Query, live: boolean) {
  return useQuery({
    queryKey: keys.stats(q),
    queryFn: ({ signal }) => api.get<Stats>("/api/requests/stats", { signal, query: q }),
    refetchInterval: live ? 5000 : false,
    placeholderData: keepPreviousData,
  });
}

export function useFilterOptions(since?: string) {
  return useQuery({
    queryKey: keys.filters(since),
    queryFn: ({ signal }) => api.get<FilterOptions>("/api/requests/filters", { signal, query: { since } }),
    staleTime: 30_000,
  });
}

/** One Request with its Attempts; refetched while it is in progress. */
export function useRequest(id: string | undefined, seed?: RequestRecord) {
  return useQuery({
    queryKey: keys.one(id ?? ""),
    enabled: !!id,
    queryFn: ({ signal }) => api.get<RequestRecord>(`/api/requests/${seg(id!)}`, { signal }),
    placeholderData: seed && seed.id === id ? { ...seed, attempts: undefined } : undefined,
    refetchInterval: (query) => (query.state.data?.state === "in_progress" ? 2000 : false),
  });
}

export function useCapture(id: string | undefined, captured: boolean) {
  return useQuery({
    queryKey: keys.capture(id ?? ""),
    enabled: !!id && captured,
    queryFn: ({ signal }) => api.get<Capture>(`/api/requests/${seg(id!)}/capture`, { signal }),
    staleTime: Infinity,
  });
}

type Setting = { name: string; value: number };

/** retention.captures_days, for "Bodies are kept for N days." */
export function useCaptureDays() {
  return useQuery({
    queryKey: ["settings"],
    queryFn: ({ signal }) => api.get<{ settings: Setting[] }>("/api/settings", { signal }),
    select: (s) => s.settings.find((x) => x.name === "retention.captures_days")?.value,
    staleTime: 60_000,
  });
}
