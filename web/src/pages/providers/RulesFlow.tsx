import type { ReactNode } from "react";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { CircleX } from "lucide-react";
import { formatNumber } from "@/lib/format";
import type { Tone } from "@/ui/bits";
import { StatusDot } from "@/ui/bits";
import { cn } from "@/ui/cn";
import type { Outcome, Rule } from "./api";
import { OUTCOMES } from "./api";
import { Pill, ProviderTile } from "./controls";
import { Connector, IconTile, Tag } from "./PoolRoute";

// The Rules tab's Flow view (UI ticket 31): the same rules as the table, drawn
// as the path a failed Attempt takes through them (internal/rules Set.Classify).
// Rules are tried top to bottom in the order the API lists them; switched-off
// rules are passed over; the first rule whose every condition holds decides
// what happens to the Upstream Key and the Request. When none matches, no
// response or a 5xx tries the next key and anything else returns the error.

const keyTone = (o: Outcome): Tone =>
  o === "invalid" ? "red" : o === "cooling_key" || o === "cooling_key_model" ? "amber" : o === "model_gap" ? "blue" : "gray";

/** What a rule matches, as its conditions read: any of a list, all of the conditions. */
export function matchWords(r: Pick<Rule, "status" | "code" | "body" | "header">): string {
  const parts: string[] = [r.status?.length ? r.status.join(" or ") : "Any status"];
  if (r.code?.length) parts.push(`code ${r.code.join(" or ")}`);
  if (r.body) parts.push(`body has “${r.body}”`);
  for (const h of Object.keys(r.header ?? {})) parts.push(`header ${h}`);
  return parts.join(" and ");
}

const scopeWords = (r: Rule) => (r.provider ? `only ${r.provider}` : r.host ? `on ${r.host}` : undefined);
const outcomeLabel = (o: Outcome) => OUTCOMES.find((x) => x.value === o)?.label ?? o;

/** What the replaced built-in rule did, with its cooling time, so an override that only changes the time still shows the change. */
export function builtInWords(b: NonNullable<Rule["overrides"]>): string {
  const what = outcomeLabel(b.outcome).toLowerCase();
  if (b.outcome !== "cooling_key" && b.outcome !== "cooling_key_model") return what;
  // As the server words it (internal/failurerules keyEffect): a reset time named by the reply, else the fixed time, else 60 s.
  const time = b.reset?.length ? "until reset" : b.cooling_seconds ? coolFor(b.cooling_seconds) : "60 s";
  return `${what}, ${time}`;
}

function coolFor(n: number): string {
  if (n < 120 || n % 60 !== 0) return `${n} s`;
  if (n < 7200 || n % 3600 !== 0) return `${n / 60} min`;
  return `${n / 3600} h`;
}

/**
 * `stacked`: too narrow for a rule and its match branch side by side (phones, a tablet, a narrow window
 * beside the chat): each step then carries what a match does inside it, under its conditions.
 */
export function RulesFlow({
  handle,
  rules,
  onOpen,
  aside,
  stacked,
}: {
  handle: string;
  rules: Rule[];
  onOpen: (r: Rule) => void;
  aside: (r: Rule) => ReactNode;
  stacked: boolean;
}) {
  const column = stacked ? "w-full max-w-[560px]" : "w-[520px] self-start";
  const most = Math.max(0, ...rules.map((r) => r.hits));
  return (
    <div className="flex flex-col items-center">
      <Box className={column}>
        <ProviderTile handle={handle} size={36} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] text-fg-muted">A failed Attempt on</span>
          <span className="block truncate text-[16px] font-semibold">{handle}</span>
        </span>
        <Tag>Start</Tag>
      </Box>
      <Rail className={column} label="Tried in order; the first rule that matches decides" />
      <ol aria-label="Failure Rules, in the order they're tried" className="flex w-full flex-col">
        {rules.map((r, i) => (
          <li key={r.name} className="flex flex-col items-center">
            <Step r={r} n={i + 1} most={most} stacked={stacked} onOpen={() => onOpen(r)} aside={aside(r)} />
            <Rail className={column} />
          </li>
        ))}
      </ol>
      <Box className={column}>
        <IconTile>
          <CircleX size={17} />
        </IconTile>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] text-fg-muted">No rule matched</span>
          <span className="block text-[15px] font-semibold">No response or 5xx: try the next key</span>
          <span className="block text-[15px] font-semibold">Anything else: return the error to the Caller</span>
        </span>
        <Tag>End</Tag>
      </Box>
    </div>
  );
}

/** A card of the flow, as on the route view (C19): white, rounded, bordered. */
function Box({ children, className, dashed }: { children: ReactNode; className?: string; dashed?: boolean }) {
  return (
    <div className={cn("flex items-center gap-3 rounded-xl border bg-bg px-4 py-3 shadow-sm", dashed ? "border-dashed border-border shadow-none" : "border-border", className)}>
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

function Step({ r, n, most, stacked, onOpen, aside }: { r: Rule; n: number; most: number; stacked: boolean; onOpen: () => void; aside: ReactNode }) {
  const off = !r.enabled;
  const scope = scopeWords(r);
  const card = (
    <div
      data-off={off || undefined}
      className={cn(
        // As on the route view: hover changes border only (duration-hover); no press scale on a card.
        "relative w-full rounded-xl border bg-bg shadow-sm transition-[border-color] duration-hover ease-[ease] hover:border-border-strong",
        stacked ? "w-full max-w-[560px]" : "w-[520px] shrink-0",
        off ? "border-dashed border-border bg-bg/70 shadow-none" : "border-border",
      )}
    >
      <SdkButton onClick={onOpen} aria-label={`Open ${r.name}`} className="absolute inset-0 rounded-xl outline-none focus-visible:outline-2 focus-visible:outline-info" />
      <div className={cn("flex gap-3 px-4 py-3", stacked ? "items-start" : "items-center")}>
        <span
          className={cn(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-full border text-[13px] tabular",
            off ? "border-dashed border-border text-fg-subtle" : "border-border-strong text-fg-muted",
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
          </span>
          {/* Phones wrap what it matches rather than cut it: it's the half of the rule that can't be read elsewhere on the step. */}
          <span className={cn("mt-0.5 block font-mono text-[13px] text-fg-muted", stacked ? "[overflow-wrap:anywhere]" : "truncate")} title={matchWords(r)}>
            {matchWords(r)}
          </span>
          {(scope || r.overrides) && (
            <span className={cn("mt-0.5 block text-[13px] text-fg-muted", !stacked && "truncate")}>
              {[scope && `Tried early: ${scope}`, r.overrides && `Built-in did: ${builtInWords(r.overrides)}`].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        {!stacked && <Hits hits={r.hits} most={most} />}
        {aside && <span className="relative shrink-0">{aside}</span>}
      </div>
      {stacked && (
        <div className={cn("border-t px-4 py-2.5", off ? "border-dashed border-border" : "border-border")}>
          <span className="mb-1 flex items-start justify-between gap-3">
            <span className="text-[12.5px] text-fg-muted">{off ? "Would, if it were on" : "If it matches"}</span>
            <Hits hits={r.hits} most={most} />
          </span>
          <Effect r={r} />
        </div>
      )}
    </div>
  );
  if (stacked) return card;
  return (
    <div className="flex w-full items-center">
      {card}
      {/* The match branch: the failure leaves the flow here when this rule matches. */}
      <div className="flex w-28 shrink-0 items-center" aria-hidden>
        <span className={cn("h-px flex-1", off ? "border-t border-dashed border-border-strong" : "bg-border-strong")} />
        <span className={cn("mx-1 text-[12.5px]", off ? "text-fg-subtle" : "text-fg-muted")}>{off ? "skipped" : "matches"}</span>
        <span className={cn("h-px w-3", off ? "border-t border-dashed border-border-strong" : "bg-border-strong")} />
        {!off && (
          <svg width="6" height="9" viewBox="0 0 6 9" className="text-border-strong">
            <path d="M0 0 L6 4.5 L0 9 Z" fill="currentColor" />
          </svg>
        )}
      </div>
      <Box dashed={off} className={cn("min-w-0 max-w-[380px] flex-1 py-2.5", off && "opacity-60")}>
        <Effect r={r} />
      </Box>
    </div>
  );
}

/** What a match does: to the Upstream Key (with its Key State colour) and to the Request. */
function Effect({ r }: { r: Rule }) {
  return (
    <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[14px]">
      <dt className="text-fg-muted">Upstream Key</dt>
      <dd className="flex min-w-0 items-center gap-2">
        <StatusDot tone={keyTone(r.outcome)} />
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
