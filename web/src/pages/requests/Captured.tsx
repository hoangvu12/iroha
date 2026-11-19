import { useMemo, useState } from "react";
import { Braces, FileX, MessageCircle, SquareTerminal } from "lucide-react";
import { isApiError } from "@/api/client";
import { formatNumber } from "@/lib/format";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { Button, TextButton } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState, ErrorState } from "@/ui/States";
import { Tab, TabList, TabPanel, Tabs } from "@/ui/Tabs";
import { CopyButton } from "@/ui/CopyButton";
import type { Capture, RequestRecord } from "./api";
import { useCapture, useCaptureDays } from "./api";
import { CodeBlock, longShape } from "./bits";
import { type Block, parseRequest, parseResponse } from "./messages";
import { SAMPLE_CAPTURE } from "./samples";

// The Captured tab (C26): what the Caller sent and what it received, each
// message in order, with Raw JSON, Copy as cURL and Replay in Chat. Iroha
// captures the Caller's side only (the body sent upstream is not stored).

type Side = "sent" | "response";

export function CapturedView({ r, onReplay }: { r: RequestRecord; onReplay: () => void }) {
  const cap = useCapture(r.id, r.captured);
  const days = useCaptureDays();
  const [side, setSide] = useState<Side>("sent");
  const [raw, setRaw] = useState(false);

  if (!r.captured)
    return (
      <EmptyState
        icon={FileX}
        title="Not captured"
        description={`Only Requests from Gateway Keys with capture on keep their prompt and response. ${r.caller.name} had it off.`}
      />
    );
  if (cap.isError)
    return isApiError(cap.error) && cap.error.code === "capture_not_found" ? (
      <EmptyState icon={FileX} title="Capture expired" description={cap.error.message} />
    ) : (
      <ErrorState title="Couldn't load the capture" error={cap.error} onRetry={() => void cap.refetch()} />
    );

  const curl = (c: Capture) => {
    const body = JSON.stringify(c.request.body);
    return [
      `curl ${window.location.origin}${r.route}`,
      `  -H "Authorization: Bearer $IROHA_KEY"`,
      `  -H "Content-Type: application/json"`,
      `  -d '${body.replace(/'/g, "'\\''")}'`,
    ].join(" \\\n");
  };

  return (
    <Skeleton data={cap.data} sample={SAMPLE_CAPTURE} label="Loading the capture">
      {(c) => (
    <Tabs value={side} onValueChange={(s) => s && setSide(s as Side)}>
      <div className="mb-5 flex items-center gap-3">
        <TabList label="Captured side" variant="segmented">
          <Tab value="sent">Caller sent</Tab>
          <Tab value="response">Response</Tab>
        </TabList>
        <div className="flex-1" />
        <SdkButton
          aria-pressed={raw}
          onClick={() => setRaw((x) => !x)}
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-[14px]", raw ? "bg-muted text-fg" : "text-fg hover:bg-muted")}
        >
          <Braces size={15} /> Raw JSON
        </SdkButton>
      </div>
      <TabPanel value="sent">
        <SentSide c={c} r={r} raw={raw} />
      </TabPanel>
      <TabPanel value="response">
        <ResponseSide c={c} r={r} raw={raw} />
      </TabPanel>
      <div className="mt-8 flex flex-wrap items-center gap-2">
        <p className="mr-auto text-[14px] text-fg-muted">{days.data ? `Bodies are kept for ${days.data} day${days.data === 1 ? "" : "s"}.` : ""}</p>
        <CopyButton size="md" glyph={SquareTerminal} value={() => curl(c)} what="cURL command" label="Copy as cURL">
          Copy as cURL
        </CopyButton>
        <Button icon={MessageCircle} onClick={onReplay}>
          Replay in Chat
        </Button>
      </div>
    </Tabs>
      )}
    </Skeleton>
  );
}

function size(body: unknown): string {
  const n = new Blob([typeof body === "string" ? body : JSON.stringify(body)]).size;
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function Meta({ items }: { items: [string, string, boolean?][] }) {
  return (
    <dl className="mb-5 flex flex-wrap gap-x-8 gap-y-2">
      {items.map(([label, value, mono]) => (
        <div key={label}>
          <dt className="text-[13px] text-fg-muted">{label}</dt>
          <dd className={cn("text-[15px]", mono && "font-mono text-[14px]")}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SentSide({ c, r, raw }: { c: Capture; r: RequestRecord; raw: boolean }) {
  const parsed = useMemo(() => parseRequest(r.shape_in, c.request.body), [r.shape_in, c.request.body]);
  return (
    <>
      <Meta
        items={[
          ["Shape", longShape(r.shape_in)],
          ["Path", `POST ${r.route}`, true],
          ["Size", size(c.request.body)],
        ]}
      />
      {c.request.truncated && <Truncated />}
      {raw || !parsed ? <CodeBlock maxHeight={false}>{JSON.stringify(c.request.body, null, 2)}</CodeBlock> : <Blocks blocks={parsed.blocks} tools={parsed.tools} />}
    </>
  );
}

function ResponseSide({ c, r, raw }: { c: Capture; r: RequestRecord; raw: boolean }) {
  const parsed = useMemo(() => parseResponse(r.shape_in, c.response.body), [r.shape_in, c.response.body]);
  return (
    <>
      <Meta
        items={[
          ["Status", String(c.response.status)],
          ["Shape", longShape(r.shape_in)],
          ["Streamed", c.response.stream ? "Yes" : "No"],
          ["Size", size(c.response.stream ?? c.response.body)],
        ]}
      />
      {c.response.truncated && <Truncated />}
      {raw || !parsed ? (
        <>
          <CodeBlock maxHeight={false}>{JSON.stringify(c.response.body, null, 2)}</CodeBlock>
          {raw && c.response.stream && (
            <>
              <h4 className="mb-2 mt-5 text-[13px] text-fg-muted">As streamed</h4>
              <CodeBlock>{c.response.stream}</CodeBlock>
            </>
          )}
        </>
      ) : (
        <Blocks blocks={parsed.blocks} tools={[]} />
      )}
    </>
  );
}

function Truncated() {
  return <p className="mb-4 text-[14px] text-warning">Only the first 16 MiB of this body was kept.</p>;
}

const SHOWN_TOOLS = 5;
const SHORT = 280;

function Blocks({ blocks, tools }: { blocks: Block[]; tools: string[] }) {
  return (
    <div className="flex flex-col gap-5">
      {blocks.length > 0 && blocks[0].role === "System" && <MessageBlock b={blocks[0]} />}
      {tools.length > 0 && (
        <section>
          <h4 className="mb-2 flex justify-between text-[14px] font-medium text-fg-muted">
            Tools <span className="tabular font-normal">{formatNumber(tools.length)}</span>
          </h4>
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-4 py-3">
            {tools.slice(0, SHOWN_TOOLS).map((t, i) => (
              <span key={i} className="rounded-md bg-muted px-2 py-0.5 font-mono text-[13px]">
                {t}
              </span>
            ))}
            {tools.length > SHOWN_TOOLS && <span className="text-[14px] text-fg-muted">and {tools.length - SHOWN_TOOLS} more</span>}
          </div>
        </section>
      )}
      {(blocks[0]?.role === "System" ? blocks.slice(1) : blocks).map((b, i) => (
        <MessageBlock key={i} b={b} />
      ))}
    </div>
  );
}

function MessageBlock({ b }: { b: Block }) {
  const [all, setAll] = useState(false);
  const long = b.text.length > SHORT * 1.4;
  const text = long && !all ? b.text.slice(0, SHORT).trimEnd() + "…" : b.text;
  return (
    <section>
      <h4 className="mb-2 flex justify-between text-[14px] font-medium text-fg-muted">
        {b.role}
        {b.note && <span className="font-normal">{b.note}</span>}
      </h4>
      <div className="rounded-xl border border-border bg-subtle px-4 py-3">
        <p className={cn("whitespace-pre-wrap break-words", b.code ? "font-mono text-[13px] leading-relaxed" : "text-[15px] leading-relaxed")}>{text}</p>
        {long && (
          <TextButton onClick={() => setAll((x) => !x)} className="mt-2 text-[14.5px] font-medium">
            {all ? "Show less" : `Show all ${formatNumber(b.text.length)} characters`}
          </TextButton>
        )}
      </div>
    </section>
  );
}
