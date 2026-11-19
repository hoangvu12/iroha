import { useState } from "react";
import { ChevronDown, Route as RouteIcon, Send } from "lucide-react";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { EmptyState } from "@/ui/States";
import type { Attempt, RequestRecord } from "./api";
import { attemptFailed, explain, servedModel, thenText } from "./attempt-info";
import { Badge, CodeBlock, longShape, pretty, ProviderLogo, Row, secs, statusBadgeTone, statusText, Summary } from "./bits";

/** The drawer's Attempts tab: the Request's summary, then each Attempt and what Iroha made of it. */
export function AttemptList({ r, loading, onOpenRoute }: { r: RequestRecord; loading: boolean; onOpenRoute: () => void }) {
  const attempts = r.attempts;
  if (!attempts && loading)
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1].map((i) => (
          <div key={i} className="skeleton h-16 rounded-xl bg-muted" />
        ))}
      </div>
    );
  if (!attempts || attempts.length === 0)
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
      <ol className="flex flex-col gap-3">
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
  const [open, setOpen] = useState(defaultOpen);
  const e = explain(a);
  return (
    <li className="rounded-xl border border-border">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <ProviderLogo handle={a.provider} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-fg-muted">Attempt {a.seq}</span>
          <span className="block truncate font-mono text-[14.5px] font-medium">{a.upstream_key}</span>
        </span>
        <span className="shrink-0 text-[13.5px] text-fg-muted tabular">{secs(a.duration_ms)}</span>
        <Badge tone={a.status ? statusBadgeTone(a.status) : "red"}>{a.status || "–"}</Badge>
        <ChevronDown size={16} className={cn("shrink-0 text-fg-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
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
      )}
    </li>
  );
}

/** What happened at one Attempt, as label/value rows (drawer and Route view). */
export function AttemptFacts({ a, next, withSentTo = true }: { a: Attempt; next?: Attempt; withSentTo?: boolean }) {
  const e = explain(a);
  const served = servedModel(a);
  return (
    <dl>
      {e.failed && (
        <>
          <Row label="Result">{a.status ? `${a.status} ${statusText(a.status)}`.trim() : "No response"}</Row>
          {e.reason && <Row label="Provider said">{e.reason}</Row>}
          <Row label="Failure Rule">{e.rule ?? <span className="text-fg-muted">None matched</span>}</Row>
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
          <Row label="Provider">{a.provider}</Row>
          <Row label="Endpoint">{a.endpoint}</Row>
          <Row label="Upstream Key" mono>
            {a.upstream_key}
          </Row>
          <Row label="Shape">{longShape(a.shape)}</Row>
          <Row label="Model sent" mono>
            {a.wire_model}
          </Row>
          {served && (
            <Row label="Model served" mono>
              {served}
            </Row>
          )}
          {!e.failed && <Row label="First token">{secs(a.first_byte_ms)}</Row>}
        </>
      )}
    </dl>
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
  const [open, setOpen] = useState(false);
  const names = Object.keys(headers).sort();
  return (
    <div className="mt-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[13px] text-fg-muted hover:text-fg">
        <ChevronDown size={14} className={cn("transition-transform", open ? "rotate-0" : "-rotate-90")} />
        Response headers ({names.length})
      </button>
      {open && <CodeBlock className="mt-2">{names.map((n) => `${n}: ${headers[n]}`).join("\n")}</CodeBlock>}
    </div>
  );
}
