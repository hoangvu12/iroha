import { MessageCircle } from "lucide-react";
import { seg } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { formatDate } from "@/lib/format";
import { usePool } from "@/pages/providers/api";
import { Status } from "@/ui/bits";
import { Button } from "@/ui/Button";
import { PoolTile, ProviderTile } from "@/ui/LogoTile";
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

export default function PoolSheet({ record }: SheetBodyProps<"pool">) {
  const q = usePool(record.name);
  const chat = useChatActions();
  const page = `/providers/pools/${seg(record.name)}/route`;

  if (!q.data)
    return (
      <>
        <SheetBar kind="Model Pool" page={page} />
        {q.isError ? (
          <SheetProblem kind="Model Pool" name={record.name} error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <SheetLoading name={`Model Pool ${record.name}`} />
        )}
      </>
    );

  const p = q.data;
  const on = p.members.filter((m) => m.enabled).length;
  return (
    <>
      <SheetBar kind="Model Pool" page={page} />
      <SheetBody>
        <SheetTitle
          kind="Model Pool"
          logo={<PoolTile name={p.name} version={p.maker} size={44} />}
          title={p.name}
          subtitle={
            <span className="inline-flex items-center gap-1">
              Callers ask for <span className="font-mono text-[14px] text-fg">{p.name}</span>
              <CopyIconButton text={p.name} what="Pool name" />
            </span>
          }
          state={
            <Status tone={on > 0 ? "green" : "gray"}>
              {on} of {p.members.length} on
            </Status>
          }
        />
        <SheetActions>
          <Button variant="primary" icon={MessageCircle} onClick={() => chat.open({ kind: "pool", pool: p.name })}>
            Test {p.name} in Chat
          </Button>
        </SheetActions>
        <SheetSection title="Members, in order">
          {p.members.length === 0 ? (
            <p className="text-[14.5px] text-fg-muted">No members yet.</p>
          ) : (
            <LinkList>
              {p.members.map((m) => (
                <LinkRow key={`${m.position}-${m.provider}-${m.model}`} aside={m.enabled ? undefined : "Off"}>
                  <span className="flex min-w-0 items-center gap-2.5">
                    <span className="w-4 shrink-0 text-right tabular text-[13px] text-fg-muted">{m.position}</span>
                    <ProviderTile handle={m.provider} size={20} />
                    <RecordLink record={rec.provider(m.provider)}>{m.provider}</RecordLink>
                    <RecordLink record={rec.model(m.provider, m.model)} className="font-mono text-[13.5px] text-fg-muted">
                      {m.model}
                    </RecordLink>
                  </span>
                </LinkRow>
              ))}
            </LinkList>
          )}
        </SheetSection>
        <SheetSection title="Facts">
          <Facts>
            <Fact label="Logo from">{p.maker || "Guessed"}</Fact>
            <Fact label="Budget">
              {p.budget.max_attempts} attempts, {p.budget.first_byte_seconds} s to first token
            </Fact>
            <Fact label="Created">{formatDate(p.created_at)}</Fact>
          </Facts>
        </SheetSection>
      </SheetBody>
    </>
  );
}
