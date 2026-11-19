import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronRight, Copy, KeyRound, MessageCircle, MoreHorizontal, Plus, Settings2, Trash2, Ban } from "lucide-react";
import { useChatPanel } from "@/app/chat-panel";
import { PageHeader } from "@/app/PageHeader";
import { formatNumber, timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { copyText, shortDate, shortSecret } from "@/pages/settings/format";
import { Button, IconButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Mono } from "@/ui/bits";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuIconTrigger } from "@/ui/Menu";
import { EmptyState, ErrorState } from "@/ui/States";
import { Tip } from "@/ui/Tooltip";
import { Skeleton } from "@/ui/Skeleton";
import { Table, TBody, TD, TH, THead, TR } from "@/ui/Table";
import { type GatewayKey, useGatewayKeys } from "./api";
import { SAMPLE_GATEWAY_KEYS } from "./samples";
import { DeleteDialog, RevokeDialog } from "./confirm";
import { CreateDialog } from "./CreateDialog";
import { scopeDetail, scopeSummary } from "./scope";

/** Where a key's Requests of the last 24 hours are listed. */
export const requestsHref = (k: GatewayKey) => `/requests?caller=${encodeURIComponent(k.name)}&range=24h`;

/** Gateway Keys (C02, C12): name, readable key, access, last use and recent Requests. */
export function KeysList() {
  const list = useGatewayKeys();
  const phone = useIsPhone();
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<GatewayKey>();
  const [deleting, setDeleting] = useState<GatewayKey>();
  const [showRevoked, setShowRevoked] = useState(false);

  const act = { onRevoke: setRevoking, onDelete: setDeleting };

  return (
    <>
      <PageHeader
        title="Gateway Keys"
        description="Keys your Callers use to reach Iroha"
        actions={
          <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
            {phone ? "New" : "New key"}
          </Button>
        }
      />

      {list.isError ? (
        <ErrorState title="Couldn't load Gateway Keys" error={list.error} onRetry={() => void list.refetch()} />
      ) : (
      <Skeleton data={list.data} sample={SAMPLE_GATEWAY_KEYS} id={phone ? "gateway-keys:phone" : "gateway-keys"} label="Loading Gateway Keys">
      {(keys) => {
        const active = keys.filter((k) => !k.revoked);
        const revoked = keys.filter((k) => k.revoked);
        return active.length === 0 && revoked.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No Gateway Keys yet"
          description="Issue a key to each Caller, so every Request is attributed to it."
          action={
            <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>
              New key
            </Button>
          }
        />
      ) : (
        <>
          {active.length === 0 ? (
            <EmptyState icon={KeyRound} title="No active Gateway Keys" description="Every key is revoked. Issue a new one for each Caller." />
          ) : phone ? (
            <KeyRows keys={active} {...act} />
          ) : (
            <KeyTable keys={active} {...act} />
          )}
          {revoked.length > 0 && (
            <div className="mt-8">
              <button
                type="button"
                onClick={() => setShowRevoked((s) => !s)}
                aria-expanded={showRevoked}
                className="inline-flex items-center gap-1 text-sm text-fg-muted hover:text-fg"
              >
                <ChevronRight size={15} className={cn("transition-transform", showRevoked && "rotate-90")} />
                Revoked keys
                <span className="tabular">{revoked.length}</span>
              </button>
              {showRevoked && <RevokedTable keys={revoked} onDelete={setDeleting} />}
            </div>
          )}
        </>
      );
      }}
      </Skeleton>
      )}

      <CreateDialog open={creating} onOpenChange={setCreating} existing={list.data ?? []} />
      <RevokeDialog k={revoking} onClose={() => setRevoking(undefined)} />
      <DeleteDialog k={deleting} onClose={() => setDeleting(undefined)} />
    </>
  );
}

type Actions = { onRevoke: (k: GatewayKey) => void; onDelete: (k: GatewayKey) => void };

function LastUsed({ k }: { k: GatewayKey }) {
  return <span title={k.last_used_at ? new Date(k.last_used_at).toLocaleString() : undefined}>{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</span>;
}

function Recent({ k }: { k: GatewayKey }) {
  if (k.recent_requests === 0) return <span className="text-fg-muted">0</span>;
  return (
    <Tip label={`Open ${k.name}'s Requests of the last 24 hours`} type="description">
      <Link to={requestsHref(k)} onClick={(e) => e.stopPropagation()} className="hover:underline">
        {formatNumber(k.recent_requests)}
      </Link>
    </Tip>
  );
}

function KeyMenu({ k, onRevoke, onDelete }: { k: GatewayKey } & Actions) {
  const navigate = useNavigate();
  const chat = useChatPanel();
  return (
    <Menu>
      <MenuIconTrigger icon={MoreHorizontal} label={`More for ${k.name}`} size="sm" />
      <MenuContent>
        <MenuItem icon={Settings2} onSelect={() => navigate(`/gateway-keys/${encodeURIComponent(k.id)}`)}>
          Open settings
        </MenuItem>
        <MenuItem icon={Copy} onSelect={() => void copyText(k.secret, "Gateway Key")}>
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
      </MenuContent>
    </Menu>
  );
}

function SecretCell({ k }: { k: GatewayKey }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Mono className="text-fg-muted">{shortSecret(k.secret)}</Mono>
      <IconButton
        icon={Copy}
        label={`Copy ${k.name}'s key`}
        size="sm"
        className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          void copyText(k.secret, "Gateway Key");
        }}
      />
    </span>
  );
}

function KeyTable({ keys, ...act }: { keys: GatewayKey[] } & Actions) {
  const navigate = useNavigate();
  return (
    <Table>
      <THead>
        <tr>
          <TH className="w-[24%]">Name</TH>
          <TH className="w-[20%]">Key</TH>
          <TH className="w-[22%]">Access</TH>
          <TH>Last used</TH>
          <TH align="right">Requests, 24 h</TH>
          <TH className="w-12">
            <span className="sr-only">Actions</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {keys.map((k) => (
          <TR key={k.id} interactive className="group h-[60px]" onClick={() => navigate(`/gateway-keys/${encodeURIComponent(k.id)}`)}>
            <TD className="max-w-0 truncate text-[15px] font-medium">
              <Link to={`/gateway-keys/${encodeURIComponent(k.id)}`} onClick={(e) => e.stopPropagation()} className="outline-none focus-visible:underline">
                {k.name}
              </Link>
            </TD>
            <TD>
              <SecretCell k={k} />
            </TD>
            <TD className="max-w-0 truncate" title={scopeDetail(k.scope)}>
              {scopeSummary(k.scope)}
            </TD>
            <TD className="tabular">
              <LastUsed k={k} />
            </TD>
            <TD align="right">
              <Recent k={k} />
            </TD>
            {/* Menu clicks bubble through the portal to the row; stop them here. */}
            <TD align="right" onClick={(e) => e.stopPropagation()}>
              <KeyMenu k={k} {...act} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}

/** Phones: two lines per key, name and last use, then the key and its access (C31). */
function KeyRows({ keys, ...act }: { keys: GatewayKey[] } & Actions) {
  return (
    <ul className="divide-y divide-border border-y border-border">
      {keys.map((k) => (
        <li key={k.id} className="flex items-center gap-2">
          <Link to={`/gateway-keys/${encodeURIComponent(k.id)}`} className="min-w-0 flex-1 py-3">
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
          </Link>
          <KeyMenu k={k} {...act} />
        </li>
      ))}
    </ul>
  );
}

function RevokedTable({ keys, onDelete }: { keys: GatewayKey[]; onDelete: (k: GatewayKey) => void }) {
  return (
    <div className="mt-3">
      <Table>
        <THead>
          <tr>
            <TH className="w-[24%]">Name</TH>
            <TH className="w-[20%]">Key</TH>
            <TH className="w-[22%]">Revoked</TH>
            <TH>Last used</TH>
            <TH className="w-12">
              <span className="sr-only">Actions</span>
            </TH>
          </tr>
        </THead>
        <TBody>
          {keys.map((k) => (
            <TR key={k.id} className="h-12 text-fg-muted">
              <TD className="max-w-0 truncate">
                <Link to={`/gateway-keys/${encodeURIComponent(k.id)}`} className="hover:text-fg hover:underline">
                  {k.name}
                </Link>
              </TD>
              <TD>
                <Mono>{shortSecret(k.secret)}</Mono>
              </TD>
              <TD className="tabular">{k.revoked_at ? shortDate(k.revoked_at) : ""}</TD>
              <TD className="tabular">
                <LastUsed k={k} />
              </TD>
              <TD align="right">
                <IconButton icon={Trash2} label={`Delete ${k.name}`} size="sm" onClick={() => onDelete(k)} />
              </TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}
