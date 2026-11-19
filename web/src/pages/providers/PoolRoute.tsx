import type { ReactNode } from "react";
import { useState } from "react";
import { Link } from "react-router";
import { rec, RecordLink } from "@/sheets/RecordLink";
import { ArrowUpRight, CircleX, Layers, X } from "lucide-react";
import { seg } from "@/api/client";
import { useIsPhone } from "@/lib/media";
import { Button, buttonClass, IconButton, TextButton } from "@/ui/Button";
import type { Tone } from "@/ui/bits";
import { StatusDot } from "@/ui/bits";
import { Canvas } from "@/ui/Canvas";
import { cn } from "@/ui/cn";
import { ScrollArea } from "@/ui/ScrollArea";
import { Skeleton } from "@/ui/Skeleton";
import { EmptyState, ErrorState } from "@/ui/States";
import type { Pool, PreviewMember, RoutePreview, Shape } from "./api";
import { shapeLabel, SHAPES, useRoutePreview } from "./api";
import { PoolTile, ProviderTile, Select, skipText, toneText } from "./controls";
import { SAMPLE_PREVIEW } from "./samples";

// The Pool's Route tab (C19): GET /api/route-preview drawn as a chain of
// cards on a dotted canvas, refreshed every few seconds: where a Request for
// the Pool would go right now. The selected card's details sit beside it.
// The order of members and of each member's keys is the order the next
// Request makes its Attempts in (internal/gateway preview_next_test.go).

type Node = { kind: "start" } | { kind: "member"; position: number } | { kind: "end" };

const pill: Record<Tone, string> = {
  green: "bg-success-tint text-success",
  amber: "bg-warning-tint text-warning",
  red: "bg-danger-tint text-danger-text",
  blue: "bg-info-tint text-info",
  gray: "bg-muted text-fg-muted",
};

export function readiness(m: PreviewMember): { text: string; tone: Tone } {
  if (!m.planned) return { text: "Off", tone: "gray" };
  if (m.ready_keys > 0) return { text: `${m.ready_keys} of ${m.keys} ready`, tone: "green" };
  if (m.empty?.code === "cooling") return { text: "All cooling", tone: "amber" };
  if (m.empty?.code === "model_gap") return { text: "Model Gap", tone: "blue" };
  return { text: m.keys ? "None ready" : "No keys", tone: "red" };
}

/** The card selected when the Owner picked none: the first member tried, else the End. */
function firstNode(pv: RoutePreview): Node {
  const first = pv.members.find((m) => m.planned);
  return first ? { kind: "member", position: first.position } : { kind: "end" };
}

export function PoolRouteTab({ name, pool, onAdd }: { name: string; pool?: Pool; onAdd: () => void }) {
  const [shape, setShape] = useState<Shape>("openai-chat");
  const preview = useRoutePreview(name, shape);
  const phone = useIsPhone();
  const [selected, setSelected] = useState<Node>();
  const pv = preview.data;

  if (pool && pool.members.length === 0)
    return (
      <EmptyState
        icon={Layers}
        title="No members yet"
        description={`Add the Providers that serve ${name}; the route shows where each Request would go.`}
        action={
          <Button variant="primary" onClick={onAdd}>
            Add member
          </Button>
        }
      />
    );
  if (preview.isError && !pv) return <ErrorState title="Couldn't preview the route" error={preview.error} onRetry={() => void preview.refetch()} />;

  const current: Node | undefined = selected ?? (pv && firstNode(pv));
  const is = (n: Node) => !!current && current.kind === n.kind && (n.kind !== "member" || (current.kind === "member" && current.position === n.position));

  // The chain of cards for a preview: the live one, or the sample its skeleton is measured from.
  const chainOf = (pv: RoutePreview) => {
    const planned = pv.members.filter((m) => m.planned);
    const off = pv.members.filter((m) => !m.planned);
    const chain: ReactNode[] = [];
    chain.push(
      <Card key="start" selected={is({ kind: "start" })} onSelect={() => setSelected({ kind: "start" })} label="Start">
        <PoolTile name={name} version={pool?.maker} size={36} />
        <CardText small="A Caller asks for" big={name} />
        <Tag>Start</Tag>
      </Card>,
    );
    planned.forEach((m, i) => {
      chain.push(<Connector key={`c${m.position}`} label={i === 0 ? undefined : "If every key fails"} />);
      const r = readiness(m);
      chain.push(
        <Card key={`m${m.position}`} selected={is({ kind: "member", position: m.position })} onSelect={() => setSelected({ kind: "member", position: m.position })} label={`Member ${m.position}`}>
          <ProviderTile handle={m.provider} size={36} />
          <CardText small={`Member ${m.position}`} big={<ProviderName handle={m.provider} />} />
          <span className={cn("shrink-0 rounded-full px-2.5 py-0.5 text-[13.5px]", pill[r.tone])}>{r.text}</span>
        </Card>,
      );
    });
    chain.push(<Connector key="cend" label={planned.length ? "If every key fails" : undefined} />);
    chain.push(
      <Card key="end" selected={is({ kind: "end" })} onSelect={() => setSelected({ kind: "end" })} label="End">
        <IconTile>
          <CircleX size={17} />
        </IconTile>
        <CardText small="The Caller gets" big={pv.outcome ? `${pv.outcome.status}, ${pv.outcome.message}` : "The last member's error"} />
        <Tag>End</Tag>
      </Card>,
    );
    if (off.length) {
      chain.push(
        <p key="off" className="mb-2 mt-10 w-[min(400px,calc(100vw-48px))] text-[14px] text-fg-muted">
          Not tried right now
        </p>,
      );
      for (const m of off)
        chain.push(
          <div key={`o${m.position}`} className="mb-2">
            <Card dashed selected={is({ kind: "member", position: m.position })} onSelect={() => setSelected({ kind: "member", position: m.position })} label={`Member ${m.position}`}>
              <ProviderTile handle={m.provider} size={36} />
              <CardText small={`Member ${m.position}`} big={<ProviderName handle={m.provider} />} muted />
              <Tag>{m.not_planned === "off" ? "Off" : m.not_planned === "model_not_offered" ? "Not offered" : "Unavailable"}</Tag>
            </Card>
          </div>,
        );
    }
    return chain;
  };
  const chain = (
    <Skeleton data={pv} sample={SAMPLE_PREVIEW} id={phone ? "pool-route:phone" : "pool-route"} label="Loading the route">
      {(pv) => <div className="flex flex-col items-center">{chainOf(pv)}</div>}
    </Skeleton>
  );

  const panel = (
    <Skeleton data={pv} sample={SAMPLE_PREVIEW} label="Loading the route's details" className="skeleton-fill">
      {(pv) => <SidePanel pv={pv} pool={pool} node={current ?? firstNode(pv)} onClose={() => setSelected(undefined)} />}
    </Skeleton>
  );
  const dots = { backgroundImage: "radial-gradient(var(--border-strong) 1px, transparent 1px)", backgroundSize: "20px 20px" };

  const live = (
    // Over the canvas it stays one row at any width, so it never reaches the Start card: the note
    // truncates first. On phones it sits above the chain and wraps. (Select is w-full inside, so
    // the box around it sets its width.)
    <div className={cn("flex items-center gap-2", phone && "flex-wrap")}>
      <span className="inline-flex h-8 min-w-0 items-center gap-2 rounded-full border border-border bg-bg px-3 text-[14px] shadow-sm">
        <StatusDot tone={preview.isError ? "red" : "green"} />
        <span className={cn("font-medium", preview.isError ? "text-danger-text" : "text-success")}>{preview.isError ? "Stale" : "Live"}</span>
        <span className="truncate text-fg-muted">Where a request would go right now</span>
      </span>
      <div className="w-48 shrink-0">
        <Select<Shape> aria-label="The Caller's Shape" value={shape} onValueChange={setShape} items={SHAPES.map((s) => ({ value: s.value, label: `As ${s.label}` }))} />
      </div>
    </div>
  );

  if (phone)
    return (
      <div>
        {live}
        <div className="-mx-4 mt-4 bg-subtle px-4 py-8" style={dots}>
          {chain}
        </div>
        <div className="-mx-4 border-t border-border">{panel}</div>
      </div>
    );

  return (
    <div className="flex h-[max(560px,calc(100dvh-300px))] overflow-hidden rounded-xl border border-border">
      <Canvas
        label={`Route of ${name}`}
        className="min-w-0 flex-1"
        worldClassName="flex flex-col items-center pb-28 pt-20"
        overlay={<div className="absolute left-0 top-0 p-4">{live}</div>}
      >
        {chain}
      </Canvas>
      <ScrollArea label="Selected step" className="w-[380px] shrink-0 border-l border-border bg-bg" contentClassName="flex min-h-full flex-col *:grow">
        {panel}
      </ScrollArea>
    </div>
  );
}

function Card({
  selected,
  onSelect,
  children,
  label,
  dashed,
}: {
  selected: boolean;
  onSelect: () => void;
  children: ReactNode;
  label: string;
  dashed?: boolean;
}) {
  // The whole card is the button that selects it; a record's name on it is a link of its own, above it.
  return (
    <div
      className={cn(
        // Selection and hover change colour and ring only (duration-hover); a card doesn't scale on press.
        "relative flex w-[min(400px,calc(100vw-48px))] items-center gap-3 rounded-xl border bg-bg px-4 py-3 text-left shadow-sm transition-[box-shadow,border-color] duration-hover ease-[ease]",
        dashed && "border-dashed bg-bg/70 shadow-none",
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

function CardText({ small, big, muted }: { small: string; big: ReactNode; muted?: boolean }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] text-fg-muted">{small}</span>
      <span className={cn("flex min-w-0 text-[16px] font-semibold", muted && "text-fg-muted")}>{typeof big === "string" ? <span className="truncate">{big}</span> : big}</span>
    </span>
  );
}

/** A member's Provider on its card: a link to its sheet, above the card's button. */
function ProviderName({ handle }: { handle: string }) {
  return (
    <RecordLink record={rec.provider(handle)} className="relative">
      {handle}
    </RecordLink>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-[13px] text-fg-muted">{children}</span>;
}

function IconTile({ children }: { children: ReactNode }) {
  return <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-fg-muted">{children}</span>;
}

function Connector({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center" aria-hidden>
      <span className="size-2 rounded-full border border-border-strong bg-bg" />
      <span className={cn("w-px bg-border-strong", label ? "h-4" : "h-12")} />
      {label && (
        <>
          <span className="rounded-full border border-border bg-bg px-3 py-1 text-[13.5px] text-fg-muted">{label}</span>
          <span className="h-4 w-px bg-border-strong" />
        </>
      )}
      <svg width="9" height="6" viewBox="0 0 9 6" className="text-border-strong">
        <path d="M0 0 L4.5 6 L9 0 Z" fill="currentColor" />
      </svg>
    </div>
  );
}

function Header({ icon, title, subtitle, onClose }: { icon: ReactNode; title: ReactNode; subtitle: string; onClose: () => void }) {
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

function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mt-7">
      <h3 className="mb-2 text-[15px] font-semibold">
        {title}
        {count !== undefined && <span className="ml-2 font-normal text-fg-muted tabular">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex gap-4 py-1.5 text-[14.5px]">
      <dt className="w-28 shrink-0 text-fg-muted">{label}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono text-[13.5px]")}>{children}</dd>
    </div>
  );
}

function SidePanel({ pv, pool, node, onClose }: { pv: RoutePreview; pool?: Pool; node: Node; onClose: () => void }) {
  const name = pv.pool ?? pv.model;
  if (node.kind === "member") {
    const m = pv.members.find((x) => x.position === node.position);
    if (m) return <MemberPanel m={m} pool={name} onClose={onClose} />;
  }
  if (node.kind === "start")
    return (
      <div className="p-6">
        <Header icon={<PoolTile name={name} version={pool?.maker} size={40} />} title={name} subtitle="Model Pool" onClose={onClose} />
        <p className="mt-6 text-[15px] text-fg-muted">
          A Caller sends {name} as the model, in the {shapeLabel(pv.shape)} Shape. Iroha tries the members top to bottom, each member's ready keys in order.
        </p>
        <Section title="Budget">
          <dl>
            <Row label="Attempts">{pv.budget.max_attempts ? `${pv.budget.max_attempts} at most` : "Each Provider's own"}</Row>
            <Row label="First byte">{pv.budget.first_byte_seconds ? `${pv.budget.first_byte_seconds} s, across members` : "Each Provider's own"}</Row>
          </dl>
        </Section>
        <Section title="Right now">
          <dl>
            <Row label="Ready">{`${pv.ready} candidate${pv.ready === 1 ? "" : "s"}`}</Row>
            <Row label="Checked">{new Date(pv.at).toLocaleTimeString()}</Row>
          </dl>
        </Section>
      </div>
    );
  return (
    <div className="p-6">
      <Header
        icon={
          <IconTile>
            <CircleX size={17} />
          </IconTile>
        }
        title="End"
        subtitle={`What the Caller gets when no member serves`}
        onClose={onClose}
      />
      {pv.outcome ? (
        <>
          <p className="mt-6 text-[19px] font-semibold">
            {pv.outcome.status}, {pv.outcome.message}
          </p>
          <p className="mt-2 text-[15px] text-fg-muted">Nothing is ready, so the next Request fails before any Attempt.</p>
          {pv.outcome.hint && <p className="mt-2 text-[15px] text-fg-muted">{pv.outcome.hint}</p>}
          <p className="mt-4 font-mono text-[13px] text-fg-muted">{pv.outcome.code}</p>
        </>
      ) : (
        <p className="mt-6 text-[15px] text-fg-muted">
          A Request that fails on every member, or runs out of its budget, returns the last member's error to the Caller, in the Caller's Shape.
        </p>
      )}
    </div>
  );
}

function MemberPanel({ m, pool, onClose }: { m: PreviewMember; pool: string; onClose: () => void }) {
  const [all, setAll] = useState(false);
  const ready = [...new Map(m.candidates.map((c) => [c.upstream_key, c])).values()];
  const shown = all ? ready : ready.slice(0, 8);
  const endpoints = [...new Set(m.candidates.map((c) => c.endpoint))];
  const first = m.candidates[0];
  const r = readiness(m);

  return (
    <div className="flex min-h-full flex-col p-6">
      <Header
        icon={<ProviderTile handle={m.provider} size={40} />}
        title={<RecordLink record={rec.provider(m.provider)}>{m.provider}</RecordLink>}
        subtitle={`Member ${m.position} of ${pool}`}
        onClose={onClose}
      />
      <h3 className="mt-7 text-[20px] font-semibold">
        {m.planned ? (m.ready_keys ? `${m.ready_keys} of ${m.keys} keys ready` : (m.empty?.message ?? r.text)) : r.text === "Off" ? "Switched off" : "Not tried"}
      </h3>
      <p className="mt-2 text-[15px] text-fg-muted">
        {!m.planned
          ? (m.reason ?? "Iroha skips this member.")
          : m.ready_keys
            ? "Iroha tries the ready keys in this order. Skipped keys come back on their own when they recover."
            : (m.empty?.until && `Back ${new Date(m.empty.until).toLocaleTimeString()}. `) || "Iroha moves on to the next member."}
      </p>

      <Section title="Sends">
        <dl>
          <Row label="Model" mono>
            {first?.wire_model ?? m.model}
          </Row>
          {endpoints.length > 0 && (
            <Row label="Endpoint">
              <span className="flex flex-wrap gap-x-2">
                {endpoints.map((e, i) => (
                  <span key={e} className="inline-flex min-w-0">
                    <RecordLink record={rec.endpoint(m.provider, e)}>{e}</RecordLink>
                    {i < endpoints.length - 1 && ","}
                  </span>
                ))}
              </span>
            </Row>
          )}
          {first && <Row label="Shape">{first.translated ? `${shapeLabel(first.shape)}, translated` : shapeLabel(first.shape)}</Row>}
        </dl>
      </Section>

      {m.skipped.length > 0 && (
        <Section title="Skipped right now" count={m.skipped.length}>
          <ul>
            {m.skipped.map((s, i) => {
              const t = skipText(s);
              return (
                <li key={i} className="flex items-center gap-3 py-1.5 text-[14.5px]">
                  <StatusDot tone={t.tone} />
                  <span className="flex min-w-0 flex-1">
                    <RecordLink record={rec.key(m.provider, s.upstream_key)} className="font-mono text-[13.5px]">
                      {s.upstream_key}
                    </RecordLink>
                  </span>
                  <span className={cn("shrink-0", toneText[t.tone])} title={s.model ? `for ${s.model}` : undefined}>
                    {t.text}
                  </span>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {ready.length > 0 && (
        <Section title="Ready, in order" count={ready.length}>
          <ol>
            {shown.map((c, i) => (
              <li key={c.upstream_key} className="flex items-center gap-3 py-1.5 text-[14.5px]">
                <StatusDot tone="green" />
                <span className="flex min-w-0 flex-1">
                  <RecordLink record={rec.key(m.provider, c.upstream_key)} className="font-mono text-[13.5px]">
                    {c.upstream_key}
                  </RecordLink>
                </span>
                <span className="shrink-0 text-fg-muted">{i === 0 ? "next" : `#${i + 1}`}</span>
              </li>
            ))}
          </ol>
          {ready.length > shown.length && (
            <TextButton className="mt-1 text-[14.5px]" aria-label={`Show ${ready.length - shown.length} more ready keys`} onClick={() => setAll(true)}>
              {ready.length - shown.length} more
            </TextButton>
          )}
        </Section>
      )}

      <div className="flex-1" />
      <Link to={`/providers/${seg(m.provider)}/keys`} className={buttonClass("secondary", "lg", "mt-8 w-full")}>
        Open {m.provider} <ArrowUpRight size={16} />
      </Link>
    </div>
  );
}
