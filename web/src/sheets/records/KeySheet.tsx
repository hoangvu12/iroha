import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleSlash, Eye, EyeOff, MessageCircle, Pause, Play, Trash2, Waypoints } from "lucide-react";
import { api, seg } from "@/api/client";
import { useChatActions } from "@/app/chat-panel";
import { formatDate, formatDuration, timeAgo } from "@/lib/format";
import { calls, errorText, maskSecret, useProvider, type KeyTestBulk, type UpstreamKey } from "@/pages/providers/api";
import { useSheetRefresh } from "./refresh";
import { KeyStateLabel, ringRoom } from "@/pages/providers/controls";
import { CoolingRow, EndpointsDialog, reportBulk, ResultsDialog, testFailure, testResults, type Results } from "@/pages/providers/Keys";
import { Mono, StatusDot } from "@/ui/bits";
import { Button, IconButton, TextButton } from "@/ui/Button";
import { useConfirm } from "@/ui/Confirm";
import { CopyButton } from "@/ui/CopyButton";
import { Field, Input } from "@/ui/Input";
import { ProviderTile } from "@/ui/LogoTile";
import { Reveal } from "@/ui/Reveal";
import { type Done, SaveError, SaveStatus, useSave } from "@/ui/SaveStatus";
import { rec, RecordLink } from "../RecordLink";
import { recordKey, writeStack } from "../records";
import { CopyIconButton, Fact, Facts, LinkList, LinkRow, SheetActions, SheetBar, SheetBody, SheetLoading, SheetProblem, SheetSection, SheetTitle } from "../Sheet";
import type { SheetBodyProps } from "../SheetStack";
import { useSheets } from "../stack";

const keyQuery = (provider: string, key: string) => ["providers", provider, "keys", "one", key];

export default function KeySheet({ record, index }: SheetBodyProps<"key">) {
  const { provider, key } = record;
  const q = useQuery({
    queryKey: keyQuery(provider, key),
    queryFn: ({ signal }) => api.get<UpstreamKey>(`/api/providers/${seg(provider)}/keys/${seg(key)}`, { signal }),
    refetchInterval: 10_000,
  });
  const page = `/providers/${seg(provider)}/keys${writeStack("", [rec.key(provider, key)])}`;

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

  return (
    <>
      <SheetBar kind="Upstream Key" page={page} />
      <KeyDetails key={q.data.id} k={q.data} provider={provider} index={index} refetch={() => q.refetch()} />
    </>
  );
}

function KeyDetails({ k, provider, index, refetch }: { k: UpstreamKey; provider: string; index: number; refetch: () => Promise<unknown> }) {
  const sheets = useSheets();
  const qc = useQueryClient();
  const chat = useChatActions();
  const confirm = useConfirm();
  const providerQ = useProvider(provider);
  const { refresh, refreshAll } = useSheetRefresh(refetch);

  const [shown, setShown] = useState(false);
  const [name, setName] = useState(k.name);
  const [secret, setSecret] = useState<string>();
  const [results, setResults] = useState<Results>();
  const [restricting, setRestricting] = useState<string[]>();
  const [testing, setTesting] = useState(false);
  const nameSave = useSave({ refresh, describe: errorText });
  const secretSave = useSave({ refresh, describe: errorText });
  const actionSave = useSave({ refresh, describe: errorText });

  const s = k.state;
  const eps = providerQ.data?.endpoints ?? [];

  const rename = (to: string) =>
    void nameSave.run(
      async () => {
        const res = await calls.updateKey(provider, k.name, { name: to });
        qc.setQueryData(keyQuery(provider, to), res.upstream_key);
        sheets.replace(index, rec.key(provider, to));
        return res;
      },
      { message: `Renamed to ${to}` },
    );
  const replace = (to: string) =>
    void secretSave.run(
      async () => {
        const res = await calls.updateKey(provider, k.name, { secret: to });
        setSecret(undefined);
        return res;
      },
      { message: "Key replaced" },
    );

  const test = async () => {
    setTesting(true);
    await actionSave.run(() => calls.testKeys(provider, [k.name]), {
      message: (res: KeyTestBulk): Done => {
        const item = res.items[0];
        const r = item?.result;
        if (r?.passed) return { message: `${k.name} passed: ${r.status} in ${formatDuration(r.duration_ms)}` };
        const why = r ? testFailure(r) : (item?.error?.message ?? "no answer");
        return { message: `${k.name} failed: ${why}`, tone: "bad", action: { label: "Details", onClick: () => setResults(testResults(res, [k.name])) } };
      },
    });
    setTesting(false);
  };
  const toggle = () =>
    void actionSave.run(() => calls.updateKey(provider, k.name, { enabled: !k.enabled }), { message: `${k.name} ${k.enabled ? "disabled" : "enabled"}` });
  const clearGap = (model?: string) =>
    void actionSave.run(() => calls.clearKeyGaps(provider, k.name, model), { message: model ? `Model Gap for ${model} cleared` : "Model Gaps cleared" });
  const clearEndpointGap = (endpoint?: string) =>
    void actionSave.run(() => calls.clearEndpointGaps(provider, k.name, endpoint), {
      message: endpoint ? `Endpoint Gap on ${endpoint} cleared` : "Endpoint Gaps cleared",
    });
  const restrict = () =>
    void actionSave.run(() => calls.restrictToWorking(provider, k.name), { message: `${k.name} restricted to the Endpoints it works on` });

  const askDelete = () =>
    confirm.ask({
      title: `Delete ${k.name}?`,
      body: `Iroha stops using ${k.name} and forgets its secret. Undo brings it back.`,
      confirmLabel: "Delete key",
      onConfirm: async () => {
        const res = await calls.bulkKeys(provider, "delete", [k.name]);
        void refreshAll();
        reportBulk(res, [k.name], "deleted", setResults, refreshAll);
        if (res.failed === 0) {
          const at = sheets.stack.findIndex((e) => recordKey(e.record) === recordKey(rec.key(provider, k.name)));
          if (at >= 0) sheets.close(at);
        }
      },
    });

  return (
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
      <SheetActions>
        <Button variant="primary" icon={Play} onClick={() => void test()} loading={testing}>
          Test {k.name}
        </Button>
        <Button icon={k.enabled ? Pause : CircleSlash} onClick={toggle}>
          {k.enabled ? `Disable ${k.name}` : `Enable ${k.name}`}
        </Button>
        <Button icon={MessageCircle} onClick={() => chat.open({ kind: "upstream_key", provider, key: k.name })}>
          Test {k.name} in Chat
        </Button>
        <Button variant="ghost" danger icon={Trash2} onClick={askDelete}>
          Delete {k.name}…
        </Button>
      </SheetActions>
      <div className="-mt-2 flex min-h-0 flex-wrap items-center gap-x-2 pb-5 empty:hidden">
        <SaveStatus save={actionSave} saving={false} />
        <SaveError save={actionSave} />
      </div>

      <SheetSection title="State">
        <div className="rounded-lg border border-border px-4 py-3 text-[14.5px]">
          <p className="flex items-center gap-3">
            <KeyStateLabel state={s} />
            {s.since && <span className="text-[13.5px] text-fg-muted">since {timeAgo(s.since)}</span>}
          </p>
          {s.reason && <p className="mt-1.5 text-fg-muted">{s.reason}</p>}
          {(s.rule || s.request_id) && (
            <p className="mt-1.5 flex flex-wrap gap-x-4 text-[13.5px] text-fg-muted">
              {s.rule && <span>Rule: {s.rule}</span>}
              {s.request_id && <RecordLink record={rec.request(s.request_id)}>Open the Request</RecordLink>}
            </p>
          )}
        </div>
      </SheetSection>

      <SheetSection title="Key">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-subtle py-1 pl-3 pr-1">
          <Mono data-agent-secret className="min-w-0 flex-1 break-all py-1 text-fg">
            {k.secret ? (shown ? k.secret : maskSecret(k.secret)) : "Keyless: no key is sent"}
          </Mono>
          {k.secret && <IconButton icon={shown ? EyeOff : Eye} label={shown ? "Hide the key" : "Show the key"} size="sm" onClick={() => setShown((x) => !x)} />}
          {k.secret && <CopyButton icon value={k.secret} what="Key" label="Copy the key" />}
          <Button size="sm" variant="ghost" onClick={() => setSecret(secret === undefined ? "" : undefined)}>
            {secret !== undefined ? "Cancel" : k.secret ? "Replace" : "Add a secret"}
          </Button>
        </div>
        <Reveal open={secret !== undefined} label="New key" className={ringRoom}>
          <form
            className="flex gap-2 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              replace((secret ?? "").trim());
            }}
          >
            <Input mono autoFocus placeholder="The new key" value={secret ?? ""} onChange={(e) => setSecret(e.target.value)} aria-label="New key" aria-invalid={!!secretSave.error} />
            <Button type="submit" variant="primary" loading={secretSave.pending} disabled={!secret?.trim()}>
              Save
            </Button>
          </form>
        </Reveal>
        <SaveStatus save={secretSave} saving={false} className="mt-2" />
        <SaveError save={secretSave} className="mt-2" />
      </SheetSection>

      <SheetSection title="Name">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name.trim() !== k.name) rename(name.trim());
          }}
        >
          <Field label="Name" hint="Unique within the Provider; Requests and Audit Entries show it." error={nameSave.error}>
            {(p) => (
              <div className="flex flex-wrap items-center gap-2">
                <Input {...p} mono className="min-w-48 flex-1" autoComplete="off" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
                {name.trim() !== k.name ? (
                  <Button type="submit" variant="primary" loading={nameSave.pending}>
                    Rename
                  </Button>
                ) : (
                  <>
                    <CopyIconButton text={k.name} what="key name" />
                    <SaveStatus save={nameSave} className="shrink-0" />
                  </>
                )}
              </div>
            )}
          </Field>
        </form>
      </SheetSection>

      {(k.model_gaps.length > 0 || k.cooling_models.length > 0) && (
        <SheetSection
          title="Models it can't serve now"
          action={
            k.model_gaps.length > 1 && (
              <TextButton className="text-[13.5px]" onClick={() => clearGap()}>
                Clear all Model Gaps
              </TextButton>
            )
          }
        >
          <ul className="divide-y divide-border rounded-lg border border-border text-[14px]">
            {k.model_gaps.map((g) => (
              <li key={`g${g.model}`} className="flex items-start gap-3 px-4 py-2.5">
                <StatusDot tone="blue" className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 font-mono">
                    <RecordLink record={rec.model(provider, g.model)}>{g.model}</RecordLink>
                  </span>
                  <span className="block text-fg-muted">
                    Model Gap: {g.reason}. Ends {formatDate(g.expires_at)}.
                  </span>
                </span>
                <TextButton className="shrink-0" aria-label={`Clear the Model Gap for ${g.model}`} onClick={() => clearGap(g.model)}>
                  Clear
                </TextButton>
              </li>
            ))}
            {k.cooling_models.map((c) => (
              <CoolingRow key={`c${c.model}`} provider={provider} model={c.model} reason={c.reason} until={c.until} />
            ))}
          </ul>
        </SheetSection>
      )}

      <SheetSection
        title="Endpoints"
        action={
          eps.length > 1 && (
            <TextButton className="text-[13.5px]" aria-label={`Change the Endpoints of ${k.name}`} onClick={() => setRestricting([k.name])}>
              Change
            </TextButton>
          )
        }
      >
        <p className="mb-3 text-[14.5px] text-fg-muted">{k.endpoints.length ? "Sent only to these Endpoints." : "Sent to every Endpoint of the Provider."}</p>
        {k.endpoints.length > 0 && (
          <LinkList>
            {k.endpoints.map((n) => (
              <LinkRow key={n} aside={k.worked_on.some((w) => w.endpoint === n) ? "Worked" : undefined}>
                <RecordLink record={rec.endpoint(provider, n)}>{n}</RecordLink>
              </LinkRow>
            ))}
          </LinkList>
        )}
        {k.endpoints.length === 0 && k.worked_on.length > 0 && (
          <p className="text-[14px] text-fg-muted">
            Worked on{" "}
            {k.worked_on.map((w, i) => (
              <span key={w.endpoint}>
                {i > 0 && ", "}
                <RecordLink record={rec.endpoint(provider, w.endpoint)} className="align-bottom">
                  {w.endpoint}
                </RecordLink>
              </span>
            ))}
            .
          </p>
        )}
        {k.endpoint_gaps.length > 0 && (
          <div className="mt-4">
            <p className="mb-2 text-[14px] font-medium">Endpoint Gaps</p>
            <ul className="divide-y divide-border rounded-lg border border-border text-[14px]">
              {k.endpoint_gaps.map((g) => (
                <li key={g.endpoint_id} className="flex items-start gap-3 px-4 py-2.5">
                  <StatusDot tone="blue" className="mt-1.5" />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 font-medium">
                      <RecordLink record={rec.endpoint(provider, g.endpoint)}>{g.endpoint}</RecordLink>
                    </span>
                    <span className="block text-fg-muted">Endpoint Gap: {g.reason}. Not sent there until cleared; a passing test there clears it.</span>
                  </span>
                  <TextButton className="shrink-0" aria-label={`Clear the Endpoint Gap on ${g.endpoint}`} onClick={() => clearEndpointGap(g.endpoint)}>
                    Clear
                  </TextButton>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-end">
              <Button size="sm" icon={Waypoints} onClick={restrict}>
                Restrict to working Endpoints
              </Button>
            </div>
          </div>
        )}
      </SheetSection>

      <SheetSection title="Facts">
        <Facts>
          <Fact label="Added">{formatDate(k.created_at)}</Fact>
          <Fact label="Last used">{k.last_used_at ? timeAgo(k.last_used_at) : "Never"}</Fact>
        </Facts>
      </SheetSection>

      {confirm.dialog}
      <EndpointsDialog
        handle={provider}
        provider={providerQ.data}
        names={restricting}
        keys={new Map([[k.name, k]])}
        onClose={() => setRestricting(undefined)}
        onResults={setResults}
      />
      <ResultsDialog results={results} onClose={() => setResults(undefined)} />
    </SheetBody>
  );
}
