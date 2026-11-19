import { KeyRound, MessageCircle } from "lucide-react";
import { seg } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { formatDate, timeAgo } from "@/lib/format";
import { useGatewayKey } from "@/pages/gateway-keys/api";
import { RequestsCount } from "@/pages/gateway-keys/bits";
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
  const scope = k.scope;
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
        <SheetSection title="Access">
          {scope.all ? (
            <p className="text-[14.5px] text-fg-muted">Every Provider and Model Pool.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {(scope.providers ?? []).length > 0 && (
                <LinkList>
                  {(scope.providers ?? []).map((p) => (
                    <LinkRow key={p.provider} aside={p.models?.length ? `${p.models.length} model${p.models.length === 1 ? "" : "s"}` : "All models"}>
                      <RecordLink record={rec.provider(p.provider)}>{p.provider}</RecordLink>
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
      </SheetBody>
    </>
  );
}
