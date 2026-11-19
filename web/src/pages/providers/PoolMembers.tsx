import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ArrowDown, ArrowUp, ExternalLink, Layers, MessageCircle, Trash2 } from "lucide-react";
import { seg } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { formatNumber, formatPercent } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Autocomplete } from "@/ui/Autocomplete";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { useConfirm } from "@/ui/Confirm";
import { DataTable, RowMenu, columnsFor } from "@/ui/DataTable";
import { Dialog } from "@/ui/Dialog";
import { Field } from "@/ui/Input";
import { MenuItem, MenuSeparator } from "@/ui/Menu";
import { RowHandle, RowOrder } from "@/ui/RowOrder";
import { EmptyState } from "@/ui/States";
import { Skeleton } from "@/ui/Skeleton";
import { type Save, SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import type { Member, MemberInput, Pool } from "./api";
import { calls, errorText, natural, successRate, useGatewayKeys, useModelIds, useOverview, useProviders, useRefresh } from "./api";
import { ProviderTile, Select, Switch } from "./controls";
import { SAMPLE_GATEWAY_KEYS_LITE, SAMPLE_OVERVIEW, SAMPLE_POOL } from "./samples";

const inputs = (ms: Member[]): MemberInput[] => ms.map(({ provider, model, enabled }) => ({ provider, model, enabled }));

/**
 * Saves a Pool's members in a new order or state. The list stays where it
 * was changed, so the result (with Undo) shows beside the Members heading;
 * a failure there too, and the list goes back to what was saved.
 */
function useSaveMembers(pool: Pool | undefined, restore: (members: Member[]) => void): [Save, (members: Member[], what: string) => void] {
  const refresh = useRefresh();
  const saving = useSave({ refresh, describe: errorText });
  const save = (members: Member[], what: string) => {
    if (!pool) return;
    void saving.run(() => calls.updatePool(pool.name, { members: inputs(members) }), { message: what }).then((ok) => {
      if (!ok) restore(pool.members);
    });
  };
  return [saving, save];
}

/** Members (C06): who serves the Pool, in order; drag a handle (or Space and the arrows on it) or use Move up/down to reorder, switch members on or off. */
export function PoolMembersTab({ name, pool, onAdd }: { name: string; pool?: Pool; onAdd: () => void }) {
  const overview = useOverview();
  const gks = useGatewayKeys();
  const phone = useIsPhone();
  const refresh = useRefresh();
  const navigate = useNavigate();
  const chat = useChatActions();
  const confirm = useConfirm();
  const [order, setOrder] = useState<Member[]>([]);
  const [saving, saveMembers] = useSaveMembers(pool, setOrder);

  useEffect(() => setOrder(pool?.members ?? []), [pool]);

  const stats = overview.data?.pools.find((p) => p.pool === name);
  const keys = new Map(overview.data?.providers.map((p) => [p.provider, p.keys]));
  const served = new Map(stats?.served_by.map((s) => [s.provider, s]));
  const first = order[0];
  const byFirst = first && stats?.requests ? (served.get(first.provider)?.requests ?? 0) / stats.requests : undefined;
  const movedOn = first && stats ? stats.requests - (served.get(first.provider)?.requests ?? 0) - (served.get("")?.requests ?? 0) : undefined;

  const byKey = new Map(order.map((m) => [memberKey(m), m]));
  // A new order of keys (a drop, a menu's Move, an agent's move): shown at once, then saved.
  const reorder = (keys: string[], held?: string) => {
    const next = keys.map((k) => byKey.get(k)).filter((m): m is Member => !!m);
    const moved = held ?? movedKey(order.map(memberKey), keys);
    setOrder(next);
    const m = moved ? byKey.get(moved) : undefined;
    saveMembers(next, m ? `${m.provider} moved to position ${keys.indexOf(moved!) + 1}` : "Members reordered");
  };
  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const keys = order.map(memberKey);
    const [k] = keys.splice(from, 1);
    keys.splice(to, 0, k);
    reorder(keys, k);
  };
  const flip = (m: Member, on: boolean) => {
    const next = order.map((x) => (x === m ? { ...x, enabled: on } : x));
    setOrder(next);
    saveMembers(next, `${m.provider} switched ${on ? "on" : "off"}`);
  };

  // Asks first, naming the member; the row is gone afterwards, so the result (with Undo) toasts.
  const askRemove = (m: Member) =>
    confirm.ask({
      title: `Remove ${memberName(m)} from ${name}?`,
      body: `Requests for ${name} stop going to ${memberName(m)}. Undo puts it back in its place.`,
      confirmLabel: "Remove member",
      onConfirm: async () => {
        if (!pool) return;
        const next = order.filter((x) => x !== m);
        const res = await calls.updatePool(pool.name, { members: inputs(next) });
        refresh();
        // Toast: the confirm dialog has closed and the row is gone; Undo after a removal.
        notifyChange(`${m.provider} removed from ${name}`, res, { onUndone: refresh });
      },
    });

  const menu = (r: MemberRow) => (
    <RowMenu name={memberName(r)}>
      <MenuItem icon={ArrowUp} disabled={r.index === 0} onSelect={() => move(r.index, r.index - 1)}>
        Move up
      </MenuItem>
      <MenuItem icon={ArrowDown} disabled={r.index === order.length - 1} onSelect={() => move(r.index, r.index + 1)}>
        Move down
      </MenuItem>
      <MenuItem icon={MessageCircle} onSelect={() => chat.open({ kind: "model", provider: r.provider, model: r.model })}>
        Test in Chat
      </MenuItem>
      <MenuItem icon={ExternalLink} onSelect={() => navigate(`/providers/${seg(r.provider)}/keys`)}>
        Open {r.provider}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Trash2} danger onSelect={() => askRemove(r.member)}>
        Remove…
      </MenuItem>
    </RowMenu>
  );

  // The table's rows in the order shown (a dragged row's draft order while it moves), with today's numbers.
  const rowsIn = (keysShown: string[]): MemberRow[] =>
    keysShown.flatMap((k, index) => {
      const m = byKey.get(k);
      if (!m) return [];
      const s = served.get(m.provider);
      return [{ ...m, member: m, key: k, index, activeKeys: keys.get(m.provider)?.active, requests: s?.requests ?? 0, success: s ? successRate({ succeeded: s.succeeded, failed: s.requests - s.succeeded }) : undefined }];
    });
  const columns = useMemo(() => memberColumns({ pending: saving.pending, flip }), [saving.pending, order]); // eslint-disable-line react-hooks/exhaustive-deps
  // Waits for the overview too, so Active keys and Requests today arrive filled in.
  const ready = !!pool && !overview.isPending;

  return (
    <section aria-label="Members">
      {/* The numbers come from the overview: measured from the grid itself until it lands (labels stay). */}
      <Skeleton data={overview.data} sample={SAMPLE_OVERVIEW} label="Loading today's numbers">
        {() => (
          <div className="mb-9 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border md:grid-cols-4">
            <Stat label="Requests today" value={stats ? formatNumber(stats.requests) : "–"} />
            <Stat label="Served by first member" value={byFirst !== undefined ? formatPercent(byFirst) : "–"} />
            <Stat label="Moved past the first" value={movedOn !== undefined ? formatNumber(Math.max(0, movedOn)) : "–"} />
            <Stat label="Failed" value={stats ? formatNumber(stats.failed) : "–"} />
          </div>
        )}
      </Skeleton>

      <div className="flex min-h-7 flex-wrap items-center gap-x-4 gap-y-1">
        <h2 className="text-[17px] font-semibold">Members</h2>
        <SaveStatus save={saving} />
        <SaveError save={saving} />
      </div>
      <p className="mb-3 mt-1 text-[15px] text-fg-muted">
        Callers ask for {name}. Iroha tries the members top to bottom and moves on when one can't serve. {phone ? "" : "Drag a handle to reorder."}
      </p>

      <RowOrder label={`Order of ${name}'s members`} value={order.map(memberKey)} onValueChange={reorder} itemLabel={(k) => (byKey.get(k) ? memberName(byKey.get(k)!) : undefined)}>
        {({ order: shown }) => (
          <DataTable<MemberRow>
            id="pool-members"
            label={`Members of ${name}`}
            columns={columns}
            data={ready ? rowsIn(shown) : undefined}
            sample={SAMPLE_MEMBER_ROWS}
            getRowId={(r) => r.key}
            rowName={memberName}
            rowActions={menu}
            phoneRow={(r) => <MemberLine r={r} />}
            phoneActions={(r) => <Switch checked={r.enabled} label={`${r.provider} on`} pending={saving.pending} onChange={(on) => flip(r.member, on)} />}
            // The order is the point: every member on one page, so a drag reaches any place.
            paging={{ mode: "none" }}
            empty={
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
            }
          />
        )}
      </RowOrder>
      {confirm.dialog}

      <h2 className="mb-3 mt-10 text-[17px] font-semibold">Gateway Keys that can use this Pool</h2>
      <Skeleton data={gks.data} sample={SAMPLE_GATEWAY_KEYS_LITE} id={phone ? "pool-gateway-keys:phone" : "pool-gateway-keys"} label="Loading Gateway Keys">
        {(list) => {
          const keysWith = list.filter((k) => !k.scope.all && k.scope.pools?.includes(name));
          const anyAll = list.some((k) => k.scope.all);
          return (
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
          );
        }}
      </Skeleton>
    </section>
  );
}

const memberKey = (m: Pick<Member, "provider" | "model">) => `${m.provider}/${m.model}`;
const memberName = (m: Pick<Member, "provider" | "model">) => `${m.provider} (${m.model})`;

/** The one key that moved between two orders of the same keys; none when it can't be told (a swap of two neighbours). */
function movedKey(before: string[], after: string[]): string | undefined {
  const moved = after.filter((k) => {
    const a = before.filter((x) => x !== k);
    const b = after.filter((x) => x !== k);
    return before.indexOf(k) !== after.indexOf(k) && a.every((x, i) => x === b[i]);
  });
  return moved.length === 1 ? moved[0] : undefined;
}

/** A member as the table shows it: its place in the order shown and today's numbers. */
type MemberRow = Member & { member: Member; key: string; index: number; activeKeys?: number; requests: number; success?: number };

const SAMPLE_MEMBER_ROWS: MemberRow[] = SAMPLE_POOL.members.map((m, index) => ({ ...m, member: m, key: memberKey(m), index, activeKeys: 4, requests: 420, success: 0.99 }));

// The order is what counts (Iroha tries members top to bottom), so no column sorts.
const col = columnsFor<MemberRow>();
function memberColumns({ pending, flip }: { pending: boolean; flip: (m: Member, on: boolean) => void }) {
  return col.columns([
    col.display({ id: "order", header: "Order", meta: { width: "w-14", className: "tabular" }, cell: ({ row }) => row.original.index + 1 }),
    col.display({
      id: "handle",
      header: () => <span className="sr-only">Drag</span>,
      meta: { width: "w-8", label: "Drag" },
      cell: ({ row }) => <RowHandle value={row.original.key} name={memberName(row.original)} />,
    }),
    col.display({
      id: "provider",
      header: "Provider",
      cell: ({ row }) => (
        <Link to={`/providers/${seg(row.original.provider)}/keys`} className={cn("inline-flex items-center gap-2.5 text-[15px] font-medium text-fg hover:underline", !row.original.enabled && "text-fg-muted")}>
          <ProviderTile handle={row.original.provider} size={26} />
          {row.original.provider}
        </Link>
      ),
    }),
    col.display({ id: "model", header: "Model", meta: { className: "font-mono text-[13px]" }, cell: ({ row }) => row.original.model }),
    col.display({ id: "active", header: "Active keys", meta: { align: "right" }, cell: ({ row }) => (row.original.activeKeys === undefined ? "–" : formatNumber(row.original.activeKeys)) }),
    col.display({ id: "requests", header: "Requests today", meta: { align: "right" }, cell: ({ row }) => formatNumber(row.original.requests) }),
    col.display({
      id: "success",
      header: "Success",
      meta: { align: "right" },
      cell: ({ row }) => (row.original.success === undefined ? <span className="text-fg-subtle">–</span> : formatPercent(row.original.success)),
    }),
    col.display({
      id: "on",
      header: "On",
      meta: { width: "pl-6", className: "pl-6" },
      cell: ({ row }) => <Switch checked={row.original.enabled} label={`${row.original.provider} on`} pending={pending} onChange={(on) => flip(row.original.member, on)} />,
    }),
  ]);
}

/** Phones (C31): a member in two lines; Move up/down are in its menu. */
function MemberLine({ r }: { r: MemberRow }) {
  return (
    <span className={cn("flex min-w-0 flex-1 items-center gap-3", !r.enabled && "opacity-60")}>
      <span className="w-4 text-center tabular text-fg-muted">{r.index + 1}</span>
      <ProviderTile handle={r.provider} size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] font-medium">{r.provider}</span>
        <span className="block truncate font-mono text-[13px] text-fg-muted">{r.model}</span>
      </span>
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg px-5 py-4">
      <p className="text-[14px] text-fg-muted">
        {label}
      </p>
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
      // Toast: the Add member dialog closes on success.
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
