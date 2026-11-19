import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRight, Layers, MessageCircle, Plus, Server } from "lucide-react";
import { useChatPanel } from "@/app/chat-panel";
import { PageHeader } from "@/app/PageHeader";
import { api, isApiError, seg } from "@/api/client";
import { formatNumber, formatPercent, timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button, IconButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Dialog } from "@/ui/Dialog";
import { Field, Input } from "@/ui/Input";
import { EmptyState, ErrorState } from "@/ui/States";
import { Skeleton } from "@/ui/Skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/ui/Table";
import { notifyChange } from "@/ui/toast";
import type { Pool, PoolOverview, Provider, ProviderOverview, Shape } from "./api";
import { calls, errorText, natural, SHAPES, successRate, useOverview, usePools, useProviders, useRefresh } from "./api";
import { Pill, PoolTile, ProviderTile, Select, Switch } from "./controls";
import { SAMPLE_POOLS, SAMPLE_PROVIDERS } from "./samples";

/** /providers: every Provider, then every Model Pool (C05; phones C30). */
export function ProvidersList() {
  const providers = useProviders();
  const pools = usePools();
  const overview = useOverview();
  const phone = useIsPhone();
  const [adding, setAdding] = useState(false);
  const [pooling, setPooling] = useState(false);

  const stats = new Map(overview.data?.providers.map((p) => [p.provider, p]));
  const poolStats = new Map(overview.data?.pools.map((p) => [p.pool, p]));
  const list = [...(providers.data ?? [])].sort((a, b) => Number(a.archived) - Number(b.archived) || (stats.get(b.handle)?.requests ?? 0) - (stats.get(a.handle)?.requests ?? 0) || natural(a.handle, b.handle));

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
            {/* Waits for the overview too, so the counts arrive filled in; its 15 s refetch keeps what is shown. */}
            <Skeleton
              data={providers.data && !overview.isPending ? list : undefined}
              sample={SAMPLE_PROVIDERS}
              id={phone ? "providers-list:phone" : "providers-list"}
              label="Loading Providers"
            >
              {(list) => (phone ? <ProviderCards list={list} stats={stats} /> : <ProviderTable list={list} stats={stats} />)}
            </Skeleton>
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
            {pools.isError ? (
              <ErrorState title="Couldn't load Model Pools" error={pools.error} onRetry={() => void pools.refetch()} />
            ) : (
              <Skeleton
                data={overview.isPending ? undefined : pools.data}
                sample={SAMPLE_POOLS}
                id={phone ? "pools-list:phone" : "pools-list"}
                label="Loading Model Pools"
              >
            {(pools) => pools.length === 0 ? (
              <p className="border-t border-border py-6 text-[15px] text-fg-muted">
                No Model Pools. A Pool is one model name that Iroha serves from several Providers, trying the next one when a Provider can't serve.{" "}
                <button type="button" className="text-info hover:underline" onClick={() => setPooling(true)}>
                  Make one
                </button>
              </p>
            ) : phone ? (
              <PoolCards pools={pools} stats={poolStats} />
            ) : (
              <PoolTable pools={pools} stats={poolStats} />
            )}
              </Skeleton>
            )}
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

function ProviderTable({ list, stats }: { list: Provider[]; stats: Map<string, ProviderOverview> }) {
  const navigate = useNavigate();
  const chat = useChatPanel();
  return (
    <Table>
      <THead>
        <tr>
          <TH>Name</TH>
          <TH align="right">Keys</TH>
          <TH align="right">Active keys</TH>
          <TH align="right">Models</TH>
          <TH align="right">Requests today</TH>
          <TH align="right">Success</TH>
          <TH className="pl-6">Last request</TH>
          <TH className="w-20">
            <span className="sr-only">Actions</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {list.map((p) => {
          const s = stats.get(p.handle);
          return (
            <TR key={p.id} interactive className={cn("group", p.archived && "opacity-60")} onClick={() => navigate(`/providers/${seg(p.handle)}/keys`)}>
              <TD>
                <Link to={`/providers/${seg(p.handle)}/keys`} onClick={(e) => e.stopPropagation()} className="block min-w-0">
                  <ProviderName p={p} />
                </Link>
              </TD>
              <TD align="right">{formatNumber(s?.keys.total ?? p.upstream_key_count)}</TD>
              <TD align="right">{s ? formatNumber(s.keys.active) : "–"}</TD>
              <TD align="right">{s ? formatNumber(s.models) : "–"}</TD>
              <TD align="right">{s ? formatNumber(s.requests) : "–"}</TD>
              <TD align="right">
                <Rate t={s} />
              </TD>
              <TD className="whitespace-nowrap pl-6">{s?.last_request_at ? timeAgo(s.last_request_at) : <span className="text-fg-subtle">–</span>}</TD>
              <TD align="right">
                <span className="inline-flex items-center gap-1">
                  <IconButton
                    icon={MessageCircle}
                    label={`Test ${p.handle} in Chat`}
                    size="sm"
                    className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      chat.open({ kind: "provider", provider: p.handle });
                    }}
                  />
                  <ChevronRight size={17} className="text-fg-muted" />
                </span>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

function ProviderCards({ list, stats }: { list: Provider[]; stats: Map<string, ProviderOverview> }) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {list.map((p) => {
        const s = stats.get(p.handle);
        const r = successRate(s);
        return (
          <li key={p.id}>
            <Link to={`/providers/${seg(p.handle)}/keys`} className={cn("flex items-center gap-3 py-3", p.archived && "opacity-60")}>
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
              <ChevronRight size={17} className="text-fg-subtle" />
            </Link>
          </li>
        );
      })}
    </ul>
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

function PoolTable({ pools, stats }: { pools: Pool[]; stats: Map<string, PoolOverview> }) {
  const navigate = useNavigate();
  const chat = useChatPanel();
  return (
    <Table>
      <THead>
        <tr>
          <TH>Name</TH>
          <TH>Served by</TH>
          <TH align="right">Requests today</TH>
          <TH align="right">Success</TH>
          <TH className="w-20">
            <span className="sr-only">Actions</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {pools.map((p) => {
          const s = stats.get(p.name);
          return (
            <TR key={p.id} interactive className="group" onClick={() => navigate(`/providers/pools/${seg(p.name)}/route`)}>
              <TD>
                <Link to={`/providers/pools/${seg(p.name)}/route`} onClick={(e) => e.stopPropagation()} className="flex min-w-0 items-center gap-3">
                  <PoolTile name={p.name} version={p.maker} size={28} />
                  <span className="truncate text-[15px] font-medium">{p.name}</span>
                </Link>
              </TD>
              <TD className="w-[34%]">
                <ServedBy pool={p} />
              </TD>
              <TD align="right">{s ? formatNumber(s.requests) : "–"}</TD>
              <TD align="right">
                <Rate t={s} />
              </TD>
              <TD align="right">
                <span className="inline-flex items-center gap-1">
                  <IconButton
                    icon={MessageCircle}
                    label={`Test ${p.name} in Chat`}
                    size="sm"
                    className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      chat.open({ kind: "pool", pool: p.name });
                    }}
                  />
                  <ChevronRight size={17} className="text-fg-muted" />
                </span>
              </TD>
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}

function PoolCards({ pools, stats }: { pools: Pool[]; stats: Map<string, PoolOverview> }) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {pools.map((p) => {
        const s = stats.get(p.name);
        const handles = servingProviders(p);
        return (
          <li key={p.id}>
            <Link to={`/providers/pools/${seg(p.name)}/route`} className="flex items-center gap-3 py-3">
              <PoolTile name={p.name} version={p.maker} size={40} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-medium">{p.name}</span>
                <span className="flex items-center gap-2 text-[14px] text-fg-muted">
                  <LogoStack handles={handles} size={18} />
                  {handles.length} Provider{handles.length === 1 ? "" : "s"}
                  {s && s.requests > 0 && ` · ${formatNumber(s.requests)} today`}
                </span>
              </span>
              <ChevronRight size={17} className="text-fg-subtle" />
            </Link>
          </li>
        );
      })}
    </ul>
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
        {url.trim() && (
          <Field label="Shape" hint="The API format the URL speaks.">
            {() => <Select value={shape} onValueChange={(v) => setShape(v as Shape)} items={SHAPES} />}
          </Field>
        )}
        {url.trim() && (
          <label className="flex items-start gap-3 text-[15px]">
            <Switch checked={keyless} onChange={setKeyless} label="No key needed" />
            <span>
              No key needed
              <span className="block text-[13px] text-fg-muted">For self-hosted servers and free relays. Iroha sends no credential and adds a keyless key for you.</span>
            </span>
          </label>
        )}
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
