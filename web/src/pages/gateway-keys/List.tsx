import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Copy, KeyRound, MessageCircle, Plus, Settings2, Trash2, Ban } from "lucide-react";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { useChatActions } from "@/app/chat-panel";
import { PageHeader } from "@/app/PageHeader";
import { formatNumber, timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { useUrlParams } from "@/lib/url-state";
import { shortDate, shortSecret } from "@/pages/settings/format";
import { Button, IconButton } from "@/ui/Button";
import { useConfirm } from "@/ui/Confirm";
import { CopyButton, useCopy } from "@/ui/CopyButton";
import { type SortingState, DataTable, RowMenu, columnsFor } from "@/ui/DataTable";
import { Disclosure } from "@/ui/Disclosure";
import { Mono } from "@/ui/bits";
import { ToolbarSearch } from "@/ui/Input";
import { MenuItem, MenuSeparator } from "@/ui/Menu";
import { EmptyState } from "@/ui/States";
import { Tip } from "@/ui/Tooltip";
import { type GatewayKey, useGatewayKeys } from "./api";
import { SAMPLE_GATEWAY_KEYS } from "./samples";
import { useKeyQuestions } from "./confirm";
import { CreateDialog } from "./CreateDialog";
import { scopeDetail, scopeSummary } from "./scope";

// Gateway Keys (C02, C12) on the shared DataTable (UI ticket 08): name,
// readable key, access, last use and recent Requests; ?q= searches by name or
// key, ?sort=&dir= sorts. A row opens the key's page. Revoke… and Delete… ask
// first (UI ticket 21). Revoked keys fold under the table into their own.

/** Where a key's Requests of the last 24 hours are listed. */
export const requestsHref = (k: GatewayKey) => `/requests?caller=${encodeURIComponent(k.name)}&range=24h`;

const keyHref = (k: GatewayKey) => `/gateway-keys/${encodeURIComponent(k.id)}`;

type Sort = "name" | "access" | "used" | "requests";

const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
// Most recent first, then by name.
const byUse = (a: GatewayKey, b: GatewayKey) => (b.last_used_at ?? "").localeCompare(a.last_used_at ?? "") || natural(a.name, b.name);

const col = columnsFor<GatewayKey>();
const columns = col.columns([
  col.accessor("name", {
    header: "Name",
    sortFn: (a, b) => natural(a.original.name, b.original.name),
    meta: { width: "w-[24%]", className: "max-w-0 text-[15px] font-medium" },
    cell: ({ row }) => <OpenLink k={row.original} />,
  }),
  col.display({ id: "key", header: "Key", meta: { width: "w-[20%]" }, cell: ({ row }) => <SecretCell k={row.original} /> }),
  col.accessor((k) => scopeSummary(k.scope), {
    id: "access",
    header: "Access",
    sortFn: (a, b) => natural(scopeSummary(a.original.scope), scopeSummary(b.original.scope)) || natural(a.original.name, b.original.name),
    meta: { width: "w-[22%]", className: "max-w-0" },
    cell: ({ row }) => (
      <span className="block truncate" title={scopeDetail(row.original.scope)}>
        {scopeSummary(row.original.scope)}
      </span>
    ),
  }),
  col.accessor((k) => k.last_used_at ?? "", {
    id: "used",
    header: "Last used",
    sortFn: (a, b) => byUse(a.original, b.original),
    meta: { className: "whitespace-nowrap tabular" },
    cell: ({ row }) => <LastUsed k={row.original} />,
  }),
  col.accessor("recent_requests", {
    id: "requests",
    header: "Requests, 24 h",
    // The busiest first, then by name.
    sortFn: (a, b) => b.original.recent_requests - a.original.recent_requests || natural(a.original.name, b.original.name),
    meta: { align: "right" },
    cell: ({ row }) => <Recent k={row.original} />,
  }),
]);

const revokedColumns = col.columns([
  col.accessor("name", {
    header: "Name",
    sortFn: (a, b) => natural(a.original.name, b.original.name),
    meta: { width: "w-[24%]", className: "max-w-0 text-fg-muted" },
    cell: ({ row }) => <OpenLink k={row.original} />,
  }),
  col.display({
    id: "key",
    header: "Key",
    meta: { width: "w-[20%]", className: "text-fg-muted" },
    cell: ({ row }) => <Mono>{shortSecret(row.original.secret)}</Mono>,
  }),
  col.accessor((k) => k.revoked_at ?? "", {
    id: "revoked",
    header: "Revoked",
    // The newest revoke first.
    sortFn: (a, b) => (b.original.revoked_at ?? "").localeCompare(a.original.revoked_at ?? "") || natural(a.original.name, b.original.name),
    meta: { width: "w-[22%]", className: "tabular text-fg-muted" },
    cell: ({ row }) => (row.original.revoked_at ? shortDate(row.original.revoked_at) : ""),
  }),
  col.accessor((k) => k.last_used_at ?? "", {
    id: "used",
    header: "Last used",
    sortFn: (a, b) => byUse(a.original, b.original),
    meta: { className: "whitespace-nowrap tabular text-fg-muted" },
    cell: ({ row }) => <LastUsed k={row.original} />,
  }),
]);

const searchKeys = (k: GatewayKey, needle: string) => !needle || k.name.toLowerCase().includes(needle) || k.secret.toLowerCase().includes(needle);
const REVOKED_SORT: SortingState = [{ id: "revoked", desc: false }];

/** Gateway Keys (C02, C12): name, readable key, access, last use and recent Requests. */
export function KeysList() {
  const list = useGatewayKeys();
  const phone = useIsPhone();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const ask = useKeyQuestions();
  const [creating, setCreating] = useState(false);
  const { params, setParam, setSort } = useUrlParams();
  const q = params.get("q") ?? "";
  const sort = (params.get("sort") as Sort) || "name";
  const desc = params.get("dir") === "desc";

  const active = useMemo(() => list.data?.filter((k) => !k.revoked), [list.data]);
  const revoked = useMemo(() => list.data?.filter((k) => k.revoked) ?? [], [list.data]);
  const sorting = useMemo<SortingState>(() => [{ id: sort, desc }], [sort, desc]);
  const act: Actions = { onRevoke: (k) => confirm.ask(ask.revoke(k)), onDelete: (k) => confirm.ask(ask.remove(k)) };

  const newKey = (
    <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
      New key
    </Button>
  );

  return (
    <>
      <PageHeader
        title="Gateway Keys"
        description="Keys your Callers use to reach Iroha"
        actions={
          <Button variant="primary" icon={Plus} aria-label="New key" onClick={() => setCreating(true)}>
            {phone ? "New" : "New key"}
          </Button>
        }
      />

      <DataTable<GatewayKey>
        id="gateway-keys"
        label="Gateway Keys"
        columns={columns}
        data={active}
        sample={SAMPLE_GATEWAY_KEYS}
        getRowId={(k) => k.id}
        rowName={(k) => k.name}
        error={list.isError ? list.error : undefined}
        onRetry={() => void list.refetch()}
        toolbar={
          <ToolbarSearch
            placeholder="Search keys"
            aria-label="Search Gateway Keys by name or key"
            value={q}
            onChange={(e) => setParam("q", e.target.value)}
          />
        }
        search={q}
        searchFn={searchKeys}
        filterChips={q ? [{ label: `Search: ${q}`, onRemove: () => setParam("q") }] : []}
        noResultsTitle="No Gateway Keys match"
        onClearFilters={() => setParam("q")}
        sorting={sorting}
        onSortingChange={(s) => setSort(s[0]?.id ?? "name", s[0]?.desc ?? false, "name")}
        rowActions={(k) => <KeyMenu k={k} {...act} />}
        onRowClick={(k) => navigate(keyHref(k))}
        phoneRow={(k) => <KeyLine k={k} />}
        empty={
          revoked.length > 0 ? (
            <EmptyState icon={KeyRound} title="No active Gateway Keys" description="Every key is revoked. Issue a new one for each Caller." action={newKey} />
          ) : (
            <EmptyState icon={KeyRound} title="No Gateway Keys yet" description="Issue a key to each Caller, so every Request is attributed to it." action={newKey} />
          )
        }
        footer={({ shown, total }) => (shown === total ? `${total} Gateway Key${total === 1 ? "" : "s"}` : `${shown} of ${total} Gateway Keys`)}
      />

      {revoked.length > 0 && (
        <Disclosure
          className="mt-8"
          triggerClassName="text-sm"
          summary={
            <>
              Revoked keys
              <span className="ml-1 tabular">{revoked.length}</span>
            </>
          }
        >
          <div className="pt-3">
            <DataTable<GatewayKey>
              id="gateway-keys-revoked"
              label="Revoked Gateway Keys"
              columns={revokedColumns}
              data={revoked}
              sample={SAMPLE_GATEWAY_KEYS}
              getRowId={(k) => k.id}
              rowName={(k) => k.name}
              defaultSorting={REVOKED_SORT}
              rowActions={(k) => <IconButton icon={Trash2} label={`Delete ${k.name}…`} size="sm" danger onClick={() => act.onDelete(k)} />}
              phoneRow={(k) => <RevokedLine k={k} />}
            />
          </div>
        </Disclosure>
      )}

      {confirm.dialog}
      <CreateDialog open={creating} onOpenChange={setCreating} existing={list.data ?? []} />
    </>
  );
}

type Actions = { onRevoke: (k: GatewayKey) => void; onDelete: (k: GatewayKey) => void };

/** The key's name, a real link to its page (Ctrl/⌘-click opens a new tab), named "Open <name>" for the keyboard and agents. */
function OpenLink({ k }: { k: GatewayKey }) {
  return (
    <SdkButton render={<Link to={keyHref(k)} />} aria-label={`Open ${k.name}`} className="block max-w-full truncate rounded outline-none hover:underline focus-visible:underline">
      {k.name}
    </SdkButton>
  );
}

function LastUsed({ k }: { k: GatewayKey }) {
  return <span title={k.last_used_at ? new Date(k.last_used_at).toLocaleString() : undefined}>{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</span>;
}

function Recent({ k }: { k: GatewayKey }) {
  if (k.recent_requests === 0) return <span className="text-fg-muted">0</span>;
  return (
    <Tip label={`Open ${k.name}'s Requests of the last 24 hours`} type="description">
      <Link to={requestsHref(k)} className="hover:underline">
        {formatNumber(k.recent_requests)}
      </Link>
    </Tip>
  );
}

function KeyMenu({ k, onRevoke, onDelete }: { k: GatewayKey } & Actions) {
  const navigate = useNavigate();
  const chat = useChatActions();
  // "Copy key" closes the menu, so the trigger it closes back to shows the result.
  const copied = useCopy();
  return (
    <RowMenu name={k.name} copy={copied.state}>
      <MenuItem icon={Settings2} onSelect={() => navigate(keyHref(k))}>
        Open settings
      </MenuItem>
      <MenuItem icon={Copy} onSelect={() => void copied.copy(k.secret, "Gateway Key")}>
        Copy key
      </MenuItem>
      <MenuItem icon={MessageCircle} onSelect={() => chat.open({ kind: "gateway_key", gatewayKey: k.name })}>
        Test as {k.name}
      </MenuItem>
      <MenuSeparator />
      <MenuItem icon={Ban} danger onSelect={() => onRevoke(k)}>
        Revoke…
      </MenuItem>
      <MenuItem icon={Trash2} danger onSelect={() => onDelete(k)}>
        Delete…
      </MenuItem>
    </RowMenu>
  );
}

function SecretCell({ k }: { k: GatewayKey }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Mono className="text-fg-muted">{shortSecret(k.secret)}</Mono>
      {/* Shown on the row's hover, at once (row hover is instant); where nothing hovers (a tablet's table), always (row-reveal). */}
      <CopyButton icon value={k.secret} what="Gateway Key" label={`Copy ${k.name}'s key`} className="row-reveal" />
    </span>
  );
}

/** Phones: two lines per key, name and last use, then the key and its access (C31). */
function KeyLine({ k }: { k: GatewayKey }) {
  return (
    <span className="block min-w-0 flex-1">
      <span className="flex items-center justify-between gap-3">
        <span className="truncate text-[16px] font-medium">{k.name}</span>
        <span className="shrink-0 text-[15px] text-fg-muted">
          <LastUsed k={k} />
        </span>
      </span>
      <span className="mt-0.5 flex items-center justify-between gap-3 text-[14px] text-fg-muted">
        <Mono>{shortSecret(k.secret)}</Mono>
        <span className="truncate">{scopeSummary(k.scope)}</span>
      </span>
    </span>
  );
}

/** Phones: a revoked key's name and when it was revoked, then its key. */
function RevokedLine({ k }: { k: GatewayKey }) {
  return (
    <span className="block min-w-0 flex-1 text-fg-muted">
      <span className="flex items-center justify-between gap-3">
        <Link to={keyHref(k)} className="truncate text-[16px] font-medium text-fg hover:underline">
          {k.name}
        </Link>
        <span className="shrink-0 text-[14px]">{k.revoked_at ? `Revoked ${shortDate(k.revoked_at)}` : "Revoked"}</span>
      </span>
      <span className="mt-0.5 block text-[14px]">
        <Mono>{shortSecret(k.secret)}</Mono>
      </span>
    </span>
  );
}
