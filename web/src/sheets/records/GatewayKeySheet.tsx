import { useState } from "react";
import { KeyRound, MessageCircle, Pencil } from "lucide-react";
import { errorText, seg } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { formatDate, plural, timeAgo } from "@/lib/format";
import { type GatewayKey, useGatewayKey, useInvalidateKeys, useUpdateKey } from "@/pages/gateway-keys/api";
import { RequestsCount, ScopeModels } from "@/pages/gateway-keys/bits";
import { type Draft, sameScope, toDraft, toScope } from "@/pages/gateway-keys/scope";
import { ScopeEditor } from "@/pages/gateway-keys/ScopeEditor";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { maskSecret } from "@/pages/providers/api";
import { Status } from "@/ui/bits";
import { Button } from "@/ui/Button";
import { rec, RecordLink } from "../RecordLink";
import {
  CopyIconButton,
  Fact,
  Facts,
  LinkList,
  LinkRow,
  SheetActions,
  SheetBar,
  SheetBody,
  SheetLoading,
  SheetProblem,
  SheetSection,
  SheetTitle,
} from "../Sheet";
import type { SheetBodyProps } from "../SheetStack";

export default function GatewayKeySheet({ record }: SheetBodyProps<"gateway-key">) {
  const q = useGatewayKey(record.key);
  const chat = useChatActions();

  if (!q.data)
    return (
      <>
        <SheetBar kind="Gateway Key" page={`/gateway-keys/${seg(record.key)}`} />
        {q.isError ? (
          <SheetProblem kind="Gateway Key" name={record.key} error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <SheetLoading name={`Gateway Key ${record.key}`} />
        )}
      </>
    );

  const k = q.data;
  return (
    <>
      <SheetBar kind="Gateway Key" page={`/gateway-keys/${seg(k.id)}`} />
      <SheetBody>
        <SheetTitle
          kind="Gateway Key"
          logo={
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-fg-muted">
              <KeyRound size={20} aria-hidden />
            </span>
          }
          title={k.name}
          subtitle={k.last_used_at ? `Last used ${timeAgo(k.last_used_at)}` : "Never used"}
          state={k.revoked ? <Status tone="red">Revoked</Status> : <Status tone="green">Active</Status>}
        />
        <SheetActions>
          {!k.revoked && (
            <Button variant="primary" icon={MessageCircle} onClick={() => chat.open({ kind: "gateway_key", gatewayKey: k.name })}>
              Test as {k.name}
            </Button>
          )}
        </SheetActions>
        <SheetSection title="Facts">
          <Facts>
            <Fact label="Key" mono>
              <span className="inline-flex items-center gap-1">
                <span data-agent-secret>{maskSecret(k.secret)}</span>
                {!k.revoked && <CopyIconButton text={k.secret} what="Gateway Key" />}
              </span>
            </Fact>
            <Fact label="Requests, last 24 hours">
              <RequestsCount k={k} />
            </Fact>
            <Fact label="Prompt capture">{k.capture ? "On" : "Off"}</Fact>
            <Fact label="Created">{formatDate(k.created_at)}</Fact>
            {k.revoked_at && <Fact label="Revoked">{formatDate(k.revoked_at)}</Fact>}
          </Facts>
        </SheetSection>
        <Access k={k} />
      </SheetBody>
    </>
  );
}

function Access({ k }: { k: GatewayKey }) {
  const scope = k.scope;
  const update = useUpdateKey();
  const invalidate = useInvalidateKeys();
  const saving = useSave({ refresh: invalidate, describe: errorText });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(scope));
  const [error, setError] = useState<string>();

  const edit = () => {
    setDraft(toDraft(k.scope));
    setError(undefined);
    setEditing(true);
  };
  const save = () => {
    const next = toScope(draft);
    if (sameScope(next, k.scope)) return setEditing(false);
    if (!draft.all && draft.providers.size === 0 && draft.pools.size === 0)
      return setError("Tick at least one Provider or Model Pool, or choose Everything. To stop the key working, revoke it.");
    setError(undefined);
    void saving
      .run(() => update.mutateAsync({ id: k.id, scope: next }), { message: `Access of ${k.name} changed` })
      .then((ok) => ok && setEditing(false));
  };

  if (editing)
    return (
      <SheetSection title="Access">
        <ScopeEditor
          heading={false}
          draft={draft}
          onChange={(d) => {
            setDraft(d);
            setError(undefined);
          }}
        />
        <SaveError save={saving} error={error} className="mt-3" />
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={() => setEditing(false)}>Cancel</Button>
          <Button variant="primary" loading={saving.pending} onClick={save}>
            Save access
          </Button>
        </div>
      </SheetSection>
    );

  return (
    <SheetSection
      title="Access"
      action={
        !k.revoked && (
          <span className="flex items-center gap-2">
            <SaveStatus save={saving} saving={false} />
            <Button size="sm" icon={Pencil} onClick={edit}>
              Edit access
            </Button>
          </span>
        )
      }
    >
      {scope.all ? (
        <p className="text-[14.5px] text-fg-muted">Every Provider and Model Pool.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {(scope.providers ?? []).length > 0 && (
            <LinkList>
              {(scope.providers ?? []).map((p) => (
                <LinkRow key={p.provider} aside={p.models?.length ? plural(p.models.length, "model") : "All models"}>
                  <RecordLink record={rec.provider(p.provider)}>{p.provider}</RecordLink>
                  {p.models?.length ? <ScopeModels provider={p.provider} models={p.models} className="mt-1" /> : null}
                </LinkRow>
              ))}
            </LinkList>
          )}
          {(scope.pools ?? []).length > 0 && (
            <LinkList>
              {(scope.pools ?? []).map((name) => (
                <LinkRow key={name} aside="Model Pool">
                  <RecordLink record={rec.pool(name)}>{name}</RecordLink>
                </LinkRow>
              ))}
            </LinkList>
          )}
          {!(scope.providers ?? []).length && !(scope.pools ?? []).length && <p className="text-[14.5px] text-fg-muted">Nothing: every call is refused.</p>}
        </div>
      )}
    </SheetSection>
  );
}
