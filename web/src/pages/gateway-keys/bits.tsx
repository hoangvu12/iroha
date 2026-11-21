import { Link } from "react-router";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { formatNumber } from "@/lib/format";
import { cn } from "@/ui/cn";
import { CopyButton } from "@/ui/CopyButton";
import { rec, RecordLink } from "@/sheets/RecordLink";
import type { GatewayKey } from "./api";

export function CopyBox({ value, what, label }: { value: string; what: string; label?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-subtle p-1.5 pl-3">
      <span className="min-w-0 flex-1 break-all py-1 font-mono text-[13px] text-fg">{value}</span>
      <CopyButton value={value} what={what} label={label} />
    </div>
  );
}

export function baseUrls(origin = window.location.origin) {
  return { openai: `${origin}/v1`, anthropic: origin, gemini: `${origin}/v1beta` };
}

export const requestsHref = (k: Pick<GatewayKey, "id">) => `/requests?caller=${encodeURIComponent(k.id)}&range=24h`;

export function RequestsCount({ k, className }: { k: Pick<GatewayKey, "id" | "name" | "recent_requests">; className?: string }) {
  if (k.recent_requests === 0) return <span className={cn("tabular text-fg-muted", className)}>0</span>;
  return (
    <SdkButton
      render={<Link to={requestsHref(k)} />}
      aria-label={`Requests of ${k.name}, last 24 h`}
      className={cn(
        "tabular rounded-sm text-fg underline decoration-border-strong underline-offset-[3px] hover:decoration-fg",
        className,
      )}
    >
      {formatNumber(k.recent_requests)}
    </SdkButton>
  );
}

export function ScopeModels({ provider, models, max = 6, className }: { provider: string; models: string[]; max?: number; className?: string }) {
  const shown = models.slice(0, max);
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-[13.5px]", className)}>
      {shown.map((m) => (
        <RecordLink key={m} record={rec.model(provider, m)} className="font-mono text-[13px]">
          {m}
        </RecordLink>
      ))}
      {models.length > max && <span className="text-fg-muted">and {models.length - max} more</span>}
    </span>
  );
}
