import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { rec, RecordLink } from "@/sheets/RecordLink";
import { TextButton } from "@/ui/Button";
import type { RequestRecord } from "./api";
import { Fact, failed, longShape, msOrSecs, ProviderLogo, secs, Summary } from "./bits";

// The Details tab (C04): Route, Timing, Tokens. Shared by the drawer and the
// Route view's Details tab.

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-border py-6 first:pt-0 last:border-b-0">
      <h3 className="mb-4 text-[15px] font-semibold">{title}</h3>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-4">{children}</dl>
    </section>
  );
}

const none = <span className="text-fg-subtle">–</span>;

export function RequestDetails({ r, onShowCaptured }: { r: RequestRecord; onShowCaptured?: () => void }) {
  const attempts = r.attempts ?? [];
  const upstreamMs = attempts.length ? attempts.reduce((s, a) => s + (a.duration_ms ?? 0), 0) : undefined;
  const overhead = r.duration_ms !== undefined && upstreamMs !== undefined ? Math.max(0, r.duration_ms - upstreamMs) : undefined;
  const bad = failed(r);
  const test = r.caller.kind === "test";

  return (
    <div>
      {(bad || r.summary) && (
        <div className="mb-6 rounded-lg bg-subtle px-4 py-3 text-[14.5px]">
          {r.error && (
            <p>
              <span className="font-mono text-[13px] text-danger-text">{r.error.code}</span>
              <span className="ml-2">{r.error.message}</span>
            </p>
          )}
          {r.summary && <Summary text={r.summary} className={r.error ? "mt-1.5 text-fg-muted" : ""} />}
        </div>
      )}
      <Section title="Route">
        <Fact label="Caller">{r.caller.name}</Fact>
        {/* The key's name (the Caller's name when it called), linked by ID so a rename since still finds it. */}
        <Fact label="Gateway Key">
          {r.caller.gateway_key_id ? <RecordLink record={rec.gatewayKey(r.caller.gateway_key_id)}>{r.caller.name}</RecordLink> : test ? "Test" : none}
        </Fact>
        <Fact label="Provider">
          {r.provider ? (
            <span className="inline-flex items-center gap-2">
              <ProviderLogo handle={r.provider} />
              <RecordLink record={rec.provider(r.provider)}>{r.provider}</RecordLink>
            </span>
          ) : (
            none
          )}
        </Fact>
        <Fact label="Endpoint">{r.endpoint && r.provider ? <RecordLink record={rec.endpoint(r.provider, r.endpoint)}>{r.endpoint}</RecordLink> : r.endpoint || none}</Fact>
        <Fact label="Upstream Key" mono>
          {r.upstream_key && r.provider ? <RecordLink record={rec.key(r.provider, r.upstream_key)}>{r.upstream_key}</RecordLink> : r.upstream_key || none}
        </Fact>
        <Fact label="Stream">{r.stream ? "Yes" : "No"}</Fact>
        <Fact label="Caller Shape">{longShape(r.shape_in)}</Fact>
        <Fact label="Upstream Shape">{r.shape_out ? longShape(r.shape_out) : none}</Fact>
        {r.pool && (
          <Fact label="Model Pool">
            <RecordLink record={rec.pool(r.pool)}>{r.pool}</RecordLink>
          </Fact>
        )}
        {r.wire_model && r.wire_model !== r.model && (
          <Fact label="Model sent" mono>
            {r.provider ? <RecordLink record={rec.model(r.provider, r.wire_model)}>{r.wire_model}</RecordLink> : r.wire_model}
          </Fact>
        )}
        <div className="col-span-2">
          <Fact label="Path" mono>
            <span title={r.route}>{r.route}</span>
          </Fact>
        </div>
      </Section>
      <Section title="Timing">
        <Fact label="First token">{r.first_byte_ms !== undefined && !bad ? secs(r.first_byte_ms) : none}</Fact>
        <Fact label="Duration">{r.state === "in_progress" ? "In progress" : secs(r.duration_ms)}</Fact>
        <Fact label="Upstream">{upstreamMs !== undefined ? secs(upstreamMs) : none}</Fact>
        <Fact label="Iroha overhead">{overhead !== undefined ? msOrSecs(overhead) : none}</Fact>
      </Section>
      <Section title="Tokens">
        <Fact label="Input">{r.usage ? formatNumber(r.usage.input) : none}</Fact>
        <Fact label="Output">{r.usage ? formatNumber(r.usage.output) : none}</Fact>
        <Fact label="Cache read">{r.usage ? formatNumber(r.usage.cache_read) : none}</Fact>
        <Fact label="Reasoning">{r.usage ? formatNumber(r.usage.reasoning) : none}</Fact>
      </Section>
      {r.captured && onShowCaptured && (
        <TextButton onClick={onShowCaptured} className="mt-6 inline-flex items-center gap-1.5 text-[15px] font-medium">
          View prompt and response <ArrowRight size={16} aria-hidden />
        </TextButton>
      )}
    </div>
  );
}
