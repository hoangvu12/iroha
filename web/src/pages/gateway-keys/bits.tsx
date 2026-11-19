import { Link } from "react-router";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { formatNumber } from "@/lib/format";
import { cn } from "@/ui/cn";
import { CopyButton } from "@/ui/CopyButton";
import type { GatewayKey } from "./api";

// The copyable value box of C12, the base URLs and a key's Requests link.

/** A value in mono on a tinted box with Copy (C12). */
export function CopyBox({ value, what, label }: { value: string; what: string; label?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-subtle p-1.5 pl-3">
      <span className="min-w-0 flex-1 break-all py-1 font-mono text-[13px] text-fg">{value}</span>
      <CopyButton value={value} what={what} label={label} />
    </div>
  );
}

/** The global base URLs this Iroha answers on. */
export function baseUrls(origin = window.location.origin) {
  return { openai: `${origin}/v1`, anthropic: origin, gemini: `${origin}/v1beta` };
}

/**
 * Where a key's Requests of the last 24 hours are listed. By the key's ID
 * (the feed's `caller=` takes one), so Requests sent under an earlier name
 * count too, as `recent_requests` does.
 */
export const requestsHref = (k: Pick<GatewayKey, "id">) => `/requests?caller=${encodeURIComponent(k.id)}&range=24h`;

/**
 * A key's "Requests, 24 h" count as a link to those Requests, with the quiet
 * underline of a RecordLink, named "Requests of <name>, last 24 h" for the
 * keyboard and agents (a UI SDK Button rendered as a router Link, so
 * Ctrl/⌘-click still opens a tab). A count of 0 stays plain.
 */
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
