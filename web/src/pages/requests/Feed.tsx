import * as DM from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Activity, ChevronDown, Columns3, ListFilter } from "lucide-react";
import { PageHeader } from "@/app/PageHeader";
import { formatNumber, formatPercent } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button, buttonClass, IconButton } from "@/ui/Button";
import { StatusDot } from "@/ui/bits";
import { cn } from "@/ui/cn";
import { SearchInput } from "@/ui/Input";
import { MenuContent, MenuLabel, MenuSeparator } from "@/ui/Menu";
import { Chip, EmptyState, ErrorState, NoResults } from "@/ui/States";
import { Table, TableSkeleton, TBody, TD, TH, THead } from "@/ui/Table";
import type { FilterOptions, RequestRecord, Stats } from "./api";
import { useFilterOptions, useRequestFeed, useRequestStats } from "./api";
import { clock, compactNumber, failed, PoolTag, ProviderLogo, secs, shapeInOut, StatusCell, statusTone } from "./bits";
import { RequestDrawer } from "./Drawer";
import { CheckItem, ChoiceItem, SubMenu } from "./menus";
import { COLUMNS, type ColumnId, type FilterKey, RANGES, type RequestsUrl, STATUSES, useRequestsUrl } from "./url-state";

/** Requests (C03, C04, C32): stats for the current filters, the live feed, and the drawer. */
export function RequestsFeed() {
  const url = useRequestsUrl();
  const phone = useIsPhone();
  const [live, setLive] = useState(true);
  const feed = useRequestFeed(url.query, live);
  const stats = useRequestStats(url.query, live);
  const options = useFilterOptions(url.rangeInfo.since);
  const rows = feed.rows;
  const selectedRow = rows.find((r) => r.id === url.selected);

  const chips = filterChips(url);
  const visible = COLUMNS.filter((c) => !url.hidden.has(c.id));

  return (
    <>
      <PageHeader
        title="Requests"
        description={phone ? undefined : "Every call through Iroha, newest first"}
        actions={<LiveToggle live={live} onToggle={() => setLive((l) => !l)} phone={phone} />}
      />
      <StatsRow stats={stats.data} loading={stats.isPending} phone={phone} />

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

      {feed.pages.isPending ? (
        <TableSkeleton columns={phone ? ["Request", "Time"] : visible.map((c) => c.label)} rows={8} />
      ) : feed.pages.isError ? (
        <ErrorState title="Couldn't load Requests" error={feed.pages.error} onRetry={() => void feed.pages.refetch()} />
      ) : rows.length === 0 ? (
        chips.length > 0 ? (
          <NoResults title="No requests match these filters" description={noResultsLine(url)} onClear={url.clearFilters} />
        ) : (
          <Empty url={url} />
        )
      ) : (
        <>
          {phone ? (
            <PhoneList rows={rows} added={feed.added} onOpen={url.select} selected={url.selected} />
          ) : (
            <FeedTable rows={rows} added={feed.added} columns={visible.map((c) => c.id)} onOpen={url.select} selected={url.selected} />
          )}
          {feed.pages.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button loading={feed.pages.isFetchingNextPage} onClick={() => void feed.pages.fetchNextPage()}>
                Show older Requests
              </Button>
            </div>
          )}
        </>
      )}

      {url.selected && (
        <RequestDrawer
          id={url.selected}
          seed={selectedRow}
          rows={rows}
          onSelect={(id) => url.select(id)}
          onClose={() => url.select(undefined)}
        />
      )}
    </>
  );
}

function LiveToggle({ live, onToggle, phone }: { live: boolean; onToggle: () => void; phone: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={live}
      title={live ? "New Requests appear as they arrive. Click to pause." : "Paused. Click to follow new Requests again."}
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full px-3 text-[14px] transition-colors",
        phone ? (live ? "bg-success-tint font-medium text-success" : "bg-muted text-fg-muted") : "text-fg hover:bg-muted",
      )}
    >
      <StatusDot tone={live ? "green" : "gray"} />
      {live ? "Live" : "Paused"}
    </button>
  );
}

function StatsRow({ stats, loading, phone }: { stats?: Stats; loading: boolean; phone: boolean }) {
  const finished = stats ? stats.succeeded + stats.failed : 0;
  const cells: { label: string; value: string | undefined }[] = [
    { label: "Requests", value: stats && formatNumber(stats.requests) },
    { label: "Succeeded", value: stats && (finished > 0 ? formatPercent(stats.succeeded / finished) : "–") },
    ...(phone
      ? [{ label: "Median", value: stats && secs(stats.median_duration_ms) }]
      : [
          { label: "Retried", value: stats && formatNumber(stats.retried) },
          { label: "Median duration", value: stats && secs(stats.median_duration_ms) },
          { label: "Median first token", value: stats && secs(stats.median_first_byte_ms) },
          { label: "Tokens", value: stats && (stats.tokens.total > 0 ? compactNumber(stats.tokens.total) : "0") },
        ]),
  ];
  return (
    <dl
      aria-busy={loading || undefined}
      className={cn("mb-6 grid divide-x divide-border rounded-xl border border-border", phone ? "-mt-3 grid-cols-3" : "-mt-2 grid-cols-6")}
    >
      {cells.map((c) => (
        <div key={c.label} className={cn("min-w-0", phone ? "px-4 py-3" : "px-5 py-4")}>
          <dt className="truncate text-[14px] text-fg-muted">{c.label}</dt>
          <dd className={cn("mt-1 truncate font-semibold tabular tracking-tight", phone ? "text-[22px]" : "text-[26px]")}>
            {c.value ?? <span className="skeleton my-2 block h-4 w-14 rounded-full bg-muted" />}
          </dd>
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
      <DM.Root>
        <DM.Trigger asChild>
          {phone ? (
            <IconButton icon={ListFilter} label="Filter" bordered className="size-9" />
          ) : (
            <Button icon={ListFilter}>
              Filter
              {active > 0 && <span className="tabular text-fg-muted">{active}</span>}
            </Button>
          )}
        </DM.Trigger>
        <FilterMenu url={url} options={options} phone={phone} />
      </DM.Root>
      {!phone && (
        <>
          <DM.Root>
            <DM.Trigger asChild>
              <Button icon={Columns3}>Columns</Button>
            </DM.Trigger>
            <MenuContent align="start">
              <MenuLabel>Show columns</MenuLabel>
              {COLUMNS.map((c) => (
                <CheckItem key={c.id} checked={!url.hidden.has(c.id)} onChange={() => url.toggleColumn(c.id)}>
                  {c.label}
                </CheckItem>
              ))}
              {url.hidden.size > 0 && (
                <>
                  <MenuSeparator />
                  <ChoiceItem selected={false} onSelect={url.resetColumns}>
                    Show all
                  </ChoiceItem>
                </>
              )}
            </MenuContent>
          </DM.Root>
          <div className="flex-1" />
          <DM.Root>
            <DM.Trigger asChild>
              <Button className="gap-1.5">
                {url.rangeInfo.label}
                <ChevronDown size={15} className="text-fg-muted" />
              </Button>
            </DM.Trigger>
            <MenuContent>
              {RANGES.map((r) => (
                <ChoiceItem key={r.id} selected={r.id === url.range} onSelect={() => url.setRange(r.id)}>
                  {r.label}
                </ChoiceItem>
              ))}
            </MenuContent>
          </DM.Root>
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

  return (
    <MenuContent align={phone ? "end" : "start"} className="min-w-56">
      <SubMenu label="Caller" value={f.caller}>
        <ChoiceItem selected={!f.caller} onSelect={() => set("caller", undefined)}>
          Anyone
        </ChoiceItem>
        {callers.map((c) => (
          <ChoiceItem key={c.name} selected={f.caller === c.name} onSelect={() => set("caller", c.name)} count={c.requests}>
            {c.name}
          </ChoiceItem>
        ))}
        {!options && <MenuLabel>Loading…</MenuLabel>}
      </SubMenu>
      <SubMenu label="Provider or Pool" value={f.provider ?? f.pool}>
        <ChoiceItem selected={!f.provider && !f.pool} onSelect={() => url.setFilters({ provider: undefined, pool: undefined })}>
          Any
        </ChoiceItem>
        {providers.length > 0 && <MenuLabel>Providers</MenuLabel>}
        {providers.map((p) => (
          <ChoiceItem
            key={"p:" + p.name}
            selected={f.provider === p.name}
            onSelect={() => url.setFilters({ provider: p.name, pool: undefined })}
            count={p.requests}
          >
            <span className="inline-flex items-center gap-2">
              <ProviderLogo handle={p.name} size={18} />
              {p.name}
            </span>
          </ChoiceItem>
        ))}
        {pools.length > 0 && <MenuLabel>Model Pools</MenuLabel>}
        {pools.map((p) => (
          <ChoiceItem
            key={"m:" + p.name}
            selected={f.pool === p.name}
            onSelect={() => url.setFilters({ pool: p.name, provider: undefined })}
            count={p.requests}
          >
            {p.name}
          </ChoiceItem>
        ))}
      </SubMenu>
      <SubMenu label="Model" value={f.model}>
        <ChoiceItem selected={!f.model} onSelect={() => set("model", undefined)}>
          Any model
        </ChoiceItem>
        {models.map((m) => (
          <ChoiceItem key={m.name} selected={f.model === m.name} onSelect={() => set("model", m.name)} count={m.requests}>
            {m.name}
          </ChoiceItem>
        ))}
      </SubMenu>
      <SubMenu label="Status" value={STATUSES.find((s) => s.id === f.status)?.label ?? f.status}>
        <ChoiceItem selected={!f.status} onSelect={() => set("status", undefined)}>
          Any status
        </ChoiceItem>
        {STATUSES.map((s) => (
          <ChoiceItem key={s.id} selected={f.status === s.id} onSelect={() => set("status", s.id)}>
            {s.label}
          </ChoiceItem>
        ))}
      </SubMenu>
      {phone && (
        <SubMenu label="Time" value={url.rangeInfo.label}>
          {RANGES.map((r) => (
            <ChoiceItem key={r.id} selected={r.id === url.range} onSelect={() => url.setRange(r.id)}>
              {r.label}
            </ChoiceItem>
          ))}
        </SubMenu>
      )}
      {any && (
        <>
          <MenuSeparator />
          <ChoiceItem selected={false} onSelect={url.clearFilters}>
            Clear filters
          </ChoiceItem>
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

/** Fades a row in once when it arrived live. */
function useArrival<T extends HTMLElement>(isNew: boolean) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    if (!isNew || !ref.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    ref.current.animate([{ backgroundColor: "var(--info-tint)" }, { backgroundColor: "transparent" }], { duration: 1600, easing: "ease-out" });
  }, []); // only on mount: a row is new once
  return ref;
}

function FeedTable({
  rows,
  added,
  columns,
  onOpen,
  selected,
}: {
  rows: RequestRecord[];
  added: Set<string>;
  columns: ColumnId[];
  onOpen: (id: string) => void;
  selected?: string;
}) {
  return (
    <Table>
      <THead>
        <tr>
          {columns.map((id) => {
            const c = COLUMNS.find((x) => x.id === id)!;
            return (
              <TH key={id} align={"right" in c && c.right ? "right" : undefined} className="whitespace-nowrap px-2.5 first:pl-3.5 last:pr-3.5">
                {c.label}
              </TH>
            );
          })}
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <FeedRow key={r.id} r={r} isNew={added.has(r.id)} columns={columns} onOpen={onOpen} selected={selected === r.id} />
        ))}
      </TBody>
    </Table>
  );
}

const dash = <span className="text-fg-subtle">–</span>;

function FeedRow({
  r,
  isNew,
  columns,
  onOpen,
  selected,
}: {
  r: RequestRecord;
  isNew: boolean;
  columns: ColumnId[];
  onOpen: (id: string) => void;
  selected: boolean;
}) {
  const ref = useArrival<HTMLTableRowElement>(isNew);
  const bad = failed(r);
  const ok = r.state === "completed" && !bad;
  const cell = "whitespace-nowrap px-2.5 first:pl-3.5 last:pr-3.5 text-[14.5px]";
  const render: Record<ColumnId, ReactNode> = {
    time: (
      <TD key="time" mono className={cell}>
        {clock(r.started_at)}
      </TD>
    ),
    status: (
      <TD key="status" className={cell}>
        <StatusCell r={r} />
      </TD>
    ),
    caller: (
      <TD key="caller" className={cn(cell, "max-w-[200px] truncate")} title={r.caller.name}>
        {r.caller.name}
      </TD>
    ),
    model: (
      <TD key="model" className={cell}>
        <span className="inline-flex max-w-[260px] items-center gap-2">
          <span className="truncate font-medium" title={r.model}>
            {r.model || dash}
          </span>
          {r.pool && <PoolTag />}
        </span>
      </TD>
    ),
    provider: (
      <TD key="provider" className={cell}>
        {r.provider ? (
          <span className="inline-flex items-center gap-2">
            <ProviderLogo handle={r.provider} />
            {r.provider}
          </span>
        ) : (
          dash
        )}
      </TD>
    ),
    key: (
      <TD key="key" mono className={cell}>
        {r.upstream_key || "–"}
      </TD>
    ),
    shape: (
      <TD key="shape" className={cell}>
        {shapeInOut(r)}
      </TD>
    ),
    attempts: (
      <TD key="attempts" align="right" className={cn(cell, r.attempt_count > 1 && "font-semibold text-warning", r.attempt_count === 0 && "text-fg-subtle")}>
        <span title={r.attempt_count > 1 ? "Retried" : undefined}>{r.attempt_count}</span>
      </TD>
    ),
    first_token: (
      <TD key="first_token" align="right" className={cell}>
        {ok ? secs(r.first_byte_ms) : dash}
      </TD>
    ),
    duration: (
      <TD key="duration" align="right" className={cell}>
        {r.state === "in_progress" ? dash : secs(r.duration_ms)}
      </TD>
    ),
    input: (
      <TD key="input" align="right" className={cell}>
        {r.usage ? formatNumber(r.usage.input) : dash}
      </TD>
    ),
    output: (
      <TD key="output" align="right" className={cell}>
        {r.usage ? formatNumber(r.usage.output) : dash}
      </TD>
    ),
  };
  return (
    <tr
      ref={ref}
      aria-selected={selected || undefined}
      tabIndex={0}
      aria-label={`Request ${r.id}`}
      onClick={() => onOpen(r.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(r.id);
      }}
      className={cn(
        "cursor-pointer border-b border-border outline-none last:border-b-0 focus-visible:bg-subtle",
        selected ? "bg-selected" : bad ? "bg-danger-tint/60 hover:bg-danger-tint" : "hover:bg-subtle",
      )}
    >
      {columns.map((c) => render[c])}
    </tr>
  );
}

function PhoneList({
  rows,
  added,
  onOpen,
  selected,
}: {
  rows: RequestRecord[];
  added: Set<string>;
  onOpen: (id: string) => void;
  selected?: string;
}) {
  return (
    <ul className="-mx-4">
      {rows.map((r) => (
        <PhoneRow key={r.id} r={r} isNew={added.has(r.id)} onOpen={onOpen} selected={selected === r.id} />
      ))}
    </ul>
  );
}

function PhoneRow({ r, isNew, onOpen, selected }: { r: RequestRecord; isNew: boolean; onOpen: (id: string) => void; selected: boolean }) {
  const ref = useArrival<HTMLLIElement>(isNew);
  const bad = failed(r);
  const tone = statusTone(r.status, r.state);
  return (
    <li ref={ref} className={cn(bad && "bg-danger-tint/60", selected && "bg-selected")}>
      <button type="button" onClick={() => onOpen(r.id)} className="block w-full px-4 py-3 text-left">
        <div className="flex items-center gap-2.5">
          <StatusDot tone={tone} />
          <span
            className={cn(
              "shrink-0 text-[16px] font-medium tabular",
              tone === "red" && "text-danger-text",
              tone === "amber" && "text-warning",
            )}
          >
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
      </button>
    </li>
  );
}
