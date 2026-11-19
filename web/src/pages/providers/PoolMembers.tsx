import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowDown, ArrowUp, ExternalLink, GripVertical, Layers, MoreHorizontal, Trash2 } from "lucide-react";
import { seg } from "@/api/client";
import { formatNumber, formatPercent } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Autocomplete } from "@/ui/Autocomplete";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { ConfirmDialog, Dialog } from "@/ui/Dialog";
import { Field } from "@/ui/Input";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuIconTrigger } from "@/ui/Menu";
import { EmptyState } from "@/ui/States";
import { Table, TableSkeleton, TBody, TD, TH, THead, TR } from "@/ui/Table";
import { notify, notifyChange } from "@/ui/toast";
import type { Member, MemberInput, Pool } from "./api";
import { calls, errorText, natural, successRate, useGatewayKeys, useModelIds, useOverview, useProviders, useRefresh } from "./api";
import { ProviderTile, Select, Switch } from "./controls";

const inputs = (ms: Member[]): MemberInput[] => ms.map(({ provider, model, enabled }) => ({ provider, model, enabled }));

/** Saves a Pool's members in a new order or state, with Undo. */
function useSaveMembers(pool?: Pool) {
  const refresh = useRefresh();
  return async (members: Member[], what: string) => {
    if (!pool) return;
    try {
      const res = await calls.updatePool(pool.name, { members: inputs(members) });
      refresh();
      notifyChange(what, res, { onUndone: refresh });
    } catch (e) {
      refresh();
      notify.failure(`Couldn't change ${pool.name}`, e);
    }
  };
}

/** Members (C06): who serves the Pool, in order; drag or move to reorder, switch members on or off. */
export function PoolMembersTab({ name, pool, onAdd }: { name: string; pool?: Pool; onAdd: () => void }) {
  const overview = useOverview();
  const gks = useGatewayKeys();
  const phone = useIsPhone();
  const saveMembers = useSaveMembers(pool);
  const refresh = useRefresh();
  const navigate = useNavigate();
  const [order, setOrder] = useState<Member[]>([]);
  const [dragging, setDragging] = useState<number>();
  const [removing, setRemoving] = useState<Member>();

  useEffect(() => setOrder(pool?.members ?? []), [pool]);

  const stats = overview.data?.pools.find((p) => p.pool === name);
  const keys = new Map(overview.data?.providers.map((p) => [p.provider, p.keys]));
  const served = new Map(stats?.served_by.map((s) => [s.provider, s]));
  const first = order[0];
  const byFirst = first && stats?.requests ? (served.get(first.provider)?.requests ?? 0) / stats.requests : undefined;
  const movedOn = first && stats ? stats.requests - (served.get(first.provider)?.requests ?? 0) - (served.get("")?.requests ?? 0) : undefined;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    setOrder(next);
    void saveMembers(next, `${m.provider} moved to position ${to + 1}`);
  };
  const flip = (i: number, on: boolean) => {
    const next = order.map((m, j) => (j === i ? { ...m, enabled: on } : m));
    setOrder(next);
    void saveMembers(next, `${order[i].provider} switched ${on ? "on" : "off"} in ${name}`);
  };

  const keysWith = (gks.data ?? []).filter((k) => !k.scope.all && k.scope.pools?.includes(name));
  const anyAll = (gks.data ?? []).some((k) => k.scope.all);

  const menu = (m: Member, i: number) => (
    <Menu>
      <MenuIconTrigger icon={MoreHorizontal} label={`More for member ${i + 1}`} size="sm" />
      <MenuContent>
        <MenuItem icon={ArrowUp} disabled={i === 0} onSelect={() => move(i, i - 1)}>
          Move up
        </MenuItem>
        <MenuItem icon={ArrowDown} disabled={i === order.length - 1} onSelect={() => move(i, i + 1)}>
          Move down
        </MenuItem>
        <MenuItem icon={ExternalLink} onSelect={() => navigate(`/providers/${seg(m.provider)}/keys`)}>
          Open {m.provider}
        </MenuItem>
        <MenuSeparator />
        <MenuItem icon={Trash2} danger onSelect={() => setRemoving(m)}>
          Remove…
        </MenuItem>
      </MenuContent>
    </Menu>
  );

  return (
    <section aria-label="Members">
      <div className="mb-9 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
        <Stat label="Requests today" value={stats ? formatNumber(stats.requests) : "–"} />
        <Stat label="Served by first member" value={byFirst !== undefined ? formatPercent(byFirst) : "–"} />
        <Stat label="Moved past the first" value={movedOn !== undefined ? formatNumber(Math.max(0, movedOn)) : "–"} />
        <Stat label="Failed" value={stats ? formatNumber(stats.failed) : "–"} />
      </div>

      <h2 className="text-[17px] font-semibold">Members</h2>
      <p className="mb-3 mt-1 text-[15px] text-fg-muted">
        Callers ask for {name}. Iroha tries the members top to bottom and moves on when one can't serve. {phone ? "" : "Drag to reorder."}
      </p>

      {!pool ? (
        <TableSkeleton columns={["Order", "Provider", "Model", "Active keys"]} rows={3} />
      ) : order.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No members yet"
          description={`Add the Providers that serve ${name}, each with the model ID it uses.`}
          action={
            <Button variant="primary" onClick={onAdd}>
              Add member
            </Button>
          }
        />
      ) : phone ? (
        <ul className="divide-y divide-border border-y border-border">
          {order.map((m, i) => (
            <li key={`${m.provider}/${m.model}`} className={cn("flex items-center gap-3 py-3", !m.enabled && "opacity-60")}>
              <span className="w-4 text-center tabular text-fg-muted">{i + 1}</span>
              <ProviderTile handle={m.provider} size={32} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[16px] font-medium">{m.provider}</span>
                <span className="block truncate font-mono text-[13px] text-fg-muted">{m.model}</span>
              </span>
              <Switch checked={m.enabled} label={`${m.provider} on`} onChange={(on) => flip(i, on)} />
              {menu(m, i)}
            </li>
          ))}
        </ul>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH className="w-14">Order</TH>
              <TH className="w-8">
                <span className="sr-only">Drag</span>
              </TH>
              <TH>Provider</TH>
              <TH>Model</TH>
              <TH align="right">Active keys</TH>
              <TH align="right">Requests today</TH>
              <TH align="right">Success</TH>
              <TH className="pl-6">On</TH>
              <TH className="w-10">
                <span className="sr-only">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {order.map((m, i) => {
              const s = served.get(m.provider);
              const k = keys.get(m.provider);
              const r = s ? successRate({ succeeded: s.succeeded, failed: s.requests - s.succeeded }) : undefined;
              return (
                <TR
                  key={`${m.provider}/${m.model}`}
                  draggable
                  onDragStart={(e) => {
                    setDragging(i);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    if (dragging === undefined) return;
                    e.preventDefault();
                    if (dragging !== i) {
                      const next = [...order];
                      const [x] = next.splice(dragging, 1);
                      next.splice(i, 0, x);
                      setOrder(next);
                      setDragging(i);
                    }
                  }}
                  onDragEnd={() => {
                    setDragging(undefined);
                    const before = pool.members.map((x) => `${x.provider}/${x.model}`).join();
                    if (order.map((x) => `${x.provider}/${x.model}`).join() !== before) void saveMembers(order, `Members of ${name} reordered`);
                  }}
                  className={cn("group", dragging === i && "bg-subtle", !m.enabled && "text-fg-muted")}
                >
                  <TD className="tabular">{i + 1}</TD>
                  <TD>
                    <GripVertical size={16} className="cursor-grab text-fg-subtle group-hover:text-fg-muted" aria-hidden />
                  </TD>
                  <TD>
                    <Link to={`/providers/${seg(m.provider)}/keys`} className="inline-flex items-center gap-2.5 text-[15px] font-medium text-fg hover:underline">
                      <ProviderTile handle={m.provider} size={26} />
                      {m.provider}
                    </Link>
                  </TD>
                  <TD mono>{m.model}</TD>
                  <TD align="right">{k ? formatNumber(k.active) : "–"}</TD>
                  <TD align="right">{formatNumber(s?.requests ?? 0)}</TD>
                  <TD align="right">{r === undefined ? <span className="text-fg-subtle">–</span> : formatPercent(r)}</TD>
                  <TD className="pl-6">
                    <Switch checked={m.enabled} label={`${m.provider} on`} onChange={(on) => flip(i, on)} />
                  </TD>
                  <TD align="right">{menu(m, i)}</TD>
                </TR>
              );
            })}
          </TBody>
        </Table>
      )}

      <h2 className="mb-3 mt-10 text-[17px] font-semibold">Gateway Keys that can use this Pool</h2>
      <div className="flex flex-wrap items-center gap-2">
        {keysWith.sort((a, b) => natural(a.name, b.name)).map((k) => (
          <Link key={k.id} to={`/gateway-keys/${seg(k.id)}`} className="inline-flex h-9 items-center rounded-lg border border-border px-3 text-[15px] hover:bg-muted">
            {k.name}
          </Link>
        ))}
        <span className="text-[15px] text-fg-muted">
          {anyAll ? (keysWith.length ? "and every key with access to everything" : "Every key with access to everything") : keysWith.length ? "" : "None yet. Give a Gateway Key this Pool in its scope."}
        </span>
      </div>

      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(undefined)}
        title={`Remove ${removing?.provider} from ${name}?`}
        body={`Requests for ${name} stop going to ${removing?.provider} (${removing?.model}). Undo puts it back in its place.`}
        confirmLabel="Remove member"
        onConfirm={async () => {
          if (!removing || !pool) return;
          const next = order.filter((m) => m !== removing);
          const res = await calls.updatePool(pool.name, { members: inputs(next) });
          refresh();
          notifyChange(`${removing.provider} removed from ${name}`, res, { onUndone: refresh });
        }}
      />
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg px-5 py-4">
      <p className="text-[14px] text-fg-muted">{label}</p>
      <p className="mt-1 text-[26px] font-semibold tabular leading-tight">{value}</p>
    </div>
  );
}

export function AddMemberDialog({ pool, open, onOpenChange }: { pool: Pool; open: boolean; onOpenChange: (o: boolean) => void }) {
  const providers = useProviders();
  const refresh = useRefresh();
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const ids = useModelIds(provider || undefined);
  const choices = (providers.data ?? []).filter((p) => !p.archived).sort((a, b) => natural(a.handle, b.handle));

  useEffect(() => {
    if (open && !provider && choices.length) setProvider(choices[0].handle);
    if (open && !model) setModel(pool.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, choices.length]);

  const close = (o: boolean) => {
    onOpenChange(o);
    if (!o) {
      setProvider("");
      setModel("");
      setError(undefined);
    }
  };
  const submit = async () => {
    if (!provider) return setError("Pick the Provider that serves it.");
    if (!model.trim()) return setError("Type the model ID that Provider uses for it.");
    setPending(true);
    try {
      const res = await calls.updatePool(pool.name, { members: [...inputs(pool.members), { provider, model: model.trim(), enabled: true }] });
      refresh();
      notifyChange(`${provider} added to ${pool.name}`, res, { onUndone: refresh });
      close(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };
  const known = ids.data;
  const offered = !known || !model.trim() || known.includes(model.trim());

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={`Add a member to ${pool.name}`}
      description="It goes last; reorder members afterwards."
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" type="submit" form="add-member" loading={pending} disabled={!choices.length}>
            Add member
          </Button>
        </>
      }
    >
      <form
        id="add-member"
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label="Provider">
          {() => <Select value={provider} onValueChange={setProvider} items={choices.map((c) => ({ value: c.handle, label: c.handle }))} />}
        </Field>
        <Field
          label="Model"
          hint={offered ? "The model ID as this Provider names it." : `${provider}'s model list doesn't name it; it is still tried unless the Provider is strict.`}
          error={error}
        >
          {() => <Autocomplete mono value={model} onValueChange={setModel} items={known ?? []} />}
        </Field>
      </form>
    </Dialog>
  );
}
