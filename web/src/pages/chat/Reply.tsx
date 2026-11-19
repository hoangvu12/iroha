import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ChevronDown, CircleAlert, ExternalLink, Lightbulb, Wrench } from "lucide-react";
import { animateIn } from "@ui-sdk/core";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { seg } from "@/api/client";
import { formatNumber } from "@/lib/format";
import { useRequest } from "@/pages/requests/api";
import { AttemptList } from "@/pages/requests/Attempts";
import { secs } from "@/pages/requests/bits";
import { SAMPLE_REQUEST } from "@/pages/requests/samples";
import { cn } from "@/ui/cn";
import { Skeleton } from "@/ui/Skeleton";
import { bareModel } from "./api";
import { ModelTile } from "./Picker";
import type { AssistantTurn, Part, Round } from "./store";

// One assistant reply (C15): the model, then what it said and called in
// order, a caret while it streams, a collapsed Details block (serving key,
// timings, tokens, tool-call check) and, when it failed, the same Attempt
// explanation as the Requests page.

// The collapse recipe (architecture.md "UI motion system"); the tokens hold it still under reduced motion.
const collapseClass = "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-collapse ease-out data-starting-style:h-0 data-ending-style:h-0";
const chevronClass = "shrink-0 transition-[rotate] duration-collapse ease-out";

/** get_weather({ "city": "Hanoi" }) */
export function callText(name: string, args: string): string {
  let shown = args.trim();
  try {
    const one = JSON.stringify(JSON.parse(shown || "{}"));
    shown = one.length <= 90 ? one.replace(/^\{"/, '{ "').replace(/"\}$/, '" }').replace(/":/g, '": ').replace(/,"/g, ', "') : JSON.stringify(JSON.parse(shown), null, 2);
  } catch {
    /* as written: the check says what is wrong */
  }
  return `${name}(${shown})`;
}

export function Reply({ turn }: { turn: AssistantTurn }) {
  const streaming = turn.rounds.some((r) => r.status === "streaming");
  const failed = turn.rounds.find((r) => r.status === "failed");
  const first = turn.rounds[0];
  // Only a failure that happens while the reply is on screen enters; one in the history is just there.
  const failedAtMount = useRef(!!failed);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[14.5px] text-fg-muted">
        <ModelTile model={turn.model} size={22} />
        <span className="truncate">{bareModel(turn.model)}</span>
        {turn.replayed && <span className="text-[12.5px]">from the original Request</span>}
      </div>
      {turn.rounds.map((r, i) => (
        <RoundView key={i} r={r} last={i === turn.rounds.length - 1} streaming={r.status === "streaming"} />
      ))}
      {turn.rounds.length === 0 && <Caret />}
      {failed && <Failure r={failed} enter={!failedAtMount.current} />}
      {!streaming && first?.requestId && !turn.replayed && <Details round={first} rounds={turn.rounds} />}
    </div>
  );
}

function Caret() {
  return <span aria-label="Streaming" className="inline-block h-[1.1em] w-[2px] translate-y-[3px] animate-pulse bg-fg" />;
}

function RoundView({ r, last, streaming }: { r: Round; last: boolean; streaming: boolean }) {
  const lastText = r.parts.length - 1;
  return (
    <>
      {r.parts.map((p, i) => (
        <PartView key={i} p={p} caret={streaming && last && i === lastText} />
      ))}
      {streaming && r.parts.length === 0 && <Caret />}
      {r.status === "stopped" && <p className="text-[13px] text-fg-muted">Stopped.</p>}
    </>
  );
}

function PartView({ p, caret }: { p: Part; caret: boolean }) {
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  if (p.kind === "tool")
    return (
      <div className="flex max-w-full items-start gap-2 self-start rounded-lg border border-border bg-bg px-3 py-2 font-mono text-[13px]">
        <Wrench size={14} className="mt-0.5 shrink-0 text-fg-muted" />
        <span className="min-w-0 whitespace-pre-wrap break-words">{callText(p.name, p.args)}</span>
      </div>
    );
  if (p.kind === "reasoning")
    return (
      // Open while it streams (open on first paint, so no animation). It folds at
      // once when the answer starts: the stream moved it, not the Owner, and
      // streamed content changes in place. Only the Owner's own toggles animate.
      <Collapsible
        open={open || caret}
        onOpenChange={(o) => {
          setOpen(o);
          setTouched(true);
        }}
        className="text-[13.5px] text-fg-muted"
      >
        <CollapsibleTrigger className="group inline-flex items-center gap-1.5 hover:text-fg">
          <Lightbulb size={14} /> Thinking
          <ChevronDown size={14} aria-hidden className={cn(chevronClass, "-rotate-90 group-data-open:rotate-0", !touched && "transition-none")} />
        </CollapsibleTrigger>
        <CollapsiblePanel className={cn(collapseClass, !touched && "transition-none")}>
          <p className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3">{p.text}</p>
        </CollapsiblePanel>
      </Collapsible>
    );
  return (
    <p className="whitespace-pre-wrap break-words text-[15px] leading-relaxed">
      {p.text}
      {caret && <Caret />}
    </p>
  );
}

function Failure({ r, enter }: { r: Round; enter: boolean }) {
  const navigate = useNavigate();
  const req = useRequest(r.requestId);
  const attempts = !!req.data && req.data.attempt_count > 0;
  // The Attempt list below spells out each Attempt; the headline needn't.
  const text = attempts ? (r.error ?? "").split(/: #1 /)[0] : r.error;
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (enter && ref.current) return animateIn(ref.current);
  }, [enter]);
  return (
    <div
      ref={ref}
      data-failure=""
      className="rounded-xl border border-border bg-danger-tint/40 px-3.5 py-3 transition-[opacity,translate] duration-list-in ease-out data-starting-style:translate-y-(--motion-shift-sm) data-starting-style:opacity-0"
    >
      <p className="flex items-start gap-2 text-[14px] text-danger-text">
        <CircleAlert size={16} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-words">{text}</span>
      </p>
      {attempts && req.data && (
        <div className="mt-3 text-fg">
          <AttemptList r={req.data} loading={req.isFetching} onOpenRoute={() => navigate(`/requests/${seg(req.data.id)}/route`)} />
        </div>
      )}
    </div>
  );
}

function Details({ round, rounds }: { round: Round; rounds: Round[] }) {
  // Fetched as soon as the trigger is pointed at or focused, so the panel opens
  // with its facts at their full height (nothing re-renders or grows while it
  // animates), and kept after, so they stay while it folds away.
  const [wanted, setWanted] = useState(false);
  const want = () => setWanted(true);
  const req = useRequest(wanted ? round.requestId : undefined);
  const r = req.data;
  const check = round.toolCheck;
  return (
    <Collapsible onOpenChange={(open) => open && want()}>
      <CollapsibleTrigger onPointerEnter={want} onFocus={want} className="group inline-flex items-center gap-1 text-[13.5px] text-fg-muted hover:text-fg">
        Details
        <ChevronDown size={14} aria-hidden className={cn(chevronClass, "group-data-open:rotate-180")} />
      </CollapsibleTrigger>
      <CollapsiblePanel className={collapseClass}>
        <div className="mt-2 rounded-xl border border-border bg-bg px-4 py-3">
          <Skeleton data={r} sample={SAMPLE_REQUEST} label="Loading the Request">
          {(r) => (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 min-[400px]:grid-cols-4">
              <Fact label="Served by" mono>
                {r.upstream_key || "–"}
              </Fact>
              <Fact label="Endpoint">{r.endpoint || "–"}</Fact>
              <Fact label="Attempts">{r.attempt_count}</Fact>
              <Fact label="Tool call">
                {check ? <span className={check.passed ? "text-success" : "text-danger-text"}>{check.passed ? "Passed" : "Failed"}</span> : <span className="text-fg-muted">Off</span>}
              </Fact>
              <Fact label="First token">{secs(r.first_byte_ms)}</Fact>
              <Fact label="Duration">{secs(r.duration_ms)}</Fact>
              <Fact label="Input">{r.usage ? formatNumber(r.usage.input) : "–"}</Fact>
              <Fact label="Output">{r.usage ? formatNumber(r.usage.output) : "–"}</Fact>
            </dl>
          )}
          </Skeleton>
          {check && (
            <div className="mt-3 border-t border-border pt-3 text-[13.5px]">
              <p className="text-fg-muted">{check.reason}</p>
              {check.name && <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[12.5px]">{`${check.name} ${check.arguments ?? ""}`}</pre>}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-border pt-2.5 text-[13px]">
            {rounds.map(
              (x, i) =>
                x.requestId && (
                  <Link key={x.requestId} to={`/requests?request=${seg(x.requestId)}`} className="inline-flex items-center gap-1 text-info hover:underline">
                    {i === 0 ? "Open in Requests" : "Follow-up Request"} <ExternalLink size={12} />
                  </Link>
                ),
            )}
          </div>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function Fact({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12.5px] text-fg-muted">
        {label}
      </dt>
      <dd className={cn("mt-0.5 truncate text-[14.5px]", mono && "font-mono text-[13.5px]")}>{children}</dd>
    </div>
  );
}
