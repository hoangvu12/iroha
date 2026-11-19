import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleSlash, MessageCircle, Pause, Play } from "lucide-react";
import { api, seg } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { formatDate, formatDuration, timeAgo } from "@/lib/format";
import { calls, errorText, maskSecret, useRefresh, type UpstreamKey } from "@/pages/providers/api";
import { KeyStateLabel } from "@/pages/providers/controls";
import { Mono } from "@/ui/bits";
import { Button } from "@/ui/Button";
import { ProviderTile } from "@/ui/LogoTile";
import { SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { rec, RecordLink } from "../RecordLink";
import { Fact, Facts, LinkList, LinkRow, SheetActions, SheetBar, SheetBody, SheetLoading, SheetProblem, SheetSection, SheetTitle } from "../Sheet";
import type { SheetBodyProps } from "../SheetStack";

export default function KeySheet({ record }: SheetBodyProps<"key">) {
  const { provider, key } = record;
  const q = useQuery({
    queryKey: ["providers", provider, "keys", "one", key],
    queryFn: ({ signal }) => api.get<UpstreamKey>(`/api/providers/${seg(provider)}/keys/${seg(key)}`, { signal }),
    refetchInterval: 10_000,
  });
  const chat = useChatActions();
  const refresh = useRefresh();
  const [result, setResult] = useState<string>();
  // The sheet stays open, so Disable/Enable says how it went beside its button (UI ticket 04).
  const toggling = useSave({ refresh: () => Promise.all([refresh(), q.refetch()]), describe: errorText });
  const page = `/providers/${seg(provider)}/keys?key=${seg(key)}`;

  if (!q.data)
    return (
      <>
        <SheetBar kind="Upstream Key" page={page} />
        {q.isError ? (
          <SheetProblem kind="Upstream Key" name={key} error={q.error} onRetry={() => void q.refetch()} />
        ) : (
          <SheetLoading name={`Upstream Key ${key}`} />
        )}
      </>
    );

  const k = q.data;
  const s = k.state;
  const done = () => {
    refresh();
    void q.refetch();
  };

  const test = async () => {
    setResult(undefined);
    try {
      const res = await calls.testKeys(provider, [k.name]);
      done();
      const item = res.items[0];
      const r = item?.result;
      if (r) setResult(r.passed ? `Passed: ${r.status} in ${formatDuration(r.duration_ms)}.` : `Failed: ${r.status}${r.reason ? `, ${r.reason}` : ""}.`);
      else setResult(`Couldn't test: ${item?.error?.message ?? "no answer"}.`);
    } catch (e) {
      setResult(`Couldn't test: ${errorText(e)}`);
    }
  };

  const toggle = () =>
    void toggling.run(() => calls.updateKey(provider, k.name, { enabled: !k.enabled }), { message: `${k.name} ${k.enabled ? "disabled" : "enabled"}` });

  return (
    <>
      <SheetBar kind="Upstream Key" page={page} />
      <SheetBody>
        <SheetTitle
          kind="Upstream Key"
          logo={<ProviderTile handle={provider} size={44} />}
          title={k.name}
          mono
          subtitle={
            <>
              Upstream Key of <RecordLink record={rec.provider(provider)}>{provider}</RecordLink>
            </>
          }
          state={<KeyStateLabel state={s} />}
        />
        <SheetActions result={result}>
          <Button variant="primary" icon={Play} onClick={test}>
            Test {k.name}
          </Button>
          <Button icon={k.enabled ? Pause : CircleSlash} loading={toggling.pending} onClick={toggle}>
            {k.enabled ? `Disable ${k.name}` : `Enable ${k.name}`}
          </Button>
          <Button icon={MessageCircle} onClick={() => chat.open({ kind: "upstream_key", provider, key: k.name })}>
            Chat with {k.name}
          </Button>
          <SaveStatus save={toggling} saving={false} />
          <SaveError save={toggling} className="basis-full" />
        </SheetActions>
        {(s.reason || s.rule || s.request_id) && (
          <SheetSection title="State">
            <div className="rounded-lg border border-border px-4 py-3 text-[14.5px]">
              <p>
                <KeyStateLabel state={s} />
                {s.since && <span className="ml-3 text-[13.5px] text-fg-muted">since {timeAgo(s.since)}</span>}
              </p>
              {s.reason && <p className="mt-1.5 text-fg-muted">{s.reason}</p>}
              {(s.rule || s.request_id) && (
                <p className="mt-1.5 flex flex-wrap gap-x-4 text-[13.5px] text-fg-muted">
                  {s.rule && <span>Rule: {s.rule}</span>}
                  {s.request_id && (
                    <span>
                      Set by <RecordLink record={rec.request(s.request_id)} className="font-mono">{s.request_id}</RecordLink>
                    </span>
                  )}
                </p>
              )}
            </div>
          </SheetSection>
        )}
        <SheetSection title="Facts">
          <Facts>
            <Fact label="Secret" mono>
              <span data-agent-secret>{k.secret ? maskSecret(k.secret) : "Keyless: no credential is sent"}</span>
            </Fact>
            <Fact label="Last used">{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</Fact>
            <Fact label="Added">{formatDate(k.created_at)}</Fact>
          </Facts>
        </SheetSection>
        <SheetSection title="Endpoints">
          <p className="mb-3 text-[14.5px] text-fg-muted">
            {k.endpoints.length ? "Sent only to these Endpoints." : "Sent to every Endpoint of the Provider."}
          </p>
          {k.endpoints.length > 0 && (
            <LinkList>
              {k.endpoints.map((name) => (
                <LinkRow key={name} aside={k.worked_on.some((w) => w.endpoint === name) ? "Worked" : undefined}>
                  <RecordLink record={rec.endpoint(provider, name)}>{name}</RecordLink>
                </LinkRow>
              ))}
            </LinkList>
          )}
          {k.endpoint_gaps.length > 0 && (
            <div className="mt-3">
              <p className="mb-2 text-[14px] font-medium">Endpoint Gaps</p>
              <LinkList>
                {k.endpoint_gaps.map((g) => (
                  <LinkRow key={g.endpoint_id}>
                    <RecordLink record={rec.endpoint(provider, g.endpoint)}>{g.endpoint}</RecordLink>
                    <p className="text-[13.5px] text-fg-muted">{g.reason}</p>
                  </LinkRow>
                ))}
              </LinkList>
            </div>
          )}
        </SheetSection>
        {(k.model_gaps.length > 0 || k.cooling_models.length > 0) && (
          <SheetSection title="Models it can't serve now">
            <ul className="flex flex-col gap-2 text-[14px]">
              {k.model_gaps.map((g) => (
                <li key={`g${g.model}`}>
                  <Mono>{g.model}</Mono>
                  <span className="text-fg-muted">: Model Gap, {g.reason}. Ends {formatDate(g.expires_at)}.</span>
                </li>
              ))}
              {k.cooling_models.map((c) => (
                <li key={`c${c.model}`}>
                  <Mono>{c.model}</Mono>
                  <span className="text-fg-muted">: cooling until {formatDate(c.until)}, {c.reason}.</span>
                </li>
              ))}
            </ul>
          </SheetSection>
        )}
      </SheetBody>
    </>
  );
}
