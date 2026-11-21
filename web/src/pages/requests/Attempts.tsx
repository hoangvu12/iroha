import { ChevronDown, Route as RouteIcon, Send } from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { formatNumber } from "@/lib/format";
import { rec, RecordLink } from "@/sheets/RecordLink";
import { Button } from "@/ui/Button";
import { Disclosure } from "@/ui/Disclosure";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState } from "@/ui/States";
import type { Attempt, RequestRecord } from "./api";
import { cacheReadText } from "./cache-share";
import { SAMPLE_ATTEMPTS } from "./samples";
import { attemptFailed, explain, servedModel, thenText } from "./attempt-info";
import { Badge, CodeBlock, longShape, pretty, ProviderLogo, Row, secs, statusBadgeTone, statusText, Summary } from "./bits";

export function AttemptList({ r, loading, onOpenRoute }: { r: RequestRecord; loading: boolean; onOpenRoute: () => void }) {
  return (
    <Skeleton data={r.attempts ?? (loading ? undefined : [])} sample={SAMPLE_ATTEMPTS} label="Loading Attempts">
      {(attempts) => <Attempts r={r} attempts={attempts} onOpenRoute={onOpenRoute} />}
    </Skeleton>
  );
}

function Attempts({ r, attempts, onOpenRoute }: { r: RequestRecord; attempts: Attempt[]; onOpenRoute: () => void }) {
  if (attempts.length === 0)
    return (
      <EmptyState
        icon={Send}
        title="Nothing was sent upstream"
        description={r.error ? r.error.message : r.state === "in_progress" ? "The first Attempt has not finished yet." : "Iroha answered this Request itself."}
      />
    );
  return (
    <div>
      <div className="mb-4 flex items-start gap-3">
        <div className="min-w-0 flex-1 text-[14.5px] text-fg-muted">{r.summary ? <Summary text={r.summary} /> : attemptsLine(attempts)}</div>
        <Button size="sm" icon={RouteIcon} onClick={onOpenRoute}>
          Route view
        </Button>
      </div>
      <ol key={r.id} className="flex flex-col gap-3">
        {attempts.map((a, i) => (
          <AttemptCard key={a.seq} a={a} next={attempts[i + 1]} defaultOpen={attemptFailed(a) && i === 0} />
        ))}
      </ol>
    </div>
  );
}

function attemptsLine(attempts: Attempt[]): string {
  const n = attempts.length;
  return n === 1 ? "One Attempt." : `${n} Attempts.`;
}

function AttemptCard({ a, next, defaultOpen }: { a: Attempt; next?: Attempt; defaultOpen: boolean }) {
  const e = explain(a);
  return (
    <li className="rounded-xl border border-border">
      <Collapsible defaultOpen={defaultOpen} className="group/attempt">
        <div className="relative flex w-full items-center gap-3 px-4 py-3 text-left">
          <CollapsibleTrigger aria-label={`Attempt ${a.seq}`} className="absolute inset-0 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-info/30" />
          <ProviderLogo handle={a.provider} size={32} />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] text-fg-muted">Attempt {a.seq}</span>
            <span className="flex min-w-0">
              <RecordLink record={rec.key(a.provider, a.upstream_key)} className="relative font-mono text-[14.5px] font-medium">
                {a.upstream_key}
              </RecordLink>
            </span>
          </span>
          <span className="shrink-0 text-[13.5px] text-fg-muted tabular">{secs(a.duration_ms)}</span>
          <Badge tone={a.status ? statusBadgeTone(a.status) : "red"}>{a.status || "–"}</Badge>
          <ChevronDown size={16} aria-hidden className="shrink-0 text-fg-muted transition-[rotate] duration-collapse ease-out group-data-open/attempt:rotate-180" />
        </div>
        <CollapsiblePanel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-collapse ease-out data-starting-style:h-0 data-ending-style:h-0">
          <div className="border-t border-border px-4 pb-4 pt-3">
            <AttemptFacts a={a} next={next} />
            {e.body && (
              <div className="mt-3">
                <h4 className="mb-2 text-[13px] text-fg-muted">Upstream error</h4>
                <CodeBlock>{pretty(e.body)}</CodeBlock>
              </div>
            )}
            {e.headers && <Headers headers={e.headers} />}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

export function AttemptFacts({ a, next, withSentTo = true }: { a: Attempt; next?: Attempt; withSentTo?: boolean }) {
  const e = explain(a);
  const served = servedModel(a);
  return (
    <dl>
      {e.failed && (
        <>
          <Row label="Result">{a.status ? `${a.status} ${statusText(a.status)}`.trim() : "No response"}</Row>
          {e.reason && <Row label="Provider said">{e.reason}</Row>}
          <Row label="Failure Rule">{e.rule ? <RecordLink record={rec.rule(a.provider, e.rule)}>{e.rule}</RecordLink> : <span className="text-fg-muted">None matched</span>}</Row>
          {e.keyState && (
            <Row label="Key State" className={keyStateClass[e.keyState.tone]}>
              <span title={e.action}>{e.keyState.text}</span>
            </Row>
          )}
          <Row label="Then">{thenText(a, next)}</Row>
        </>
      )}
      {withSentTo && (
        <>
          <AttemptTarget a={a} />
          <Row label="Shape">{longShape(a.shape)}</Row>
          <Row label="Model sent" mono>
            {a.wire_model ? <RecordLink record={rec.model(a.provider, a.wire_model)}>{a.wire_model}</RecordLink> : a.wire_model}
          </Row>
          {served && (
            <Row label="Model served" mono>
              {served}
            </Row>
          )}
          {!e.failed && <Row label="First token">{secs(a.first_byte_ms)}</Row>}
        </>
      )}
      {!e.failed && a.usage && (
        <>
          <Row label="Cache read">{cacheReadText(a.usage, "short")}</Row>
          <Row label="Cache write">{formatNumber(a.usage.cache_write)}</Row>
        </>
      )}
    </dl>
  );
}

export function AttemptTarget({ a }: { a: Attempt }) {
  return (
    <>
      <Row label="Provider">
        <RecordLink record={rec.provider(a.provider)}>{a.provider}</RecordLink>
      </Row>
      <Row label="Endpoint">{a.endpoint ? <RecordLink record={rec.endpoint(a.provider, a.endpoint)}>{a.endpoint}</RecordLink> : "–"}</Row>
      <Row label="Upstream Key" mono>
        {a.upstream_key ? <RecordLink record={rec.key(a.provider, a.upstream_key)}>{a.upstream_key}</RecordLink> : "–"}
      </Row>
    </>
  );
}

export const keyStateClass: Record<string, string> = {
  amber: "text-warning",
  red: "text-danger-text",
  blue: "text-info",
  green: "text-success",
  gray: "text-fg",
};

export function Headers({ headers }: { headers: Record<string, string> }) {
  const names = Object.keys(headers).sort();
  return (
    <Disclosure className="mt-3" triggerClassName="text-[13px]" summary={`Response headers (${names.length})`}>
      <CodeBlock className="mt-2" lang="headers">{names.map((n) => `${n}: ${headers[n]}`).join("\n")}</CodeBlock>
    </Disclosure>
  );
}
