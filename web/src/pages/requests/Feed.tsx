import type { ReactNode } from "react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Activity, ChevronDown, Columns3, ListFilter } from "lucide-react";
import { PageHeader } from "@/app/PageHeader";
import { formatNumber, formatPercent } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { useStoredChoice } from "@/lib/stored-choice";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { Button, buttonClass, TextButton } from "@/ui/Button";
import { StatusDot } from "@/ui/bits";
import { cn } from "@/ui/cn";
import { SearchInput } from "@/ui/Input";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuIconTrigger,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
  SubMenu,
} from "@/ui/Menu";
import { Tip } from "@/ui/Tooltip";
import { Chip, EmptyState, NoResults } from "@/ui/States";
import { Skeleton } from "@/ui/Skeleton";
import { type DataColumn, type DataTablePaging, DataTable, columnsFor, useTablePaging } from "@/ui/DataTable";
import type { FilterOptions, RequestRecord, Stats } from "./api";
import { useFilterOptions, useRequestFeed, useRequestStats } from "./api";
import { cachedShare, cacheReadText } from "./cache-share";
import { SAMPLE_CALLERS, SAMPLE_REQUESTS, SAMPLE_STATS } from "./samples";
import { clock, compactNumber, failed, PoolTag, ProviderLogo, secs, shapeInOut, StatusCell, statusTone } from "./bits";
import { useLendRequestRows } from "@/sheets/stack";
import { useArrivals } from "./arrivals";
import { rec, RecordLink } from "@/sheets/RecordLink";
import { COLUMNS, type ColumnId, type FilterKey, RANGES, type RequestsUrl, STATUSES, useRequestsUrl } from "./url-state";

export type FeedPaging = "live" | "pages";
const PAGINGS: readonly FeedPaging[] = ["live", "pages"];

const useFeedPaging = () => useStoredChoice("iroha:requests:paging", PAGINGS, "live");

const PAGING_CHOICES: { value: FeedPaging; label: string }[] = [
  { value: "live", label: "Live, load older as you scroll" },
  { value: "pages", label: "Numbered pages" },
];

export function RequestsFeed({ paging: forced }: { paging?: FeedPaging }) {
  const url = useRequestsUrl();
  const phone = useIsPhone();
  const [chosen, setPaging] = useFeedPaging();
  const paging = forced ?? chosen;
  const [live, setLive] = useState(true);
  const feed = useRequestFeed(url.query, live);
  const stats = useRequestStats(url.query, live);
  const options = useFilterOptions(url.rangeInfo.since);
  const pages = feed.pages;
  const rows = feed.rows;
  const loaded = pages.data ? rows : undefined;
  useLendRequestRows(rows);

  const chips = filterChips(url, options.data);
  const columns = useMemo(() => feedColumns(url.hidden), [url.hidden]);
  const columnVisibility = useMemo(() => Object.fromEntries([...url.hidden].map((id) => [id, false])), [url.hidden]);
  const loadOlder = () => void pages.fetchNextPage();

  const last = rows[rows.length - 1]?.id;
  const loadOlderUnlessLoading = useEffectEvent(() => {
    if (!pages.isFetchingNextPage) loadOlder();
  });
  useEffect(() => {
    if (url.selected && url.selected === last && pages.hasNextPage) loadOlderUnlessLoading();
  }, [url.selected, last, pages.hasNextPage]);

  const numbered = useNumberedPages(paging === "pages", loaded, pages, stats.data?.requests, JSON.stringify(url.query));
  const tablePaging: DataTablePaging = numbered
    ? numbered.paging
    : {
        mode: "infinite",
        hasMore: !!pages.hasNextPage,
        loadingMore: pages.isFetchingNextPage,
        onLoadMore: loadOlder,
        moreLabel: "Load older Requests",
        newRowsLabel: (n) => `${n} new`,
      };

  const box = useRef<HTMLDivElement>(null);
  useArrivals(box, feed.added);

  return (
    <>
      <PageHeader
        title="Requests"
        description={phone ? undefined : "Every call through Iroha, newest first"}
        actions={<LiveToggle live={live} onToggle={() => setLive((l) => !l)} phone={phone} />}
      />
      <Skeleton data={stats.data} sample={SAMPLE_STATS} id={phone ? "requests-stats:phone" : "requests-stats"} label="Loading totals">
        {(s) => <StatsRow stats={s} phone={phone} />}
      </Skeleton>

      <Toolbar url={url} options={options.data} phone={phone} paging={paging} onPaging={setPaging} />
      {chips.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {chips.map((c) => (
            <Chip key={c.label} {...c} />
          ))}
          <TextButton tone="quiet" onClick={url.clearFilters} className="ml-1 text-[13px]">
            Clear filters
          </TextButton>
        </div>
      )}

      <div ref={box}>
        <DataTable
          id="requests"
          label="Requests"
          columns={columns}
          data={numbered ? numbered.rows : loaded}
          sample={SAMPLE_REQUESTS}
          getRowId={(r) => r.id}
          rowName={(r) => `Request ${r.id}`}
          columnVisibility={columnVisibility}
          manualFiltering
          manualSorting
          filterChips={chips}
          onClearFilters={url.clearFilters}
          noResults={<NoResults title="No Requests match these filters" description={noResultsLine(url, options.data)}onClear={url.clearFilters} />}
          empty={<Empty url={url} />}
          error={pages.isError ? pages.error : undefined}
          errorTitle="Couldn't load Requests"
          onRetry={() => void pages.refetch()}
          onRowClick={(r) => url.select(r.id)}
          activeRowId={url.selected}
          rowTone={(r) => (failed(r) ? "danger" : undefined)}
          phoneRow={(r) => <PhoneRow r={r} />}
          paging={tablePaging}
          dimmed={pages.isPlaceholderData || numbered?.waiting}
          footer={({ shown }) => countLine(shown, stats.data?.requests, !!numbered)}
        />
      </div>
    </>
  );
}

function countLine(shown: number, total: number | undefined, numbered: boolean): string {
  const of = total ?? shown;
  const noun = of === 1 ? "Request" : "Requests";
  if (numbered || shown >= of) return `${formatNumber(of)} ${noun}`;
  return `Showing ${formatNumber(shown)} of ${formatNumber(of)} ${noun}`;
}

type FeedPages = ReturnType<typeof useRequestFeed>["pages"];

function useNumberedPages(on: boolean, loaded: RequestRecord[] | undefined, pages: FeedPages, total: number | undefined, query: string) {
  const [pagination, setPagination] = useTablePaging("requests");
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [query, setPagination]);

  const start = pagination.pageIndex * pagination.pageSize;
  const end = start + pagination.pageSize;
  const waiting = on && !!loaded && loaded.length < end && !!pages.hasNextPage;
  const { isFetchingNextPage, fetchNextPage } = pages;
  useEffect(() => {
    if (waiting && !isFetchingNextPage) void fetchNextPage();
  }, [waiting, isFetchingNextPage, fetchNextPage]);

  const shown = useRef<RequestRecord[] | undefined>(undefined);
  if (!on) return null;
  if (!waiting) shown.current = loaded?.slice(start, end);
  const count = loaded ? (pages.hasNextPage ? Math.max(total ?? 0, loaded.length + 1) : loaded.length) : 0;
  const paging: DataTablePaging = { mode: "server", pagination, onPaginationChange: setPagination, rowCount: count };
  return { rows: shown.current ?? (loaded ? [] : undefined), waiting, paging };
}

function LiveToggle({ live, onToggle, phone }: { live: boolean; onToggle: () => void; phone: boolean }) {
  return (
    <Tip label={live ? "New Requests appear as they arrive. Click to pause." : "Paused. Click to follow new Requests again."} type="description">
      <SdkButton
        type="button"
        onClick={onToggle}
        aria-pressed={live}
        className={cn(
          "inline-flex h-8 items-center gap-2 rounded-full px-3 text-[14px] transition-colors duration-hover ease-[ease]",
          phone ? (live ? "bg-success-tint font-medium text-success" : "bg-muted text-fg-muted") : "text-fg hover:bg-muted",
        )}
      >
        <StatusDot tone={live ? "green" : "gray"} />
        {live ? "Live" : "Paused"}
      </SdkButton>
    </Tip>
  );
}

function StatsRow({ stats, phone }: { stats: Stats; phone: boolean }) {
  const finished = stats.succeeded + stats.failed;
  const cells: { label: string; value: string; title?: string }[] = [
    { label: "Requests", value: formatNumber(stats.requests) },
    { label: "Succeeded", value: finished > 0 ? formatPercent(stats.succeeded / finished) : "–" },
    ...(phone
      ? [{ label: "Median", value: secs(stats.median_duration_ms) }]
      : [
          { label: "Retried", value: formatNumber(stats.retried) },
          { label: "Median duration", value: secs(stats.median_duration_ms) },
          { label: "Median first token", value: secs(stats.median_first_byte_ms) },
          { label: "Tokens", value: stats.tokens.total > 0 ? compactNumber(stats.tokens.total) : "0" },
          {
            label: "Cached",
            value: pctOr(cachedShare(stats.tokens)),
            title: cachedTitle(stats.tokens),
          },
        ]),
  ];
  return (
    <dl className={cn("mb-6 grid divide-x divide-border rounded-xl border border-border", phone ? "-mt-3 grid-cols-3" : "-mt-2 grid-cols-7")}>
      {cells.map((c) => (
        <div key={c.label} className={cn("min-w-0", phone ? "px-4 py-3" : "px-4 py-4")}>
          <dt className="truncate text-[14px] text-fg-muted">
            {c.label}
          </dt>
          <dd title={c.title} className={cn("mt-1 truncate font-semibold tabular tracking-tight", phone ? "text-[22px]" : "text-[26px]")}>
            {c.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

const pctOr = (share: number | undefined) => (share === undefined ? "–" : formatPercent(share));

function cachedTitle(t: Stats["tokens"]): string | undefined {
  if (cachedShare(t) === undefined) return undefined;
  const read = cacheReadText(t);
  return t.cache_write > 0 ? `${read}; ${formatNumber(t.cache_write)} written to it` : read;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Toolbar({
  url,
  options,
  phone,
  paging,
  onPaging,
}: {
  url: RequestsUrl;
  options?: FilterOptions;
  phone: boolean;
  paging: FeedPaging;
  onPaging: (p: FeedPaging) => void;
}) {
  const [text, setText] = useState(url.filters.q ?? "");
  const q = useDebounced(text.trim(), 250);
  const searchFor = useEffectEvent((q: string) => {
    if (q !== (url.filters.q ?? "")) url.setFilter("q", q || undefined);
  });
  useEffect(() => searchFor(q), [q]);
  useEffect(() => {
    if (!url.filters.q) setText((t) => (t.trim() ? "" : t));
  }, [url.filters.q]);

  const active = Object.keys(url.filters).filter((k) => k !== "q").length;

  return (
    <div className="mb-4 flex items-center gap-2.5">
      <SearchInput
        placeholder={phone ? "Model, Caller or ID" : "Search model, Caller or request ID"}
        aria-label="Search Requests"
        value={text}
        onChange={(e) => setText(e.target.value)}
        className={phone ? "min-w-0 flex-1" : "w-[440px]"}
      />
      <Menu>
        {phone ? (
          <MenuIconTrigger icon={ListFilter} label="Filter" bordered />
        ) : (
          <MenuTrigger className={buttonClass()}>
            <ListFilter size={16} aria-hidden className="shrink-0" />
            Filter
            {active > 0 && <span className="tabular text-fg-muted">{active}</span>}
          </MenuTrigger>
        )}
        <FilterMenu url={url} options={options} phone={phone} paging={paging} onPaging={onPaging} />
      </Menu>
      {!phone && (
        <>
          <Menu>
            <MenuTrigger className={buttonClass()}>
              <Columns3 size={16} aria-hidden className="shrink-0" />
              View
            </MenuTrigger>
            <MenuContent align="start">
              <MenuGroup label="Show columns">
                {COLUMNS.map((c) => (
                  <MenuCheckboxItem key={c.id} value={c.id} checked={!url.hidden.has(c.id)} onCheckedChange={() => url.toggleColumn(c.id)}>
                    {c.label}
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
              {url.hidden.size > 0 && (
                <>
                  <MenuSeparator />
                  <MenuItem onSelect={url.resetColumns}>Show all</MenuItem>
                </>
              )}
              <MenuSeparator />
              <PagingChoice paging={paging} onPaging={onPaging} />
            </MenuContent>
          </Menu>
          <div className="flex-1" />
          <Menu>
            <MenuTrigger className={buttonClass("secondary", "md", "gap-1.5")} aria-label={`Time: ${url.rangeInfo.label}`}>
              {url.rangeInfo.label}
              <ChevronDown size={15} aria-hidden className="text-fg-muted" />
            </MenuTrigger>
            <MenuContent>
              <MenuRadioGroup value={url.range} onValueChange={(v) => url.setRange(v as typeof url.range)}>
                {RANGES.map((r) => (
                  <MenuRadioItem key={r.id} value={r.id}>
                    {r.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        </>
      )}
    </div>
  );
}

function PagingChoice({ paging, onPaging }: { paging: FeedPaging; onPaging: (p: FeedPaging) => void }) {
  return (
    <MenuRadioGroup label="Load Requests" value={paging} onValueChange={(v) => onPaging(v as FeedPaging)}>
      {PAGING_CHOICES.map((c) => (
        <MenuRadioItem key={c.value} value={c.value}>
          {c.label}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

function FilterMenu({
  url,
  options,
  phone,
  paging,
  onPaging,
}: {
  url: RequestsUrl;
  options?: FilterOptions;
  phone: boolean;
  paging: FeedPaging;
  onPaging: (p: FeedPaging) => void;
}) {
  const f = url.filters;
  const withCurrent = <T extends { name: string }>(list: T[] | undefined, current?: string): { name: string; requests?: number }[] => {
    const l: { name: string; requests?: number }[] = list ?? [];
    return current && !l.some((o) => o.name === current) ? [{ name: current }, ...l] : l;
  };
  const caller = callerName(f.caller, options);
  const callers = withCurrent(options?.callers, caller);
  const providers = withCurrent(options?.providers, f.provider);
  const pools = withCurrent(options?.pools, f.pool);
  const models = withCurrent(options?.models, f.model);
  const set = (k: FilterKey, v: string | undefined) => url.setFilter(k, v);
  const any = Object.keys(f).length > 0;

  const providerOrPool = f.provider ? "p:" + f.provider : f.pool ? "m:" + f.pool : "";
  const pickProviderOrPool = (v: string) =>
    url.setFilters(
      v.startsWith("p:") ? { provider: v.slice(2), pool: undefined } : v.startsWith("m:") ? { pool: v.slice(2), provider: undefined } : { provider: undefined, pool: undefined },
    );

  return (
    <MenuContent align={phone ? "end" : "start"} className="min-w-56">
      <SubMenu label="Caller" value={caller}>
        <MenuRadioGroup value={caller ?? ""}onValueChange={(v) => set("caller", v || undefined)}>
          <MenuRadioItem value="">Anyone</MenuRadioItem>
          {callers.map((c) => (
            <MenuRadioItem key={c.name} value={c.name} count={c.requests}>
              {c.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {!options && (
          <Skeleton data={undefined} sample={SAMPLE_CALLERS} label="Loading Callers">
            {(callers) =>
              callers.map((c) => (
                <div key={c.name} className="flex h-8 items-center gap-2 rounded-md px-2 pl-8">
                  <span className="min-w-0 flex-1 truncate">{c.name}</span>
                  <span className="tabular text-xs">{c.requests}</span>
                </div>
              ))
            }
          </Skeleton>
        )}
      </SubMenu>
      <SubMenu label="Provider or Pool" value={f.provider ?? f.pool}>
        <MenuRadioGroup value={providerOrPool} onValueChange={pickProviderOrPool}>
          <MenuRadioItem value="">Any</MenuRadioItem>
          {providers.length > 0 && <MenuLabel>Providers</MenuLabel>}
          {providers.map((p) => (
            <MenuRadioItem key={"p:" + p.name} value={"p:" + p.name} count={p.requests}>
              <ProviderLogo handle={p.name} size={18} />
              {p.name}
            </MenuRadioItem>
          ))}
          {pools.length > 0 && <MenuLabel>Model Pools</MenuLabel>}
          {pools.map((p) => (
            <MenuRadioItem key={"m:" + p.name} value={"m:" + p.name} count={p.requests}>
              {p.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </SubMenu>
      <SubMenu label="Model" value={f.model}>
        <MenuRadioGroup value={f.model ?? ""} onValueChange={(v) => set("model", v || undefined)}>
          <MenuRadioItem value="">Any model</MenuRadioItem>
          {models.map((m) => (
            <MenuRadioItem key={m.name} value={m.name} count={m.requests}>
              {m.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </SubMenu>
      <SubMenu label="Status" value={STATUSES.find((s) => s.id === f.status)?.label ?? f.status}>
        <MenuRadioGroup value={f.status ?? ""} onValueChange={(v) => set("status", v || undefined)}>
          <MenuRadioItem value="">Any status</MenuRadioItem>
          {STATUSES.map((s) => (
            <MenuRadioItem key={s.id} value={s.id}>
              {s.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </SubMenu>
      {phone && (
        <SubMenu label="Time" value={url.rangeInfo.label}>
          <MenuRadioGroup value={url.range} onValueChange={(v) => url.setRange(v as typeof url.range)}>
            {RANGES.map((r) => (
              <MenuRadioItem key={r.id} value={r.id}>
                {r.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </SubMenu>
      )}
      {phone && (
        <SubMenu label="Load Requests" value={paging === "pages" ? "Numbered pages" : "Live"}>
          <PagingChoice paging={paging} onPaging={onPaging} />
        </SubMenu>
      )}
      {any && (
        <>
          <MenuSeparator />
          <MenuItem onSelect={url.clearFilters}>Clear filters</MenuItem>
        </>
      )}
    </MenuContent>
  );
}

function callerName(caller: string | undefined, options?: FilterOptions): string | undefined {
  if (!caller || !options) return caller;
  return (options.callers.find((c) => c.name === caller) ?? options.callers.find((c) => c.gateway_key_id === caller))?.name ?? caller;
}

function filterChips(url: RequestsUrl, options?: FilterOptions) {
  const f = { ...url.filters, caller: callerName(url.filters.caller, options) };
  const status = STATUSES.find((s) => s.id === f.status)?.label ?? f.status;
  const chips: { label: string; onRemove: () => void }[] = [];
  const add = (k: FilterKey, label: string) => chips.push({ label, onRemove: () => url.setFilter(k, undefined) });
  if (f.q) add("q", `Text is “${f.q}”`);
  if (f.caller) add("caller", `Caller is ${f.caller}`);
  if (f.provider) add("provider", `Provider is ${f.provider}`);
  if (f.pool) add("pool", `Pool is ${f.pool}`);
  if (f.model) add("model", `Model is ${f.model}`);
  if (f.status) add("status", `Status is ${status}`);
  return chips;
}

function noResultsLine(url: RequestsUrl, options?: FilterOptions): string {
  const f = { ...url.filters, caller: callerName(url.filters.caller, options) };
  const parts = ["Nothing"];
  if (f.caller) parts.push(`from ${f.caller}`);
  if (f.model) parts.push(`for ${f.model}`);
  if (f.provider) parts.push(`through ${f.provider}`);
  if (f.pool) parts.push(`through the Pool ${f.pool}`);
  if (f.q) parts.push(`matching “${f.q}”`);
  if (f.status === "failed") parts.push("failed");
  else if (f.status) parts.push(`ended with ${f.status}`);
  else parts.push("arrived");
  parts.push(url.rangeInfo.phrase);
  return parts.join(" ") + ".";
}

function Empty({ url }: { url: RequestsUrl }) {
  if (url.range !== "30d")
    return (
      <EmptyState
        icon={Activity}
        title={`No Requests ${url.rangeInfo.phrase}`}
        description="Requests show here the moment Callers send them."
        action={<Button onClick={() => url.setRange("30d")}>Show the last 30 days</Button>}
      />
    );
  return (
    <EmptyState
      icon={Activity}
      title="No Requests yet"
      description="Give a Caller a Gateway Key and every call it makes shows here."
      action={
        <Link to="/gateway-keys" className={buttonClass("primary")}>
          Issue a Gateway Key
        </Link>
      }
    />
  );
}

const dash = <span className="text-fg-subtle">–</span>;
const col = columnsFor<RequestRecord>();

const cells: Record<ColumnId, (r: RequestRecord) => ReactNode> = {
  time: (r) => clock(r.started_at),
  status: (r) => <StatusCell r={r} />,
  caller: (r) =>
    r.caller.gateway_key_id ? (
      <span className="flex max-w-[200px]" title={r.caller.name}>
        <RecordLink record={rec.gatewayKey(r.caller.gateway_key_id)}>{r.caller.name}</RecordLink>
      </span>
    ) : (
      <span className="block max-w-[200px] truncate" title={r.caller.name}>
        {r.caller.name}
      </span>
    ),
  model: (r) => (
    <span className="inline-flex max-w-[260px] items-center gap-2">
      {r.pool ? (
        <RecordLink record={rec.pool(r.pool)} className="font-medium" title={r.model}>
          {r.model}
        </RecordLink>
      ) : r.provider && r.wire_model ? (
        <RecordLink record={rec.model(r.provider, r.wire_model)} className="font-medium" title={r.model}>
          {r.model}
        </RecordLink>
      ) : (
        <span className="truncate font-medium" title={r.model}>
          {r.model || dash}
        </span>
      )}
      {r.pool && <PoolTag />}
    </span>
  ),
  provider: (r) =>
    r.provider ? (
      <span className="inline-flex items-center gap-2">
        <ProviderLogo handle={r.provider} />
        <RecordLink record={rec.provider(r.provider)}>{r.provider}</RecordLink>
      </span>
    ) : (
      dash
    ),
  key: (r) => (r.upstream_key && r.provider ? <RecordLink record={rec.key(r.provider, r.upstream_key)}>{r.upstream_key}</RecordLink> : r.upstream_key || "–"),
  shape: (r) => shapeInOut(r),
  attempts: (r) => (
    <span title={r.attempt_count > 1 ? "Retried" : undefined} className={cn(r.attempt_count > 1 && "font-semibold text-warning", r.attempt_count === 0 && "text-fg-subtle")}>
      {r.attempt_count}
    </span>
  ),
  first_token: (r) => (r.state === "completed" && !failed(r) ? secs(r.first_byte_ms) : dash),
  duration: (r) => (r.state === "in_progress" ? dash : secs(r.duration_ms)),
  input: (r) => (r.usage ? formatNumber(r.usage.input) : dash),
  output: (r) => (r.usage ? formatNumber(r.usage.output) : dash),
};

const cellClass: Partial<Record<ColumnId, string>> = { time: "font-mono text-[13px] text-fg-muted", key: "font-mono text-[13px] text-fg-muted" };

const OPENERS: ColumnId[] = ["time", "status", "shape", "duration", "first_token", "attempts", "input", "output"];

function feedColumns(hidden: Set<string>): DataColumn<RequestRecord>[] {
  const opens = OPENERS.find((id) => !hidden.has(id));
  return col.columns(
    COLUMNS.map((c) =>
      col.display({
        id: c.id,
        header: c.label,
        cell: ({ row }) => cells[c.id](row.original),
        meta: {
          align: "right" in c && c.right ? "right" : undefined,
          className: cn("whitespace-nowrap text-[14.5px]", cellClass[c.id]),
          opens: c.id === opens,
        },
      }),
    ),
  );
}

function PhoneRow({ r }: { r: RequestRecord }) {
  const tone = statusTone(r.status, r.state);
  return (
    <div className="min-w-0 flex-1 px-1">
      <div className="flex items-center gap-2.5">
        <StatusDot tone={tone} />
        <span className={cn("shrink-0 text-[16px] font-medium tabular", tone === "red" && "text-danger-text", tone === "amber" && "text-warning")}>
          {r.state === "in_progress" ? "…" : r.state === "interrupted" ? "–" : r.status}
        </span>
        <span className="min-w-0 truncate text-[16px] font-semibold">{r.model || "–"}</span>
        {r.pool && <PoolTag />}
        <span className="ml-auto shrink-0 font-mono text-[14px] text-fg-muted">{clock(r.started_at)}</span>
      </div>
      <div className="mt-1 flex items-center gap-3 pl-[18px] text-[15px] text-fg-muted">
        <span className="min-w-0 flex-1 truncate">{r.caller.name}</span>
        {r.attempt_count > 1 && <span className="shrink-0">{r.attempt_count} attempts</span>}
        {r.provider && (
          <span className="inline-flex shrink-0 items-center gap-2 text-fg">
            <ProviderLogo handle={r.provider} />
            {r.provider}
          </span>
        )}
      </div>
    </div>
  );
}
