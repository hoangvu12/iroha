import type { ReactNode } from "react";
import { ProviderTile } from "@/ui/LogoTile";
import { StatusDot, type Tone } from "@/ui/bits";
import { cn } from "@/ui/cn";
import { Code, type Lang, langOf } from "@/ui/highlight";
import { ScrollArea } from "@/ui/ScrollArea";
import type { RequestRecord, Shape } from "./api";

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

export const statusText = (status: number) => reasons[status] ?? "";

export function failed(r: Pick<RequestRecord, "state" | "status">): boolean {
  return r.state === "interrupted" || (r.state !== "in_progress" && (r.status >= 400 || r.status < 100));
}

export function statusTone(status: number, state: RequestRecord["state"] = "completed"): Tone {
  if (state === "in_progress") return "gray";
  if (state === "interrupted" || status === 0) return "red";
  if (status < 400) return "green";
  if (status === 429 || status === 503 || status === 408 || status === 529) return "amber";
  return "red";
}

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

export function secs(ms?: number | null): string {
  if (ms === undefined || ms === null) return "–";
  const s = ms / 1000;
  if (s < 1) return `${s.toFixed(2)} s`;
  if (s < 100) return `${s.toFixed(1)} s`;
  return `${Math.round(s)} s`;
}

export function msOrSecs(ms?: number | null): string {
  if (ms === undefined || ms === null) return "–";
  return ms < 1000 ? `${Math.round(ms)} ms` : secs(ms);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

export const clock = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export const clockMs = (iso: string) => `${clock(iso)}.${pad(new Date(iso).getMilliseconds(), 3)}`;

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
export const compactNumber = (n: number) => compact.format(n);

export function ProviderLogo({ handle, size = 20 }: { handle?: string; size?: number }) {
  if (!handle) return null;
  return <ProviderTile handle={handle} size={size} />;
}

export function PoolTag() {
  return <span className="inline-flex h-5 shrink-0 items-center rounded bg-muted px-1.5 text-[12px] font-normal text-fg-muted">Pool</span>;
}

export function Fact({ label, children, mono, wide }: { label: ReactNode; children: ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-[13px] text-fg-muted">{label}</dt>
      <dd className={cn("mt-0.5 text-[15px] text-fg", wide ? "break-words" : "truncate", mono && "font-mono text-[14px]")}>{children}</dd>
    </div>
  );
}

export function Row({ label, children, mono, className }: { label: ReactNode; children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className="grid grid-cols-[132px_minmax(0,1fr)] gap-3 py-1.5">
      <dt className="text-[14px] text-fg-muted">{label}</dt>
      <dd className={cn("min-w-0 break-words text-[14px] text-fg", mono && "font-mono text-[13.5px]", className)}>{children}</dd>
    </div>
  );
}

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

export function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export function CodeBlock({
  children,
  lang = "auto",
  className,
  maxHeight = "max-h-[420px]",
  nowrap,
}: {
  children: string;
  lang?: Lang | "auto";
  className?: string;
  maxHeight?: string | false;
  nowrap?: boolean;
}) {
  return (
    <ScrollArea axis={nowrap ? "both" : "y"} className={cn("rounded-lg border border-border bg-subtle", className)} viewportClassName={maxHeight || undefined}>
      <pre className={cn("px-4 py-3 font-mono text-[12.5px] leading-relaxed text-fg", nowrap ? "whitespace-pre" : "whitespace-pre-wrap break-words")}>
        <Code text={children} lang={lang === "auto" ? langOf(children) : lang} />
      </pre>
    </ScrollArea>
  );
}
