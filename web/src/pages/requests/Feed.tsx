import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { Activity, ChevronDown, Columns3, ListFilter } from "lucide-react";
import { PageHeader } from "@/app/PageHeader";
import { formatNumber, formatPercent } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button, buttonClass } from "@/ui/Button";
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
import { SAMPLE_CALLERS, SAMPLE_REQUESTS, SAMPLE_STATS } from "./samples";
import { clock, compactNumber, failed, PoolTag, ProviderLogo, secs, shapeInOut, StatusCell, statusTone } from "./bits";
import { useLendRequestRows } from "@/sheets/stack";
import { useArrivals } from "./arrivals";
import { rec, RecordLink } from "@/sheets/RecordLink";
import { COLUMNS, type ColumnId, type FilterKey, RANGES, type RequestsUrl, STATUSES, useRequestsUrl } from "./url-state";

/**
 * How the feed pages. "live" (spec "Pagination"): new Requests come in on top and
 * older ones load as you scroll. "pages": numbered pages with a page size, if the
 * Owner prefers them (live rows then push the rows down a page).
 */
export type FeedPaging = "live" | "pages";
export const FEED_PAGING: FeedPaging = "live";

/** Requests (C03, C04, C32): stats for the current filters and the live feed on the DataTable; a row opens the Request sheet. */
export function RequestsFeed({ paging = FEED_PAGING }: { paging?: FeedPaging }) {
  const url = useRequestsUrl();
  const phone = useIsPhone();
  const [live, setLive] = useState(true);
  const feed = useRequestFeed(url.query, live);
  const stats = useRequestStats(url.query, live);
  const options = useFilterOptions(url.rangeInfo.since);
  const pages = feed.pages;
  const rows = feed.rows;
  const loaded = pages.data ? rows : undefined;
  // The Request sheet (the first of the sheet stack) seeds from these rows and steps through them.
  useLendRequestRows(rows);

  const chips = filterChips(url);
  const columns = useMemo(() => feedColumns(url.hidden), [url.hidden]);
  const columnVisibility = useMemo(() => Object.fromEntries([...url.hidden].map((id) => [id, false])), [url.hidden]);
  const loadOlder = () => void pages.fetchNextPage();

  // Stepping (↓) onto the last loaded row loads the older ones, so ↓ keeps going.
  const last = rows[rows.length - 1]?.id;
  useEffect(() => {
    if (url.selected && url.selected === last && pages.hasNextPage && !pages.isFetchingNextPage) loadOlder();
  }, [url.selected, last, pages.hasNextPage]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Requests that arrived live enter and flash once (arrivals.ts).
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

      <Toolbar url={url} options={options.data} phone={phone} />
      {chips.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {chips.map((c, i) => (
            <Chip key={i} {...c} />
          ))}
          <button type="button" onClick={url.clearFilters} className="ml-1 text-[13px] text-fg-muted hover:text-fg">
            Clear filters
          </button>
        </div>
      )}

      {/* A filter change keeps the rows shown (dimmed) until the new ones arrive: no skeleton over data. */}
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
          noResults={<NoResults title="No Requests match these filters" description={noResultsLine(url)} onClear={url.clearFilters} />}
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

/** "Showing 200 of 12,840 Requests" while older ones are still to load; "12,840 Requests" once all are. */
function countLine(shown: number, total: number | undefined, numbered: boolean): string {
  const of = total ?? shown;
  const noun = of === 1 ? "Request" : "Requests";
  if (numbered || shown >= of) return `${formatNumber(of)} ${noun}`;
  return `Showing ${formatNumber(shown)} of ${formatNumber(of)} ${noun}`;
}

type FeedPages = ReturnType<typeof useRequestFeed>["pages"];

/**
 * Numbered pages over the feed: the API pages by cursor (`before`), so a page
 * further on loads the older Requests it needs first; the rows shown stay (dimmed)
 * until it has them. Null in live mode.
 */
function useNumberedPages(on: boolean, loaded: RequestRecord[] | undefined, pages: FeedPages, total: number | undefined, query: string) {
  const [pagination, setPagination] = useTablePaging("requests");
  // New filters start again on page 1.
  const lastQuery = useRef(query);
  useEffect(() => {
    if (lastQuery.current === query) return;
    lastQuery.current = query;
    setPagination((p) => ({ ...p, pageIndex: 0 }));
  }, [query, setPagination]);

  const start = pagination.pageIndex * pagination.pageSize;
  const end = start + pagination.pageSize;
  const waiting = on && !!loaded && loaded.length < end && !!pages.hasNextPage;
  useEffect(() => {
    if (waiting && !pages.isFetchingNextPage) void pages.fetchNextPage();
  }, [waiting, pages.isFetchingNextPage]); // eslint-disable-line react-hooks/exhaustive-deps

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
      <button
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
      </button>
    </Tip>
  );
}

function StatsRow({ stats, phone }: { stats: Stats; phone: boolean }) {
  const finished = stats.succeeded + stats.failed;
  const cells: { label: string; value: string }[] = [
    { label: "Requests", value: formatNumber(stats.requests) },
    { label: "Succeeded", value: finished > 0 ? formatPercent(stats.succeeded / finished) : "–" },
    ...(phone
      ? [{ label: "Median", value: secs(stats.median_duration_ms) }]
      : [
          { label: "Retried", value: formatNumber(stats.retried) },
          { label: "Median duration", value: secs(stats.median_duration_ms) },
          { label: "Median first token", value: secs(stats.median_first_byte_ms) },
          { label: "Tokens", value: stats.tokens.total > 0 ? compactNumber(stats.tokens.total) : "0" },
        ]),
  ];
  return (
    <dl className={cn("mb-6 grid divide-x divide-border rounded-xl border border-border", phone ? "-mt-3 grid-cols-3" : "-mt-2 grid-cols-6")}>
      {cells.map((c) => (
        <div key={c.label} className={cn("min-w-0", phone ? "px-4 py-3" : "px-5 py-4")}>
          <dt className="truncate text-[14px] text-fg-muted">
            {c.label}
          </dt>
          <dd className={cn("mt-1 truncate font-semibold tabular tracking-tight", phone ? "text-[22px]" : "text-[26px]")}>{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Toolbar({ url, options, phone }: { url: RequestsUrl; options?: FilterOptions; phone: boolean }) {
  const [text, setText] = useState(url.filters.q ?? "");
  const q = useDebounced(text.trim(), 250);
  useEffect(() => {
    if (q !== (url.filters.q ?? "")) url.setFilter("q", q || undefined);
  }, [q]); // only when the typed text settles
  // Clearing filters elsewhere (chips, Clear filters) empties the box.
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
        <FilterMenu url={url} options={options} phone={phone} />
      </Menu>
      {!phone && (
        <>
          <Menu>
            <MenuTrigger className={buttonClass()}>
              <Columns3 size={16} aria-hidden className="shrink-0" />
              Columns
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

function FilterMenu({ url, options, phone }: { url: RequestsUrl; options?: FilterOptions; phone: boolean }) {
  const f = url.filters;
  const withCurrent = <T extends { name: string }>(list: T[] | undefined, current?: string): { name: string; requests?: number }[] => {
    const l: { name: string; requests?: number }[] = list ?? [];
    return current && !l.some((o) => o.name === current) ? [{ name: current }, ...l] : l;
  };
  const callers = withCurrent(options?.callers, f.caller);
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
      <SubMenu label="Caller" value={f.caller}>
        <MenuRadioGroup value={f.caller ?? ""} onValueChange={(v) => set("caller", v || undefined)}>
          <MenuRadioItem value="">Anyone</MenuRadioItem>
          {callers.map((c) => (
            <MenuRadioItem key={c.name} value={c.name} count={c.requests}>
              {c.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
        {!options && (
          // Rows shaped like the Callers, outside the group so they never take focus.
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
      {any && (
        <>
          <MenuSeparator />
          <MenuItem onSelect={url.clearFilters}>Clear filters</MenuItem>
        </>
      )}
    </MenuContent>
  );
}

function filterChips(url: RequestsUrl) {
  const f = url.filters;
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

/** "Nothing from Test (as zeron-fleet) failed in the last 24 hours." */
function noResultsLine(url: RequestsUrl): string {
  const f = url.filters;
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

/** What each column shows; one fact per cell. */
const cells: Record<ColumnId, (r: RequestRecord) => ReactNode> = {
  time: (r) => clock(r.started_at),
  status: (r) => <StatusCell r={r} />,
  // Names of records are links to their sheets (UI ticket 11); a click on one opens it, not the Request.
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
      {/* A Pool is named by the model the Caller asked for. */}
      {r.pool ? (
        <RecordLink record={rec.pool(r.pool)} className="font-medium" title={r.model}>
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

// The column whose cell is the row's "Open Request <id>" button (keyboard, agents): the first one shown that holds plain text
// (never one with a record's link in it: a link can't sit inside a button).
const OPENERS: ColumnId[] = ["time", "status", "shape", "duration", "first_token", "attempts", "input", "output"];

/** The feed's columns; `hidden` (the URL's ?hide=) only moves the Open button to a column still shown. */
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

/** A Request on a phone (C32): status, model and time; then the Caller, retries and the Provider. */
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
