import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft, ArrowUpRight, CornerDownLeft, MessageCircle, User, X } from "lucide-react";
import { useChatPanel } from "@/app/chat-panel";
import { PageBody } from "@/app/PageBody";
import { CHAT_WIDTH, SIDEBAR_WIDTH } from "@/app/Shell";
import { seg } from "@/api/client";
import { formatNumber } from "@/lib/format";
import { useIsPhone } from "@/lib/media";
import { Button, buttonClass, IconButton } from "@/ui/Button";
import type { Tone } from "@/ui/bits";
import { Canvas } from "@/ui/Canvas";
import { cn } from "@/ui/cn";
import { ScrollArea } from "@/ui/ScrollArea";
import { Skeleton } from "@/ui/Skeleton";
import { ErrorState } from "@/ui/States";
import { Tab as UITab, TabList, TabPanel, Tabs } from "@/ui/Tabs";
import { CopyButton } from "@/ui/CopyButton";
import type { Attempt, RequestRecord } from "./api";
import { useRequest } from "./api";
import { attemptFailed, explain, jumpLabel, servedModel, thenText } from "./attempt-info";
import { rec, RecordLink } from "@/sheets/RecordLink";
import { AttemptTarget, Headers, keyStateClass } from "./Attempts";
import { Badge, clockMs, CodeBlock, longShape, pretty, ProviderLogo, Row, secs, statusBadgeTone, StatusPill, statusText, statusTone, Summary } from "./bits";
import { CapturedView } from "./Captured";
import { RequestDetails } from "./Details";
import { SAMPLE_REQUEST } from "./samples";

// A Request's Route view (C18, C22): full page, tabs Route / Details /
// Captured. Route draws the Request as a top-to-bottom chain of cards on a
// dotted canvas (Start, each Attempt, End), each line labelled with why
// Iroha moved on, and the selected card's details on the right. It reads
// the same GET /api/requests/{id} as the drawer and as agents do.

type Tab = "route" | "details" | "captured";
type Node = { kind: "start" } | { kind: "attempt"; seq: number } | { kind: "end" };

export function RouteViewPage() {
  const { id = "", tab: rawTab } = useParams();
  const tab: Tab = rawTab === "details" || rawTab === "captured" ? rawTab : "route";
  const phone = useIsPhone();
  const chat = useChatPanel();
  const req = useRequest(id);
  const r = req.data;

  return (
    <div
      className="fixed z-10 flex flex-col bg-bg"
      style={{
        top: 0,
        left: phone ? 0 : SIDEBAR_WIDTH,
        right: chat.isOpen && !phone ? CHAT_WIDTH : 0,
        bottom: phone ? "calc(64px + env(safe-area-inset-bottom))" : 0,
      }}
    >
      <PageBody width="wide" className="flex min-h-0 flex-1 flex-col">
        <Tabs value={tab} className="flex min-h-0 flex-1 flex-col">
          <TopBar id={id} r={r} phone={phone} onReplay={() => chat.open({ kind: "request", request: id })} />
          <TabPanel value={tab} className="flex min-h-0 flex-1 flex-col">
            {req.isError && !r ? (
              <ErrorState title="Couldn't load this Request" error={req.error} onRetry={() => void req.refetch()} />
            ) : (
              <Skeleton data={r} sample={SAMPLE_REQUEST} id={`request-view:${tab}`} label="Loading Request" className="skeleton-fill">
                {(r) =>
                  tab === "route" ? (
                    <RouteCanvas r={r} phone={phone} />
                  ) : (
                    <ScrollArea className="flex-1" contentClassName="mx-auto max-w-[640px] px-4 py-8 md:px-6">
                      {tab === "details" ? <RequestDetails r={r} /> : <CapturedView r={r} onReplay={() => chat.open({ kind: "request", request: r.id })} />}
                    </ScrollArea>
                  )
                }
              </Skeleton>
            )}
          </TabPanel>
        </Tabs>
      </PageBody>
    </div>
  );
}

function TopBar({ id, r, phone, onReplay }: { id: string; r?: RequestRecord; phone: boolean; onReplay: () => void }) {
  const base = `/requests/${seg(id)}`;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 md:h-[60px] md:flex-nowrap md:px-6 md:py-0">
      <Link to={`/requests?request=${encodeURIComponent(id)}`} aria-label="Back to Requests" className="rounded-md p-1 text-fg-muted hover:bg-muted hover:text-fg">
        <ArrowLeft size={18} />
      </Link>
      {!phone && (
        <>
          <Link to="/requests" className="text-[15px] text-fg-muted hover:text-fg">
            Requests
          </Link>
          <span className="text-fg-subtle">/</span>
        </>
      )}
      <span className="min-w-0 truncate font-mono text-[14.5px]">{id}</span>
      {r && <Badge tone={statusTone(r.status, r.state)}>{r.state === "in_progress" ? "In progress" : r.state === "interrupted" ? "Interrupted" : `${r.status} ${statusText(r.status)}`.trim()}</Badge>}
      <div className="hidden flex-1 md:block" />
      <TabList label="Request views" variant="segmented" className={phone ? "order-last w-full" : undefined}>
        {(
          [
            ["route", "Route"],
            ["details", "Details"],
            ["captured", "Captured"],
          ] as const
        ).map(([t, label]) => (
          <UITab key={t} value={t} render={<Link to={`${base}/${t}`} replace />}>
            {label}
          </UITab>
        ))}
      </TabList>
      <div className="flex-1" />
      {r?.captured &&
        (phone ? (
          <IconButton icon={MessageCircle} label="Replay in Chat" bordered onClick={onReplay} />
        ) : (
          <Button icon={MessageCircle} onClick={onReplay}>
            Replay in Chat
          </Button>
        ))}
      <CopyButton icon size="md" bordered value={id} what="Request ID" label="Copy Request ID" />
    </div>
  );
}

const pillTone: Record<Tone, string> = {
  amber: "bg-warning-tint text-warning",
  blue: "bg-info-tint text-info",
  red: "bg-danger-tint text-danger-text",
  green: "bg-success-tint text-success",
  gray: "bg-muted text-fg-muted",
};

function defaultNode(r: RequestRecord): Node {
  const a = r.attempts ?? [];
  const firstFailed = a.find(attemptFailed);
  if (firstFailed) return { kind: "attempt", seq: firstFailed.seq };
  if (a.length) return { kind: "attempt", seq: a[a.length - 1].seq };
  return { kind: "end" };
}

const same = (a: Node | undefined, b: Node) => !!a && a.kind === b.kind && (a.kind !== "attempt" || (b.kind === "attempt" && a.seq === b.seq));

function RouteCanvas({ r, phone }: { r: RequestRecord; phone: boolean }) {
  const attempts = useMemo(() => r.attempts ?? [], [r.attempts]);
  const [selected, setSelected] = useState<Node | undefined>(() => defaultNode(r));

  const chain: ReactNode[] = [];
  const select = (n: Node) => setSelected(n);
  chain.push(<StartCard key="start" r={r} selected={same(selected, { kind: "start" })} onSelect={() => select({ kind: "start" })} />);
  if (attempts.length === 0) {
    chain.push(<Connector key="c0" label={r.error ? { text: r.error.message, tone: statusTone(r.status) } : undefined} />);
  } else {
    chain.push(<Connector key="c0" />);
    attempts.forEach((a, i) => {
      chain.push(
        <AttemptCard key={`a${a.seq}`} a={a} selected={same(selected, { kind: "attempt", seq: a.seq })} onSelect={() => select({ kind: "attempt", seq: a.seq })} />,
      );
      chain.push(<Connector key={`c${a.seq}`} label={jumpLabel(a, attempts[i + 1])} />);
    });
  }
  chain.push(<EndCard key="end" r={r} selected={same(selected, { kind: "end" })} onSelect={() => select({ kind: "end" })} />);

  const panel = selected && (
    <SidePanel r={r} node={selected} attempts={attempts} onClose={() => setSelected(undefined)} />
  );

  const dots = { backgroundImage: "radial-gradient(var(--border-strong) 1px, transparent 1px)", backgroundSize: "20px 20px" };

  if (phone)
    return (
      <ScrollArea className="flex-1">
        <div className="flex flex-col items-center bg-subtle px-4 py-8" style={dots}>
          {chain}
        </div>
        {panel && (
          <div data-step-panel="" className={cn("border-t border-border", panelFade)}>
            {panel}
          </div>
        )}
      </ScrollArea>
    );

  return (
    <div className="flex min-h-0 flex-1 border-t border-border">
      <Canvas label={`Route of ${r.id}`} className="min-w-0 flex-1" worldClassName="flex flex-col items-center pb-40 pt-[clamp(32px,12vh,160px)]">
        {chain}
      </Canvas>
      {panel && (
        <div data-step-panel="" className={cn("flex w-[420px] shrink-0 border-l border-border bg-bg", panelFade)}>
          <ScrollArea label="Selected step" className="min-w-0 flex-1" contentClassName="flex min-h-full flex-col *:grow">
            {panel}
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

// The selected step's panel comes in from the edge it sits on when it appears (after Close, or
// with the page): shift + fade on the list tokens, a plain fade under reduced motion. Choosing
// another card swaps its content at once; Close takes it away at once (UI ticket 18).
const panelFade = "transition-[opacity,translate] duration-list-in ease-out starting:translate-x-(--motion-shift) starting:opacity-0";

/** A step on the canvas: the whole card is the button that selects it; a record's name on it is a link of its own, above it. */
function Card({ selected, onSelect, children, label }: { selected: boolean; onSelect: () => void; children: ReactNode; label: string }) {
  return (
    <div
      className={cn(
        // Border and ring change together: a press's feedback, on the hover tokens.
        "relative flex w-[min(360px,calc(100vw-48px))] items-center gap-3 rounded-xl border bg-bg px-4 py-3 text-left shadow-sm transition-[border-color,box-shadow] duration-hover ease-[ease]",
        selected ? "border-info ring-2 ring-info/30" : "border-border hover:border-border-strong",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={label}
        className="absolute inset-0 rounded-xl outline-none focus-visible:outline-2 focus-visible:outline-info"
      />
      {children}
    </div>
  );
}

function CardText({ small, big, mono }: { small: string; big: ReactNode; mono?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] text-fg-muted">{small}</span>
      <span className={cn("flex min-w-0 font-semibold", mono ? "font-mono text-[15px]" : "text-[16px]")}>
        {typeof big === "string" ? <span className="truncate">{big}</span> : big}
      </span>
    </span>
  );
}

function IconTile({ children }: { children: ReactNode }) {
  return <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-fg-muted">{children}</span>;
}

function StartCard({ r, selected, onSelect }: { r: RequestRecord; selected: boolean; onSelect: () => void }) {
  return (
    <Card selected={selected} onSelect={onSelect} label="Start">
      <IconTile>
        <User size={17} />
      </IconTile>
      <CardText
        small={`${r.caller.name} asked for`}
        big={
          r.pool ? (
            <RecordLink record={rec.pool(r.pool)} className="relative">
              {r.model}
            </RecordLink>
          ) : (
            r.model || "no model"
          )
        }
      />
      <Badge>Start</Badge>
    </Card>
  );
}

function AttemptCard({ a, selected, onSelect }: { a: Attempt; selected: boolean; onSelect: () => void }) {
  return (
    <Card selected={selected} onSelect={onSelect} label={`Attempt ${a.seq}`}>
      <ProviderLogo handle={a.provider} size={36} />
      <CardText
        small={`Attempt ${a.seq}`}
        big={
          a.upstream_key ? (
            <RecordLink record={rec.key(a.provider, a.upstream_key)} className="relative">
              {a.upstream_key}
            </RecordLink>
          ) : (
            "–"
          )
        }
        mono
      />
      <span className="shrink-0 text-[13.5px] text-fg-muted tabular">{secs(a.duration_ms)}</span>
      <Badge tone={a.status ? statusBadgeTone(a.status) : "red"}>{a.status || "–"}</Badge>
    </Card>
  );
}

function EndCard({ r, selected, onSelect }: { r: RequestRecord; selected: boolean; onSelect: () => void }) {
  const title =
    r.state === "in_progress" ? "In progress" : r.state === "interrupted" ? "Interrupted" : `${r.status} ${statusText(r.status)}`.trim();
  return (
    <Card selected={selected} onSelect={onSelect} label="End">
      <IconTile>
        <CornerDownLeft size={17} />
      </IconTile>
      <CardText small={`Response to ${r.caller.name}`} big={title} />
      {r.duration_ms !== undefined && <span className="shrink-0 text-[13.5px] text-fg-muted tabular">{secs(r.duration_ms)}</span>}
      <Badge>End</Badge>
    </Card>
  );
}

function Connector({ label }: { label?: { text: string; tone: Tone } }) {
  return (
    <div className="flex flex-col items-center" aria-hidden={!label}>
      <span className="size-2 rounded-full border border-border-strong bg-bg" />
      <span className={cn("w-px bg-border-strong", label ? "h-5" : "h-12")} />
      {label && (
        <>
          <span className={cn("max-w-[340px] truncate rounded-full px-3 py-1 text-[13.5px]", pillTone[label.tone])} title={label.text}>
            {label.text}
          </span>
          <span className="h-4 w-px bg-border-strong" />
        </>
      )}
      <svg width="9" height="6" viewBox="0 0 9 6" className="text-border-strong" aria-hidden="true">
        <path d="M0 0 L4.5 6 L9 0 Z" fill="currentColor" />
      </svg>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h3 className="mb-2 text-[15px] font-semibold">{title}</h3>
      <dl>{children}</dl>
    </section>
  );
}

function PanelHeader({ icon, title, subtitle, onClose }: { icon: ReactNode; title: string; subtitle: string; onClose: () => void }) {
  return (
    <header className="flex items-center gap-3">
      {icon}
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-[17px] font-semibold">{title}</h2>
        <p className="truncate text-[14px] text-fg-muted">{subtitle}</p>
      </div>
      <IconButton icon={X} label="Close" bordered onClick={onClose} />
    </header>
  );
}

function SidePanel({ r, node, attempts, onClose }: { r: RequestRecord; node: Node; attempts: Attempt[]; onClose: () => void }) {
  if (node.kind === "attempt") {
    const i = attempts.findIndex((a) => a.seq === node.seq);
    if (i >= 0) return <AttemptPanel a={attempts[i]} next={attempts[i + 1]} onClose={onClose} />;
  }
  const none = <span className="text-fg-subtle">–</span>;
  if (node.kind === "start")
    return (
      <div className="flex min-h-full flex-col p-6">
        <PanelHeader
          icon={
            <IconTile>
              <User size={17} />
            </IconTile>
          }
          title="Start"
          subtitle={`${r.caller.name} asked for ${r.model || "no model"}`}
          onClose={onClose}
        />
        <PanelSection title="Asked">
          <Row label="Caller">{r.caller.name}</Row>
          <Row label="Gateway Key">
            {r.caller.gateway_key_id ? <RecordLink record={rec.gatewayKey(r.caller.gateway_key_id)}>{r.caller.name}</RecordLink> : none}
          </Row>
          <Row label="Model">{r.model || none}</Row>
          {r.pool && (
            <Row label="Model Pool">
              <RecordLink record={rec.pool(r.pool)}>{r.pool}</RecordLink>
            </Row>
          )}
          <Row label="Path" mono>
            {r.route}
          </Row>
          <Row label="Shape">{longShape(r.shape_in)}</Row>
          <Row label="Stream">{r.stream ? "Yes" : "No"}</Row>
          <Row label="Arrived">{clockMs(r.started_at)}</Row>
        </PanelSection>
      </div>
    );
  return (
    <div className="flex min-h-full flex-col p-6">
      <PanelHeader
        icon={
          <IconTile>
            <CornerDownLeft size={17} />
          </IconTile>
        }
        title="End"
        subtitle={`Response to ${r.caller.name}`}
        onClose={onClose}
      />
      <div className="mt-6">
        <StatusPill r={r} />
      </div>
      {(r.error || r.summary) && (
        <PanelSection title="What happened">
          {r.error && (
            <Row label="Error" mono>
              {r.error.code}
            </Row>
          )}
          {r.error && <Row label="Message">{r.error.message}</Row>}
          {r.summary && (
            <Row label="Summary">
              <Summary text={r.summary} />
            </Row>
          )}
        </PanelSection>
      )}
      <PanelSection title="Answer">
        <Row label="Duration">{secs(r.duration_ms)}</Row>
        <Row label="First token">{r.first_byte_ms !== undefined && r.status < 400 ? secs(r.first_byte_ms) : none}</Row>
        <Row label="Attempts">{r.attempt_count}</Row>
        <Row label="Input tokens">{r.usage ? formatNumber(r.usage.input) : none}</Row>
        <Row label="Output tokens">{r.usage ? formatNumber(r.usage.output) : none}</Row>
      </PanelSection>
    </div>
  );
}

function AttemptPanel({ a, next, onClose }: { a: Attempt; next?: Attempt; onClose: () => void }) {
  const e = explain(a);
  return (
    <div className="flex min-h-full flex-col p-6">
      <PanelHeader icon={<ProviderLogo handle={a.provider} size={40} />} title={`Attempt ${a.seq}`} subtitle={`${a.upstream_key} on ${a.provider}`} onClose={onClose} />
      <div className="mt-7 flex items-center gap-3">
        <Badge tone={a.status ? statusBadgeTone(a.status) : "red"}>{a.status || "–"}</Badge>
        <span className="text-[19px] font-semibold">{a.status ? statusText(a.status) || "Answered" : "No response"}</span>
      </div>
      <p className="mt-1 text-[14.5px] text-fg-muted">
        {e.failed ? "Failed" : "Answered"} in {secs(a.duration_ms)}, at {clockMs(a.started_at)}
      </p>
      {e.failed && (
        <PanelSection title="What Iroha did">
          {e.reason && <Row label="Provider said">{e.reason}</Row>}
          <Row label="Failure Rule">{e.rule ?? <span className="text-fg-muted">None matched</span>}</Row>
          {e.keyState && (
            <Row label="Key State" className={keyStateClass[e.keyState.tone]}>
              <span title={e.action}>{e.keyState.text}</span>
            </Row>
          )}
          <Row label="Then">{thenText(a, next)}</Row>
        </PanelSection>
      )}
      <PanelSection title="Sent to">
        <AttemptTarget a={a} />
        <Row label="Shape">{longShape(a.shape)}</Row>
        <Row label="Model sent" mono>
          {a.wire_model}
        </Row>
        {servedModel(a) && (
          <Row label="Model served" mono>
            {servedModel(a)}
          </Row>
        )}
        {!e.failed && <Row label="First token">{secs(a.first_byte_ms)}</Row>}
      </PanelSection>
      {e.body && (
        <section className="mt-7">
          <h3 className="mb-3 text-[15px] font-semibold">Upstream error</h3>
          <CodeBlock>{pretty(e.body)}</CodeBlock>
        </section>
      )}
      {e.headers && <Headers headers={e.headers} />}
      <div className="flex-1" />
      <Link
        to={`/providers/${seg(a.provider)}/keys?key=${encodeURIComponent(a.upstream_key)}`}
        className={buttonClass("secondary", "lg", "mt-8 w-full")}
      >
        Open {a.upstream_key} <ArrowUpRight size={16} />
      </Link>
    </div>
  );
}
