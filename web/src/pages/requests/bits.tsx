import type { ReactNode } from "react";
import { LogoTile } from "@/ui/LogoTile";
import { StatusDot, type Tone } from "@/ui/bits";
import { cn } from "@/ui/cn";
import type { RequestRecord, Shape } from "./api";

// Small pieces every view of a Request shares: status words and colours,
// Shape names, times, and the Provider logo.

const shapeShort: Record<Shape, string> = {
  "openai-chat": "Chat",
  "openai-responses": "Responses",
  "anthropic-messages": "Messages",
  gemini: "Gemini",
};
const shapeLong: Record<Shape, string> = {
  "openai-chat": "OpenAI Chat",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  gemini: "Gemini",
};

export const shortShape = (s?: string) => (s ? (shapeShort[s as Shape] ?? s) : "–");
export const longShape = (s?: string) => (s ? (shapeLong[s as Shape] ?? s) : "–");

/** "Messages → Chat" when translated, else the one Shape. */
export function shapeInOut(r: Pick<RequestRecord, "shape_in" | "shape_out">): string {
  if (r.shape_out && r.shape_out !== r.shape_in) return `${shortShape(r.shape_in)} → ${shortShape(r.shape_out)}`;
  return shortShape(r.shape_in);
}

const reasons: Record<number, string> = {
  200: "OK",
  201: "Created",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  499: "Client Closed Request",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  524: "Timeout",
  529: "Overloaded",
};

/** "429 Too Many Requests"'s second half; "" when unknown. */
export const statusText = (status: number) => reasons[status] ?? "";

export function failed(r: Pick<RequestRecord, "state" | "status">): boolean {
  return r.state === "interrupted" || (r.state !== "in_progress" && (r.status >= 400 || r.status < 100));
}

/** The colour of a status: green served, amber refused for now (429, 503, timeouts), red failed. */
export function statusTone(status: number, state: RequestRecord["state"] = "completed"): Tone {
  if (state === "in_progress") return "gray";
  if (state === "interrupted" || status === 0) return "red";
  if (status < 400) return "green";
  if (status === 429 || status === 503 || status === 408 || status === 529) return "amber";
  return "red";
}

/** The status cell: a dot and the code ("● 200", "● 502"). */
export function StatusCell({ r }: { r: Pick<RequestRecord, "state" | "status"> }) {
  if (r.state === "in_progress")
    return (
      <span className="inline-flex items-center gap-2 text-fg-muted" title="In progress">
        <StatusDot tone="blue" className="animate-pulse" />…
      </span>
    );
  if (r.state === "interrupted")
    return (
      <span className="inline-flex items-center gap-2 text-fg-muted" title="Interrupted: Iroha stopped before it finished">
        <StatusDot tone="red" />–
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2 tabular">
      <StatusDot tone={statusTone(r.status, r.state)} />
      {r.status}
    </span>
  );
}

const badgeTone: Record<string, string> = {
  green: "bg-success-tint text-success",
  amber: "bg-warning-tint text-warning",
  red: "bg-danger-tint text-danger-text",
  blue: "bg-info-tint text-info",
  gray: "bg-muted text-fg-muted",
};

/** A tinted pill: "200", "429", "Start", "End". 404s (Model Gaps) are blue. */
export function Badge({ tone = "gray", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[13px] font-medium tabular", badgeTone[tone], className)}>
      {children}
    </span>
  );
}

export function statusBadgeTone(status: number): Tone {
  if (status === 404) return "blue";
  return statusTone(status);
}

/** "● 200 OK" as a pill, for headers. */
export function StatusPill({ r }: { r: Pick<RequestRecord, "state" | "status"> }) {
  const tone = statusTone(r.status, r.state);
  const label =
    r.state === "in_progress" ? "In progress" : r.state === "interrupted" ? "Interrupted" : `${r.status} ${statusText(r.status)}`.trim();
  return (
    <span className={cn("inline-flex h-7 shrink-0 items-center gap-2 rounded-full px-3 text-[13.5px] font-medium", badgeTone[tone])}>
      <StatusDot tone={tone} />
      {label}
    </span>
  );
}

/** Seconds as the feed shows them: "0.62 s", "3.4 s", "41.7 s", "112 s". */
export function secs(ms?: number | null): string {
  if (ms === undefined || ms === null) return "–";
  const s = ms / 1000;
  if (s < 1) return `${s.toFixed(2)} s`;
  if (s < 100) return `${s.toFixed(1)} s`;
  return `${Math.round(s)} s`;
}

/** Milliseconds for small gaps ("12 ms"), seconds above one. */
export function msOrSecs(ms?: number | null): string {
  if (ms === undefined || ms === null) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : secs(ms);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "14:32:07". */
export const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

/** "14:32:01.104". */
export const clockMs = (iso: string) => `${clock(iso)}.${pad(new Date(iso).getMilliseconds(), 3)}`;

/** "Today at 14:32:01.104", "Yesterday at ...", "18 Nov at ...". */
export function when(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  const label =
    diff === 0
      ? "Today"
      : diff === 1
        ? "Yesterday"
        : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
  return `${label} at ${clockMs(iso)}`;
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
/** 2140000 -> "2.14M". */
export const compactNumber = (n: number) => compact.format(n);

/**
 * The URL of a Provider's logo served by Iroha. Ticket 22 serves logos; until
 * then every tile shows the first letter. This is the one place to change.
 */
export function providerLogo(_handle: string): string | undefined {
  return undefined;
}

export function ProviderLogo({ handle, size = 20 }: { handle?: string; size?: number }) {
  if (!handle) return null;
  return <LogoTile name={handle} src={providerLogo(handle)} size={size} />;
}

/** The small grey "Pool" tag after a model served through a Model Pool. */
export function PoolTag() {
  return <span className="inline-flex h-5 shrink-0 items-center rounded bg-muted px-1.5 text-[12px] font-normal text-fg-muted">Pool</span>;
}

/** A label/value pair in a two-column grid of facts. */
export function Fact({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13px] text-fg-muted">{label}</dt>
      <dd className={cn("mt-0.5 truncate text-[15px] text-fg", mono && "font-mono text-[14px]")}>{children}</dd>
    </div>
  );
}

/** A label left, value right row (the Route view's side panel). */
export function Row({ label, children, mono, className }: { label: ReactNode; children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-[14px] text-fg-muted">{label}</dt>
      <dd className={cn("min-w-0 break-words text-[14px] text-fg", mono && "font-mono text-[13.5px]", className)}>{children}</dd>
    </div>
  );
}

/** A Request's one-line summary ("#1 team-10: 429 ...; #2 ...; stopped: ..."), one Attempt per line. */
export function Summary({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/;\s+/).filter(Boolean);
  return (
    <ul className={cn("flex flex-col gap-1", className)}>
      {parts.map((p, i) => (
        <li key={i}>{p}</li>
      ))}
    </ul>
  );
}

/** JSON text pretty-printed when it parses, as-is otherwise. */
export function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-subtle px-4 py-3 font-mono text-[12.5px] leading-relaxed text-fg",
        className,
      )}
    >
      {children}
    </pre>
  );
}
