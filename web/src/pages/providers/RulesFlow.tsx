import type { AriaAttributes, ReactNode } from "react";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { CircleX } from "lucide-react";
import { formatNumber } from "@/lib/format";
import { OUTCOME_KEY } from "@/lib/outcomes";
import { StatusDot } from "@/ui/bits";
import { cn } from "@/ui/cn";
import type { Classification, Outcome, Rule } from "./api";
import { Pill, ProviderTile } from "./controls";
import { Connector, IconTile, Tag } from "./PoolRoute";

// The Rules tab's Flow view (UI ticket 31): the same rules as the table, drawn
// as the path a failed Attempt takes through them (internal/rules Set.Classify).
// Rules are tried top to bottom in the order the API lists them; switched-off
// rules are passed over; the first rule whose every condition holds decides
// what happens to the Upstream Key and the Request. When none matches, no
// response or a 5xx tries the next key and anything else returns the error.

/** What a rule matches, as its conditions read: any of a list, all of the conditions. */
export function matchWords(r: Pick<Rule, "status" | "code" | "body" | "header">): string {
  const parts: string[] = [r.status?.length ? r.status.join(" or ") : "Any status"];
  if (r.code?.length) parts.push(`code ${r.code.join(" or ")}`);
  if (r.body) parts.push(`body has “${r.body}”`);
  for (const h of Object.keys(r.header ?? {})) parts.push(`header ${h}`);
  return parts.join(" and ");
}

export const scopeWords = (r: Rule) => (r.provider ? `only ${r.provider}` : r.host ? `on ${r.host}` : undefined);

/**
 * Where a tried failure went at one step (UI ticket 34): `missed` (tried, didn't match), `match`
 * (decided here) or `unreached` (after the match). Undefined when nothing was tried, and for a
 * switched-off rule, which is skipped either way.
 */
export type Trace = "missed" | "match" | "unreached";

/** Each rule's trace for a tried failure, and the End card's; nothing for an answer that isn't a failure. */
export function traceOf(rules: Rule[], tried: Classification | undefined): { steps: (Trace | undefined)[]; end?: Trace; at: number } {
  const none = { steps: rules.map(() => undefined), at: -1 };
  if (!tried?.failure) return none;
  // Where it stopped: the rule that matched, or past the last rule (the End card).
  const at = tried.rule ? rules.findIndex((r) => r.name === tried.rule) : rules.length;
  if (at < 0) return none;
  return {
    steps: rules.map((r, i) => (i === at ? "match" : i > at ? "unreached" : r.enabled ? "missed" : undefined)),
    end: at === rules.length ? "match" : "unreached",
    at,
  };
}

// A lit path: the route view's lines in the focus colour (the Connector reads --border-strong).
const lit = "[--border-strong:var(--info)] [--color-border-strong:var(--info)]";
// The highlight changes colour only, on the hover duration (a colour fade is kept under reduced motion).
const traceMotion = "transition-[opacity,border-color,box-shadow,background-color,color] duration-hover ease-[ease]";

/**
 * `stacked`: too narrow for a rule and its match branch side by side (phones, a tablet, a narrow window
 * beside the chat): each step then carries what a match does inside it, under its conditions.
 * `tried`: a failure tried against these rules (UI ticket 34); the path it took lights up.
 */
export function RulesFlow({
  handle,
  rules,
  onOpen,
  aside,
  stacked,
  tried,
}: {
  handle: string;
  rules: Rule[];
  onOpen: (r: Rule) => void;
  aside: (r: Rule) => ReactNode;
  stacked: boolean;
  tried?: Classification;
}) {
  const column = stacked ? "w-full max-w-[560px]" : "w-[520px] self-start";
  const most = Math.max(0, ...rules.map((r) => r.hits));
  const trace = traceOf(rules, tried);
  // The rail under a step is lit while the failure is still falling: down to the step that matched.
  const fell = (i: number) => i < trace.at;
  // The fallback that decided a failure no rule matched: no response or 5xx tries the next key.
  const fallback = trace.end === "match" && tried ? (tried.outcome === "fail_request" ? "caller" : "next") : undefined;
  return (
    <div className="flex flex-col items-center">
      <Box className={column} trace={trace.end && "missed"}>
        <ProviderTile handle={handle} size={36} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-fg-muted">A failed Attempt on</span>
          <span className="block truncate text-[16px] font-semibold">{handle}</span>
        </span>
        <Tag>Start</Tag>
      </Box>
      <Rail className={cn(column, trace.end && lit)} label="Tried in order; the first rule that matches decides" />
      <ol aria-label="Failure Rules, in the order they're tried" className="flex w-full flex-col">
        {rules.map((r, i) => (
          <li key={r.name} className="flex flex-col items-center" data-trace={trace.steps[i]} aria-current={trace.steps[i] === "match" ? "step" : undefined}>
            <RuleStep r={r} n={i + 1} most={most} stacked={stacked} onOpen={() => onOpen(r)} aside={aside(r)} trace={trace.steps[i]} tried={tried} />
            <Rail className={cn(column, fell(i) && lit, trace.steps[i] === "unreached" && "opacity-50")} />
          </li>
        ))}
      </ol>
      <Box
        className={column}
        trace={trace.end}
        role="group"
        aria-label="No rule matched"
        aria-current={trace.end === "match" ? "step" : undefined}
      >
        <IconTile>
          <CircleX size={17} />
        </IconTile>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-fg-muted">No rule matched</span>
          {/* A failure that got here: the line of the fallback that decided it stays, the other one dims. */}
          <span className={cn("block text-[15px] font-semibold", traceMotion, fallback === "caller" && "text-fg-subtle")}>No response or 5xx: try the next key</span>
          <span className={cn("block text-[15px] font-semibold", traceMotion, fallback === "next" && "text-fg-subtle")}>Anything else: return the error to the Caller</span>
        </span>
        {trace.end === "match" ? <Pill tone="blue">Decided here</Pill> : <Tag>End</Tag>}
      </Box>
    </div>
  );
}

/** A card of the flow, as on the route view (C19): white, rounded, bordered; `trace` lights it on a tried failure's path. */
function Box({ children, className, dashed, trace, ...aria }: { children: ReactNode; className?: string; dashed?: boolean; trace?: Trace } & AriaAttributes & { role?: string }) {
  return (
    <div
      {...aria}
      data-trace={trace}
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-bg px-4 py-3 shadow-sm",
        traceMotion,
        dashed ? "border-dashed border-border shadow-none" : "border-border",
        trace === "missed" && "border-info",
        trace === "match" && "border-info ring-2 ring-info/25",
        trace === "unreached" && "opacity-50",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * The line a failure falls down, under the rules' column: it lines up with the
 * middle of the rule cards.
 */
function Rail({ label, className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex justify-center", className)}>
      <Connector label={label} short />
    </div>
  );
}

/**
 * One rule as a step of the flow. `onOpen` puts a button over the card (the
 * Flow view opens the rule's sheet); the rule's sheet shows the step without
 * it (UI ticket 33), stacked. `trace` and `tried` mark it on a tried
 * failure's path (UI ticket 34).
 */
export function RuleStep({
  r,
  n,
  most,
  stacked,
  onOpen,
  aside,
  trace,
  tried,
}: {
  r: Rule;
  n: number;
  most: number;
  stacked: boolean;
  onOpen?: () => void;
  aside?: ReactNode;
  trace?: Trace;
  tried?: Classification;
}) {
  const off = !r.enabled;
  const scope = scopeWords(r);
  const match = trace === "match";
  // What this step does to the tried failure: the engine's words (a Retry-After changes the time), else the rule's.
  const effect = match && tried ? tried : undefined;
  const card = (
    <div
      data-off={off || undefined}
      className={cn(
        // As on the route view: hover changes border only (duration-hover); no press scale on a card.
        // Width comes from the layout line below only: cn doesn't merge, and a w-full here beat w-[520px], pushing the branch off screen.
        "relative rounded-xl border bg-bg shadow-sm",
        traceMotion,
        onOpen && "hover:border-border-strong",
        stacked ? "w-full max-w-[560px]" : "w-[520px] shrink-0",
        off ? "border-dashed border-border bg-bg/70 shadow-none" : "border-border",
        match && "border-info ring-2 ring-info/25 hover:border-info",
        trace === "unreached" && "opacity-50",
      )}
    >
      {onOpen && <SdkButton onClick={onOpen} aria-label={`Open ${r.name}`} className="absolute inset-0 rounded-xl outline-none focus-visible:outline-2 focus-visible:outline-info" />}
      <div className={cn("flex gap-3 px-4 py-3", stacked ? "items-start" : "items-center")}>
        <span
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-full border text-[13px] tabular",
            traceMotion,
            off ? "border-dashed border-border text-fg-subtle" : match ? "border-info bg-info-tint font-semibold text-info" : "border-border-strong text-fg-muted",
          )}
        >
          {n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cn("text-[15px] font-semibold", stacked ? "min-w-0 [overflow-wrap:anywhere]" : "truncate", off && "text-fg-muted")} title={r.description}>
              {r.name}
            </span>
            {r.overrides ? (
              <Pill tone="blue">Replaces built-in</Pill>
            ) : (
              <Pill>{r.source === "builtin" ? "Built-in" : "Custom"}</Pill>
            )}
            {off && <Pill>Off, skipped</Pill>}
            {trace === "missed" && <Pill>Didn't match</Pill>}
            {match && <Pill tone="blue">Matched</Pill>}
          </span>
          {/* Phones wrap what it matches rather than cut it: it's the half of the rule that can't be read elsewhere on the step. */}
          <span className={cn("mt-0.5 block font-mono text-[13px] text-fg-muted", stacked ? "[overflow-wrap:anywhere]" : "truncate")} title={matchWords(r)}>
            {matchWords(r)}
          </span>
          {(scope || r.overrides) && (
            <span className={cn("mt-0.5 block text-[13px] text-fg-muted", !stacked && "truncate")}>
              {[scope && `Tried early: ${scope}`, r.overrides && `Built-in did: ${r.builtin_key_effect ?? r.overrides.outcome}`].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        {!stacked && <Hits hits={r.hits} most={most} />}
        {aside && <span className="relative shrink-0">{aside}</span>}
      </div>
      {stacked && (
        <div className={cn("border-t px-4 py-2.5", off ? "border-dashed border-border" : "border-border")}>
          <span className="mb-1 flex items-start justify-between gap-3">
            <span className={cn("text-[12.5px]", match ? "font-medium text-info" : "text-fg-muted")}>{off ? "Would, if it were on" : match ? "It matches, so" : "If it matches"}</span>
            <Hits hits={r.hits} most={most} />
          </span>
          <Effect r={effect ?? r} />
        </div>
      )}
    </div>
  );
  if (stacked) return card;
  // A tried failure that passed this rule leaves its branch dim, so the lit path reads at a glance.
  const dim = trace === "missed" || trace === "unreached";
  return (
    <div className="flex w-full items-center">
      {card}
      {/* The match branch: the failure leaves the flow here when this rule matches. */}
      <div className={cn("flex w-28 shrink-0 items-center", traceMotion, match && lit, dim && "opacity-40")} aria-hidden>
        <span className={cn("h-px flex-1", off ? "border-t border-dashed border-border-strong" : "bg-border-strong")} />
        <span className={cn("mx-1 text-[12.5px]", off ? "text-fg-subtle" : match ? "font-medium text-info" : "text-fg-muted")}>{off ? "skipped" : "matches"}</span>
        <span className={cn("h-px w-3", off ? "border-t border-dashed border-border-strong" : "bg-border-strong")} />
        {!off && (
          <svg width="6" height="9" viewBox="0 0 6 9" className="text-border-strong">
            <path d="M0 0 L6 4.5 L0 9 Z" fill="currentColor" />
          </svg>
        )}
      </div>
      <Box dashed={off} trace={match ? "match" : undefined} className={cn("min-w-0 max-w-[380px] flex-1 py-2.5", off && "opacity-60", dim && "opacity-40")}>
        <Effect r={effect ?? r} />
      </Box>
    </div>
  );
}

/** What a match does: to the Upstream Key (with its Key State colour) and to the Request. */
function Effect({ r }: { r: Pick<Rule, "key_effect" | "request_effect"> & { outcome?: Outcome } }) {
  return (
    <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[14px]">
      <dt className="text-fg-muted">Upstream Key</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <StatusDot tone={r.outcome ? OUTCOME_KEY[r.outcome].tone : "gray"} />
        <span className="truncate">{r.key_effect}</span>
      </dd>
      <dt className="text-fg-muted">Request</dt>
      <dd className={cn("truncate", r.outcome === "fail_request" && "font-medium")}>{r.request_effect}</dd>
    </dl>
  );
}

/** Today's hits: the count and a bar against the busiest rule, so the rules that fire stand out. */
function Hits({ hits, most }: { hits: number; most: number }) {
  return (
    <span className="flex w-20 shrink-0 flex-col items-end gap-1" title={`${formatNumber(hits)} hit${hits === 1 ? "" : "s"} today`}>
      <span className="text-[13px] text-fg-muted tabular">
        <span className={cn("text-[14px]", hits ? "font-semibold text-fg" : "text-fg-subtle")}>{formatNumber(hits)}</span> today
      </span>
      <span className="h-1 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
        <span className="block h-full rounded-full bg-info" style={{ width: most ? `${Math.max(hits ? 6 : 0, (hits / most) * 100)}%` : 0 }} />
      </span>
    </span>
  );
}
