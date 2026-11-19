import { useQuery } from "@tanstack/react-query";
import { MessageCircle, Pause, Play } from "lucide-react";
import { api, seg } from "@/api/client";
import { useChatPanel } from "@/app/chat-panel";
import { formatNumber, formatPercent } from "@/lib/format";
import { calls, type KeyCounts, natural, qk, useKeys, useProvider, useRefresh } from "@/pages/providers/api";
import { KeyStateLabel } from "@/pages/providers/controls";
import { shapeLabel } from "@/pages/providers/api";
import { Status } from "@/ui/bits";
import { Button } from "@/ui/Button";
import { ProviderTile } from "@/ui/LogoTile";
import { notify, notifyChange } from "@/ui/toast";
import { rec, RecordLink } from "../RecordLink";
import {
  CopyIconButton,
  Fact,
  Facts,
  LinkList,
  LinkRow,
  none,
  SheetActions,
  SheetBar,
  SheetBody,
  SheetLoading,
  SheetProblem,
  SheetSection,
  SheetTitle,
} from "../Sheet";
import type { SheetBodyProps } from "../SheetStack";

type Summary = { keys: KeyCounts; recent_attempts: { attempts: number; failed: number; failure_rate: number } };

const SHOWN_KEYS = 8;

export default function ProviderSheet({ record }: SheetBodyProps<"provider">) {
  const handle = record.handle;
  const p = useProvider(handle);
  const summary = useQuery({
    queryKey: [...qk.provider(handle), "summary"],
    queryFn: ({ signal }) => api.get<Summary>(`/api/providers/${seg(handle)}/summary`, { signal }),
    refetchInterval: 15_000,
  });
  const keys = useKeys(handle);
  const chat = useChatPanel();
  const refresh = useRefresh();
  const page = `/providers/${seg(handle)}/keys`;

  if (!p.data)
    return (
      <>
        <SheetBar kind="Provider" page={page} />
        {p.isError ? (
          <SheetProblem kind="Provider" name={handle} error={p.error} onRetry={() => void p.refetch()} />
        ) : (
          <SheetLoading name={`Provider ${handle}`} />
        )}
      </>
    );

  const pr = p.data;
  const counts = summary.data?.keys;
  const recent = summary.data?.recent_attempts;
  const listed = [...(keys.data ?? [])].sort((a, b) => natural(a.name, b.name));
  const state = pr.archived ? (
    <Status tone="gray">Archived</Status>
  ) : pr.enabled ? (
    <Status tone="green">Enabled</Status>
  ) : (
    <Status tone="gray">Disabled</Status>
  );

  const toggle = async () => {
    try {
      const res = await calls.updateProvider(handle, { enabled: !pr.enabled });
      refresh();
      notifyChange(`${handle} ${pr.enabled ? "disabled" : "enabled"}`, res, { onUndone: refresh });
    } catch (e) {
      notify.failure(`Couldn't ${pr.enabled ? "disable" : "enable"} ${handle}`, e);
    }
  };

  return (
    <>
      <SheetBar kind="Provider" page={page} />
      <SheetBody>
        <SheetTitle
          kind="Provider"
          logo={<ProviderTile handle={handle} version={pr.logo_domain} size={44} />}
          title={handle}
          subtitle={pr.name && pr.name !== handle ? pr.name : undefined}
          state={state}
        />
        <SheetActions>
          <Button variant="primary" icon={MessageCircle} onClick={() => chat.open({ kind: "provider", provider: handle })}>
            Test {handle} in Chat
          </Button>
          {!pr.archived && (
            <Button icon={pr.enabled ? Pause : Play} onClick={toggle}>
              {pr.enabled ? `Disable ${handle}` : `Enable ${handle}`}
            </Button>
          )}
        </SheetActions>
        <SheetSection title="Facts">
          <Facts>
            <Fact label="Caller path" mono wide>
              <span className="inline-flex max-w-full items-center gap-1">
                <span className="min-w-0 break-all">{pr.caller_path}</span>
                <CopyIconButton text={pr.caller_path} what="Caller path" />
              </span>
            </Fact>
            <Fact label="Upstream Keys">
              {counts ? `${formatNumber(counts.total)}, ${formatNumber(counts.active)} active` : formatNumber(pr.upstream_key_count)}
            </Fact>
            <Fact label="Not usable now">
              {counts ? (counts.cooling + counts.invalid + counts.disabled > 0 ? `${counts.cooling} cooling, ${counts.invalid} invalid, ${counts.disabled} off` : "None") : none}
            </Fact>
            <Fact label="Attempts, last hour">{recent ? formatNumber(recent.attempts) : none}</Fact>
            <Fact label="Failed">{recent && recent.attempts > 0 ? formatPercent(recent.failure_rate) : none}</Fact>
            <Fact label="Budget">
              {pr.budget.max_attempts} attempts, {pr.budget.first_byte_seconds} s to first token
            </Fact>
          </Facts>
        </SheetSection>
        <SheetSection title="Endpoints">
          {pr.endpoints.length === 0 ? (
            <p className="text-[14.5px] text-fg-muted">No Endpoints yet.</p>
          ) : (
            <LinkList>
              {pr.endpoints.map((e) => (
                <LinkRow key={e.id} aside={shapeLabel(e.shape)}>
                  <RecordLink record={rec.endpoint(handle, e.name)} className="font-medium">
                    {e.name}
                  </RecordLink>
                  <p className="truncate font-mono text-[12.5px] text-fg-muted">{e.url}</p>
                </LinkRow>
              ))}
            </LinkList>
          )}
        </SheetSection>
        <SheetSection title="Upstream Keys">
          {keys.isPending ? (
            <div aria-busy="true" className="skeleton h-4 w-40 rounded-full bg-muted" />
          ) : listed.length === 0 ? (
            <p className="text-[14.5px] text-fg-muted">No Upstream Keys yet.</p>
          ) : (
            <>
              <LinkList>
                {listed.slice(0, SHOWN_KEYS).map((k) => (
                  <LinkRow key={k.id} aside={<KeyStateLabel state={k.state} />}>
                    <RecordLink record={rec.key(handle, k.name)} className="font-mono text-[14px]">
                      {k.name}
                    </RecordLink>
                  </LinkRow>
                ))}
              </LinkList>
              {listed.length > SHOWN_KEYS && (
                <p className="mt-2 text-[14px] text-fg-muted">{listed.length - SHOWN_KEYS} more on the Provider's page.</p>
              )}
            </>
          )}
        </SheetSection>
      </SheetBody>
    </>
  );
}
