import type { ReactNode } from "react";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { ChevronRight, Layers, MessageCircle, Plus, Server } from "lucide-react";
import { useChatActions } from "@/app/chat-panel";
import { PageHeader } from "@/app/PageHeader";
import { api, isApiError, seg } from "@/api/client";
import { formatNumber, formatPercent, timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button, IconButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Dialog } from "@/ui/Dialog";
import { DataTable, columnsFor } from "@/ui/DataTable";
import { Field, Input, SearchInput } from "@/ui/Input";
import { EmptyState, ErrorState } from "@/ui/States";
import { notifyChange } from "@/ui/toast";
import type { Pool, PoolOverview, Provider, ProviderOverview, Shape } from "./api";
import { calls, errorText, natural, SHAPES, successRate, useOverview, usePools, useProviders, useRefresh } from "./api";
import { Reveal } from "@/ui/Reveal";
import { Pill, PoolTile, ProviderTile, ringRoom, Select, Switch } from "./controls";
import { SAMPLE_POOLS, SAMPLE_PROVIDERS } from "./samples";

/** /providers: every Provider, then every Model Pool (C05; phones C30). */
export function ProvidersList() {
  const providers = useProviders();
  const pools = usePools();
  const overview = useOverview();
  const phone = useIsPhone();
  const [adding, setAdding] = useState(false);
  const [pooling, setPooling] = useState(false);

  const navigate = useNavigate();
  const chat = useChatActions();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const setQ = (v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (v) n.set("q", v);
        else n.delete("q");
        return n;
      },
      { replace: true },
    );

  const stats = new Map(overview.data?.providers.map((p) => [p.provider, p]));
  const poolStats = new Map(overview.data?.pools.map((p) => [p.pool, p]));
  // Archived last, then the busiest today, then by name: the order until a column is sorted.
  const list = [...(providers.data ?? [])].sort((a, b) => Number(a.archived) - Number(b.archived) || (stats.get(b.handle)?.requests ?? 0) - (stats.get(a.handle)?.requests ?? 0) || natural(a.handle, b.handle));
  // Waits for the overview too, so the counts arrive filled in; its 15 s refetch keeps what is shown.
  const providerRows: ProviderRow[] | undefined = providers.data && !overview.isPending ? list.map((p) => ({ ...p, stats: stats.get(p.handle) })) : undefined;
  const poolRows: PoolRow[] | undefined = pools.data && !overview.isPending ? pools.data.map((p) => ({ ...p, stats: poolStats.get(p.name) })) : undefined;
  const openProvider = (p: Provider) => navigate(providerPath(p.handle));
  const openPool = (p: Pool) => navigate(poolPath(p.name));
  const testButton = (label: string, onPress: () => void) => (
    <span className="inline-flex items-center gap-1">
      {/* Shown on a row's hover or focus; always where nothing hovers (a touch tablet). */}
      <IconButton icon={MessageCircle} label={label} size="sm" className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" onClick={onPress} />
      <ChevronRight size={17} className="text-fg-muted" aria-hidden />
    </span>
  );

  return (
    <>
      <PageHeader
        title="Providers"
        description="The AI services Iroha sends requests to"
        actions={
          phone ? (
            <IconButton icon={Plus} label="Add Provider" bordered onClick={() => setAdding(true)} />
          ) : (
            <>
              <Button icon={Layers} onClick={() => setPooling(true)} disabled={!providers.data?.length}>
                New Pool
              </Button>
              <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
                Add Provider
              </Button>
            </>
          )
        }
      />

      {providers.isError ? (
        <ErrorState title="Couldn't load Providers" error={providers.error} onRetry={() => void providers.refetch()} />
      ) : providers.data && list.length === 0 ? (
        <EmptyState
          icon={Server}
          title="No Providers yet"
          description="Add a Provider and paste its Upstream Keys, and Iroha starts routing to them."
          action={
            <Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>
              Add Provider
            </Button>
          }
        />
      ) : (
        <>
          <section aria-label="Providers">
            <h2 className="mb-2 text-[17px] font-semibold">Providers</h2>
            <DataTable<ProviderRow>
              id="providers"
              label="Providers"
              columns={providerColumns}
              data={providerRows}
              sample={SAMPLE_PROVIDER_ROWS}
              getRowId={(p) => p.id}
              rowName={(p) => p.handle}
              toolbar={
                <SearchInput
                  className="min-w-0 flex-1 md:max-w-[320px] md:flex-none"
                  placeholder="Search Providers"
                  aria-label="Search Providers"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                />
              }
              search={q}
              searchFn={searchProviders}
              filterChips={q ? [{ label: `Search: ${q}`, onRemove: () => setQ("") }] : []}
              onClearFilters={() => setQ("")}
              noResultsTitle="No Providers match"
              rowActions={(p) => testButton(`Test ${p.handle} in Chat`, () => chat.open({ kind: "provider", provider: p.handle }))}
              onRowClick={openProvider}
              phoneRow={(p) => <ProviderLine p={p} />}
              footer={({ shown, total }) => (shown === total ? `${total} Provider${total === 1 ? "" : "s"}` : `${shown} of ${total} Providers`)}
            />
          </section>
          <section aria-label="Model Pools" className="mt-12">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-[17px] font-semibold">Model Pools</h2>
              {phone && (
                <Button size="sm" icon={Layers} onClick={() => setPooling(true)}>
                  New Pool
                </Button>
              )}
            </div>
            <DataTable<PoolRow>
              id="pools"
              label="Model Pools"
              columns={poolColumns}
              data={poolRows}
              sample={SAMPLE_POOL_ROWS}
              getRowId={(p) => p.id}
              rowName={(p) => p.name}
              error={pools.isError ? pools.error : undefined}
              onRetry={() => void pools.refetch()}
              rowActions={(p) => testButton(`Test ${p.name} in Chat`, () => chat.open({ kind: "pool", pool: p.name }))}
              onRowClick={openPool}
              phoneRow={(p) => <PoolLine p={p} />}
              empty={
                <p className="border-t border-border py-6 text-[15px] text-fg-muted">
                  No Model Pools. A Pool is one model name that Iroha serves from several Providers, trying the next one when a Provider can't serve.{" "}
                  <button type="button" className="text-info hover:underline" onClick={() => setPooling(true)}>
                    Make one
                  </button>
                </p>
              }
              footer={({ total }) => `${total} Model Pool${total === 1 ? "" : "s"}`}
            />
          </section>
        </>
      )}

      <AddProviderDialog open={adding} onOpenChange={setAdding} existing={list} />
      <NewPoolDialog open={pooling} onOpenChange={setPooling} providers={list.filter((p) => !p.archived)} pools={pools.data ?? []} />
    </>
  );
}

function Rate({ t }: { t?: { succeeded: number; failed: number } }) {
  const r = successRate(t);
  return <>{r === undefined ? <span className="text-fg-subtle">–</span> : formatPercent(r)}</>;
}

function ProviderName({ p }: { p: Provider }) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <ProviderTile handle={p.handle} version={p.logo_domain} size={28} />
      <span className="truncate text-[15px] font-medium">{p.handle}</span>
      {p.name && p.name !== p.handle && <span className="hidden truncate text-[14px] text-fg-muted lg:inline">{p.name}</span>}
      {p.archived ? <Pill>Archived</Pill> : !p.enabled ? <Pill>Off</Pill> : null}
    </span>
  );
}

/** A Provider with its numbers of today (`undefined` when the overview doesn't name it). */
type ProviderRow = Provider & { stats?: ProviderOverview };
/** A Model Pool with its numbers of today. */
type PoolRow = Pool & { stats?: PoolOverview };

const providerPath = (handle: string) => `/providers/${seg(handle)}/keys`;
const poolPath = (name: string) => `/providers/pools/${seg(name)}/route`;

const SAMPLE_PROVIDER_ROWS: ProviderRow[] = SAMPLE_PROVIDERS;
const SAMPLE_POOL_ROWS: PoolRow[] = SAMPLE_POOLS;

const searchProviders = (p: ProviderRow, needle: string) => !needle || p.handle.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle);

/** The page's own link around a name: a real link (new tab works), named "Open <name>" for the keyboard and agents. */
function OpenLink({ to, name, children }: { to: string; name: string; children: ReactNode }) {
  return (
    <SdkButton render={<Link to={to} />} aria-label={`Open ${name}`} className="flex min-w-0 rounded outline-none focus-visible:underline">
      {children}
    </SdkButton>
  );
}

// Numbers sort smallest first on the first press; a missing number counts as less than none.
const num = (n: number | undefined) => n ?? -1;
const byHandle = (a: ProviderRow, b: ProviderRow) => natural(a.handle, b.handle);

const pcol = columnsFor<ProviderRow>();
const providerNumber = (id: string, header: string, value: (p: ProviderRow) => number | undefined, shown?: (p: ProviderRow) => ReactNode) =>
  pcol.accessor((p) => num(value(p)), {
    id,
    header,
    sortFn: (a, b) => num(value(a.original)) - num(value(b.original)) || byHandle(a.original, b.original),
    meta: { align: "right" },
    cell: ({ row }) => shown?.(row.original) ?? (value(row.original) === undefined ? "–" : formatNumber(value(row.original) ?? 0)),
  });
const providerColumns = pcol.columns([
  pcol.accessor("handle", {
    header: "Name",
    sortFn: (a, b) => byHandle(a.original, b.original),
    cell: ({ row }) => (
      <span className={cn("block min-w-0", row.original.archived && "opacity-60")}>
        <OpenLink to={providerPath(row.original.handle)} name={row.original.handle}>
          <ProviderName p={row.original} />
        </OpenLink>
      </span>
    ),
  }),
  providerNumber("keys", "Keys", (p) => p.stats?.keys.total ?? p.upstream_key_count),
  providerNumber("active", "Active keys", (p) => p.stats?.keys.active),
  providerNumber("models", "Models", (p) => p.stats?.models),
  providerNumber("requests", "Requests today", (p) => p.stats?.requests),
  providerNumber("success", "Success", (p) => successRate(p.stats), (p) => <Rate t={p.stats} />),
  pcol.accessor((p) => p.stats?.last_request_at ?? "", {
    id: "last",
    header: "Last request",
    // Most recent first, then by name.
    sortFn: (a, b) => (b.original.stats?.last_request_at ?? "").localeCompare(a.original.stats?.last_request_at ?? "") || byHandle(a.original, b.original),
    meta: { className: "whitespace-nowrap pl-6", width: "pl-6" },
    cell: ({ row }) => (row.original.stats?.last_request_at ? timeAgo(row.original.stats.last_request_at) : <span className="text-fg-subtle">–</span>),
  }),
]);

/** Phones (C30): a Provider in two lines. */
function ProviderLine({ p }: { p: ProviderRow }) {
  const s = p.stats;
  const r = successRate(s);
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-3", p.archived && "opacity-60")}>
      <ProviderTile handle={p.handle} version={p.logo_domain} size={40} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-[16px] font-medium">{p.handle}</span>
          {p.archived ? <Pill>Archived</Pill> : !p.enabled ? <Pill>Off</Pill> : null}
        </span>
        <span className="block truncate text-[14px] text-fg-muted">
          {s ? `${formatNumber(s.keys.active)} of ${formatNumber(s.keys.total)} keys active` : `${p.upstream_key_count} keys`}
          {s && s.requests > 0 && ` · ${formatNumber(s.requests)} today`}
        </span>
      </span>
      {r !== undefined && <span className="text-[14px] tabular text-fg-muted">{formatPercent(r)}</span>}
      <ChevronRight size={17} className="text-fg-subtle" aria-hidden />
    </span>
  );
}

/** The distinct Providers a Pool's switched-on members use, in member order. */
export function servingProviders(pool: Pool): string[] {
  return [...new Set(pool.members.filter((m) => m.enabled).map((m) => m.provider))];
}

export function LogoStack({ handles, size = 22 }: { handles: string[]; size?: number }) {
  const shown = handles.slice(0, 4);
  return (
    <span className="inline-flex items-center">
      {shown.map((h, i) => (
        <span key={h} className={cn("rounded-full ring-2 ring-bg", i > 0 && "-ml-1.5")} style={{ zIndex: shown.length - i }} title={h}>
          <ProviderTile handle={h} size={size} />
        </span>
      ))}
    </span>
  );
}

function ServedBy({ pool }: { pool: Pool }) {
  const handles = servingProviders(pool);
  if (handles.length === 0) return <span className="text-fg-muted">No members on</span>;
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoStack handles={handles} />
      <span>
        {handles.length} Provider{handles.length === 1 ? "" : "s"}
      </span>
    </span>
  );
}

const byName = (a: PoolRow, b: PoolRow) => natural(a.name, b.name);
const qcol = columnsFor<PoolRow>();
const poolColumns = qcol.columns([
  qcol.accessor("name", {
    header: "Name",
    sortFn: (a, b) => byName(a.original, b.original),
    // The Providers table above has its own "Sort by Name": these names tell them apart.
    meta: { label: "Pool name" },
    cell: ({ row }) => (
      <OpenLink to={poolPath(row.original.name)} name={row.original.name}>
        <span className="flex min-w-0 items-center gap-3">
          <PoolTile name={row.original.name} version={row.original.maker} size={28} />
          <span className="truncate text-[15px] font-medium">{row.original.name}</span>
        </span>
      </OpenLink>
    ),
  }),
  qcol.accessor((p) => servingProviders(p).length, {
    id: "served",
    header: "Served by",
    sortFn: (a, b) => servingProviders(a.original).length - servingProviders(b.original).length || byName(a.original, b.original),
    meta: { width: "w-[34%]" },
    cell: ({ row }) => <ServedBy pool={row.original} />,
  }),
  qcol.accessor((p) => num(p.stats?.requests), {
    id: "requests",
    header: "Requests today",
    sortFn: (a, b) => num(a.original.stats?.requests) - num(b.original.stats?.requests) || byName(a.original, b.original),
    meta: { align: "right", label: "Pool Requests today" },
    cell: ({ row }) => (row.original.stats ? formatNumber(row.original.stats.requests) : "–"),
  }),
  qcol.accessor((p) => num(successRate(p.stats)), {
    id: "success",
    header: "Success",
    sortFn: (a, b) => num(successRate(a.original.stats)) - num(successRate(b.original.stats)) || byName(a.original, b.original),
    meta: { align: "right", label: "Pool success" },
    cell: ({ row }) => <Rate t={row.original.stats} />,
  }),
]);

/** Phones (C30): a Pool in two lines. */
function PoolLine({ p }: { p: PoolRow }) {
  const handles = servingProviders(p);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <PoolTile name={p.name} version={p.maker} size={40} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] font-medium">{p.name}</span>
        <span className="flex items-center gap-2 text-[14px] text-fg-muted">
          <LogoStack handles={handles} size={18} />
          {handles.length} Provider{handles.length === 1 ? "" : "s"}
          {p.stats && p.stats.requests > 0 && ` · ${formatNumber(p.stats.requests)} today`}
        </span>
      </span>
      <ChevronRight size={17} className="text-fg-subtle" aria-hidden />
    </span>
  );
}

function AddProviderDialog({ open, onOpenChange, existing }: { open: boolean; onOpenChange: (o: boolean) => void; existing: Provider[] }) {
  const navigate = useNavigate();
  const refresh = useRefresh();
  const [handle, setHandle] = useState("");
  const [url, setUrl] = useState("");
  const [shape, setShape] = useState<Shape>("openai-chat");
  const [keyless, setKeyless] = useState(false);
  const [error, setError] = useState<{ handle?: string; url?: string; other?: string }>({});
  const [pending, setPending] = useState(false);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setHandle("");
      setUrl("");
      setShape("openai-chat");
      setKeyless(false);
      setError({});
    }
  };

  const submit = async () => {
    const h = handle.trim();
    const u = url.trim();
    if (!h) return setError({ handle: "Give it a handle: Callers use it in model names like dashscope/qwen3-max." });
    // POST /api/providers updates a Provider that has the handle, so a taken handle is refused here.
    let taken = existing.find((p) => p.handle.toLowerCase() === h.toLowerCase());
    if (!taken) {
      try {
        taken = await api.get<Provider>(`/api/providers/${seg(h)}`);
      } catch (e) {
        if (!(isApiError(e) && e.status === 404)) return setError({ handle: errorText(e) });
      }
    }
    if (taken)
      return setError({
        handle: `${taken.handle} already exists${taken.archived ? " (archived)" : ""}. Pick another handle, or open ${taken.handle} to change it.`,
      });
    if (u && !/^https?:\/\//.test(u)) return setError({ url: "Start the URL with https:// (or http://)." });
    setPending(true);
    setError({});
    try {
      const res = await calls.createProvider({ handle: h });
      let added: string | undefined;
      if (u) {
        try {
          // Auth style none on a Provider with no keys also adds its keyless key.
          const ep = await calls.createEndpoint(h, keyless ? { url: u, shape, auth_style: "none" } : { url: u, shape });
          added = ep.keyless_key?.name;
        } catch (e) {
          // Toast: the Provider exists now, so the dialog closes and the page moves to its Endpoints;
          // the refused Endpoint's reason goes with it (the dialog that could show it is gone).
          notifyChange(`Provider ${h} added without its Endpoint: ${errorText(e)}`, res, { onUndone: refresh });
          refresh();
          navigate(`/providers/${seg(h)}/endpoints`);
          close(false);
          return;
        }
      }
      // Toast: the dialog closes and the page moves to the new Provider.
      notifyChange(added ? `Provider ${h} added, with a keyless key` : `Provider ${h} added`, res, { undoneMessage: `${h} removed`, onUndone: refresh });
      refresh();
      close(false);
      navigate(`/providers/${seg(h)}/keys`);
    } catch (e) {
      setError({ handle: errorText(e) });
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Add Provider"
      description={
        keyless && url.trim() ? "An AI service that needs no key: Iroha sends it no credential." : "An AI service with its own keys. You add its Upstream Keys next."
      }
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-provider" loading={pending}>
            Add Provider
          </Button>
        </>
      }
    >
      <form
        id="add-provider"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Handle" hint="Callers name its models as handle/model. It can't be changed later." error={error.handle}>
          {(p) => (
            <Input {...p} mono autoFocus autoComplete="off" spellCheck={false} placeholder="dashscope" value={handle} onChange={(e) => setHandle(e.target.value)} />
          )}
        </Field>
        {/* The URL's own settings open under it once there is a URL (collapse recipe); the gap above them is inside the panel. */}
        <div>
          <Field label="Endpoint URL" hint="Optional: the API's URL with its version path. You can add more Endpoints later." error={error.url}>
            {(p) => (
              <Input
                {...p}
                mono
                autoComplete="off"
                spellCheck={false}
                placeholder="https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            )}
          </Field>
          <Reveal open={!!url.trim()} label="Settings of the Endpoint URL" className={ringRoom}>
            <div className="flex flex-col gap-4 pt-4">
              <Field label="Shape" hint="The API format the URL speaks.">
                {() => <Select value={shape} onValueChange={(v) => setShape(v as Shape)} items={SHAPES} />}
              </Field>
              <label className="flex items-start gap-3 text-[15px]">
                <Switch checked={keyless} onChange={setKeyless} label="No key needed" />
                <span>
                  No key needed
                  <span className="block text-[13px] text-fg-muted">For self-hosted servers and free relays. Iroha sends no credential and adds a keyless key for you.</span>
                </span>
              </label>
            </div>
          </Reveal>
        </div>
      </form>
    </Dialog>
  );
}

function NewPoolDialog({
  open,
  onOpenChange,
  providers,
  pools,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  providers: Provider[];
  pools: Pool[];
}) {
  const navigate = useNavigate();
  const refresh = useRefresh();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setName("");
      setError(undefined);
    }
  };
  const submit = async () => {
    const n = name.trim();
    if (!n) return setError("Name it the model Callers will ask for, like glm-4.6.");
    // POST /api/pools updates a Pool of that name (and would replace its members), so a taken name is refused here.
    if (pools.some((p) => p.name === n)) return setError(`A Model Pool is already named ${n}. Pick another name, or open ${n} to change its members.`);
    setPending(true);
    try {
      if (await api.get<Pool>(`/api/pools/${seg(n)}`).then(() => true, (e) => (isApiError(e) && e.status === 404 ? false : Promise.reject(e))))
        return setError(`A Model Pool is already named ${n}. Pick another name.`);
      const res = await calls.createPool({ name: n });
      // Toast: the dialog closes and the page moves to the new Pool.
      notifyChange(`Model Pool ${n} created`, res, { undoneMessage: `${n} deleted`, onUndone: refresh });
      refresh();
      close(false);
      navigate(`/providers/pools/${seg(n)}/members?add=1`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="New Model Pool"
      description={`One model name served by several Providers. Callers ask for the Pool's name; Iroha tries its members in order.${providers.length ? "" : " Add a Provider first."}`}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="new-pool" loading={pending}>
            Create Pool
          </Button>
        </>
      }
    >
      <form
        id="new-pool"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Name" hint="The model name Callers send. You add members next." error={error}>
          {(p) => <Input {...p} mono autoFocus autoComplete="off" spellCheck={false} placeholder="glm-4.6" value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
      </form>
    </Dialog>
  );
}
