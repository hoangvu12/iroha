import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowUpRight, KeyRound, MessageCircle, Pencil } from "lucide-react";
import { isApiError } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { PageBody } from "@/app/PageBody";
import { PageHeader } from "@/app/PageHeader";
import { formatDate, formatNumber, timeAgo } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { CopyButton } from "@/ui/CopyButton";
import { Dialog } from "@/ui/Dialog";
import { Input } from "@/ui/Input";
import { Switch } from "@/ui/Switch";
import { Tip } from "@/ui/Tooltip";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState, ErrorState } from "@/ui/States";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { notifyChange } from "@/ui/toast";
import { type GatewayKey, useCaptureDays, useGatewayKey, useInvalidateKeys, useUpdateKey } from "./api";
import { baseUrls } from "./bits";
import { DeleteDialog, RevokeDialog } from "./confirm";
import { requestsHref } from "./List";
import { SAMPLE_GATEWAY_KEY } from "./samples";
import { PoolTile, ProviderTile } from "@/ui/LogoTile";
import { type Draft, modelsLabel, sameScope, scopeSummary, toDraft, toScope } from "./scope";
import { ScopeEditor } from "./ScopeEditor";

// A Gateway Key's page: its settings in cards (name, key, access, prompt
// capture), a Test button that opens the chat sending as this key, and the
// danger zone (revoke, delete). Laid out like Provider Settings (C14).

export function KeyPage() {
  const { key = "" } = useParams();
  const k = useGatewayKey(key);
  const navigate = useNavigate();
  const chat = useChatActions();
  const phone = useIsPhone();
  const [revoking, setRevoking] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const back = { to: "/gateway-keys", label: "Gateway Keys" };
  if (k.isError) {
    return (
      <>
        <PageHeader back={back} title="Gateway Key" />
        {isApiError(k.error) && k.error.status === 404 ? (
          <EmptyState
            icon={KeyRound}
            title="No such Gateway Key"
            description="It may have been deleted. Undo from its toast, or revert the change in Settings, Audit Entries."
            action={
              <Link to="/gateway-keys" className="text-sm font-medium text-info hover:underline">
                All Gateway Keys
              </Link>
            }
          />
        ) : (
          <ErrorState title="Couldn't load the Gateway Key" error={k.error} onRetry={() => void k.refetch()} />
        )}
      </>
    );
  }

  // Opened from the list, the list's row seeds it and no skeleton shows; from a link, the page is measured from a sample.
  return (
    <Skeleton data={k.data} sample={SAMPLE_GATEWAY_KEY} id="gateway-key-page" label="Loading the Gateway Key">
      {(g) => (
    <>
      <PageHeader
        back={back}
        icon={
          !phone && (
            <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-full border border-border bg-bg text-fg-muted">
              <KeyRound size={20} />
            </span>
          )
        }
        title={g.name}
        description={
          g.revoked && g.revoked_at
            ? `Revoked on ${formatDate(g.revoked_at)}`
            : g.last_used_at
              ? `Last used ${timeAgo(g.last_used_at)}`
              : "Never used"
        }
        actions={
          // The chat sends as this key (its scope applies) and records "Test (as <name>)".
          <Tip label={g.revoked ? "A revoked key can't send Requests" : `Chat as ${g.name}`} type="description">
            <Button
              icon={MessageCircle}
              aria-label={`Test as ${g.name}`}
              disabled={g.revoked}
              focusableWhenDisabled
              onClick={() => chat.open({ kind: "gateway_key", gatewayKey: g.name })}
            >
              {!phone && "Test"}
            </Button>
          </Tip>
        }
      />

      <PageBody width="readable" className="flex flex-col gap-9 pb-10">
        <General k={g} />
        <Access k={g} />
        <Capture k={g} />
        <Activity k={g} />

        <section>
          <h2 className="mb-3 text-[17px] font-semibold text-danger-text">Danger zone</h2>
          <div className="divide-y divide-border rounded-xl border border-danger-text">
            {!g.revoked && (
              <Row
                title="Revoke key"
                description={`Callers using ${g.name} get 401 straight away. It can't be turned back on, and its name stays on record.`}
              >
                <Button danger onClick={() => setRevoking(true)}>
                  Revoke
                </Button>
              </Row>
            )}
            <Row
              title="Delete key"
              description={
                g.revoked
                  ? `Removes ${g.name} from the list and frees its name. Requests already logged keep it.`
                  : `Removes ${g.name}; Callers using it get 401. You can undo it, and Requests already logged keep its name.`
              }
            >
              <Button danger onClick={() => setDeleting(true)}>
                Delete
              </Button>
            </Row>
          </div>
        </section>
      </PageBody>

      <RevokeDialog k={revoking ? g : undefined} onClose={() => setRevoking(false)} />
      <DeleteDialog k={deleting ? g : undefined} onClose={() => setDeleting(false)} onDone={() => navigate("/gateway-keys")} />
    </>
      )}
    </Skeleton>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-[17px] font-semibold text-fg">{title}</h2>
      <div className="divide-y divide-border rounded-xl border border-border">{children}</div>
    </section>
  );
}

/** One setting: label and one line on the left, its control on the right (stacked on phones); `below` (an error) under the control. */
function Row({
  title,
  description,
  children,
  below,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  below?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:gap-6", className)}>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium text-fg">{title}</p>
        {description && <p className="mt-0.5 text-sm text-fg-muted">{description}</p>}
      </div>
      {children && (
        <div className="flex min-w-0 shrink-0 flex-col gap-1.5 md:items-end">
          <div className="flex min-w-0 items-center gap-3">{children}</div>
          {below}
        </div>
      )}
    </div>
  );
}

function CopyValue({ value, what }: { value: string; what: string }) {
  return (
    <>
      <span className="min-w-0 truncate font-mono text-[13px] text-fg md:max-w-[300px]" title={value}>
        {value}
      </span>
      <CopyButton value={value} what={what} />
    </>
  );
}

function General({ k }: { k: GatewayKey }) {
  const update = useUpdateKey();
  const invalidate = useInvalidateKeys();
  const [name, setName] = useState(k.name);
  useEffect(() => setName(k.name), [k.name]);
  // Saved on blur: the result (or the failure) shows under the field, which
  // has room for it at any width.
  const saving = useSave({ refresh: invalidate });

  const save = () => {
    const n = name.trim();
    if (!n || n === k.name) {
      saving.clear();
      return setName(k.name);
    }
    void saving.run(() => update.mutateAsync({ id: k.id, name: n }), { message: `Renamed to ${n}` });
  };

  return (
    <Card title="General">
      <Row
        title="Name"
        description="Requests from this key show this name"
        below={
          <>
            <SaveStatus save={saving} />
            <SaveError save={saving} />
          </>
        }
      >
        <Input
          aria-label="Name"
          className="md:w-[300px]"
          value={name}
          aria-invalid={!!saving.error}
          aria-busy={saving.pending || undefined}
          disabled={k.revoked}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setName(k.name);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            }
          }}
        />
      </Row>
      <Row title="Key" description="Callers send it as a Bearer token, x-api-key or x-goog-api-key">
        <CopyValue value={k.secret} what="Gateway Key" />
      </Row>
      <Row title="Base URL" description="For OpenAI clients; Anthropic clients use the address without /v1">
        <CopyValue value={baseUrls().openai} what="Base URL" />
      </Row>
    </Card>
  );
}

function Access({ k }: { k: GatewayKey }) {
  const [editing, setEditing] = useState(false);
  const providers = k.scope.providers ?? [];
  const pools = k.scope.pools ?? [];
  return (
    <Card title="Access">
      <Row
        title={scopeSummary(k.scope)}
        description={
          k.scope.all
            ? "Every Provider and Model Pool, including ones you add later"
            : providers.length + pools.length === 0
              ? "Nothing: every Request with this key is refused"
              : "Only the Providers and Model Pools below"
        }
      >
        <Button icon={Pencil} disabled={k.revoked} onClick={() => setEditing(true)}>
          Edit access
        </Button>
      </Row>
      {providers.map((p) => (
        <div key={p.provider} className="flex h-12 items-center gap-3 px-5">
          <ProviderTile handle={p.provider} />
          <span className="min-w-0 flex-1 truncate text-[15px]">{p.provider}</span>
          <span className="shrink-0 text-sm text-fg-muted" title={p.models?.join(", ")}>
            {modelsLabel(p.models?.length ? p.models : null)}
          </span>
        </div>
      ))}
      {pools.map((n) => (
        <div key={n} className="flex h-12 items-center gap-3 px-5">
          <PoolTile name={n} />
          <span className="min-w-0 flex-1 truncate text-[15px]">{n}</span>
          <span className="shrink-0 text-sm text-fg-muted">Model Pool</span>
        </div>
      ))}
      <AccessDialog k={k} open={editing} onClose={() => setEditing(false)} />
    </Card>
  );
}

function AccessDialog({ k, open, onClose }: { k: GatewayKey; open: boolean; onClose: () => void }) {
  const update = useUpdateKey();
  const invalidate = useInvalidateKeys();
  const [draft, setDraft] = useState<Draft>(() => toDraft(k.scope));
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setDraft(toDraft(k.scope));
      setError(undefined);
    }
  }, [open]);

  const save = () => {
    const scope = toScope(draft);
    if (sameScope(scope, k.scope)) return onClose();
    if (!draft.all && draft.providers.size === 0 && draft.pools.size === 0)
      return setError("Tick at least one Provider or Model Pool, or choose Everything. To stop the key working, revoke it.");
    update.mutate(
      { id: k.id, scope },
      {
        onSuccess: (res) => {
          // Toast: the Access dialog closes on Save, so its place is gone.
          notifyChange(`Access of ${k.name} changed`, res, { undoneMessage: `${k.name}'s access is as before`, onUndone: invalidate });
          onClose();
        },
        onError: (e) => setError(isApiError(e) ? `${e.message} ${e.hint}`.trim() : String(e)),
      },
    );
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={560}
      title={`Access of ${k.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={update.isPending} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <ScopeEditor
        draft={draft}
        onChange={(d) => {
          setDraft(d);
          setError(undefined);
        }}
      />
      {error && (
        <p role="alert" className="mt-3 text-[13px] text-danger-text">
          {error}
        </p>
      )}
    </Dialog>
  );
}

function Capture({ k }: { k: GatewayKey }) {
  const update = useUpdateKey();
  const invalidate = useInvalidateKeys();
  const days = useCaptureDays();
  // The switch shows its new state while it saves; a failure puts it back and shows under it.
  const saving = useSave({ refresh: invalidate });
  const set = (on: boolean) => void saving.run(() => update.mutateAsync({ id: k.id, capture: on }), { message: on ? "Capture on" : "Capture off", undoable: false });
  const kept = days.data ? `for ${days.data} day${days.data === 1 ? "" : "s"}` : "for a while";
  return (
    <Card title="Prompt capture">
      <Row
        title="Capture prompts and responses"
        description={`Keeps the full prompt and response of this key's Requests ${kept}, under Captured in Requests. Leave it off for other people's keys.`}
        below={<SaveError save={saving} />}
      >
        <SaveStatus save={saving} saving={false} />
        <Switch label="Capture prompts and responses" checked={k.capture} disabled={k.revoked} pending={saving.pending} onChange={set} />
      </Row>
      {k.capture && (
        <Row title="Captured Requests" description="Requests from now on show what was sent and received">
          <Link to={requestsHref(k)} className="inline-flex items-center gap-1 text-sm font-medium text-info hover:underline">
            Open Requests
            <ArrowUpRight size={15} />
          </Link>
        </Row>
      )}
    </Card>
  );
}

function Activity({ k }: { k: GatewayKey }) {
  return (
    <Card title="Activity">
      <Row title="Requests in the last 24 hours" description="Test chats sent as this key are not counted">
        <span className="tabular text-[15px] text-fg">{formatNumber(k.recent_requests)}</span>
        <Link to={requestsHref(k)} className="inline-flex items-center gap-1 text-sm font-medium text-info hover:underline">
          Open in Requests
          <ArrowUpRight size={15} />
        </Link>
      </Row>
      <Row title="Last used">
        <span className="text-[15px] text-fg" title={k.last_used_at ? new Date(k.last_used_at).toLocaleString() : undefined}>
          {k.last_used_at ? timeAgo(k.last_used_at) : "Never"}
        </span>
      </Row>
      <Row title="Created">
        <span className="text-[15px] text-fg">{formatDate(k.created_at)}</span>
      </Row>
    </Card>
  );
}
