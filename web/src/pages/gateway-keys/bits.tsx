import { Copy } from "lucide-react";
import { Button } from "@/ui/Button";
import { copyText } from "@/pages/settings/format";

// The copyable value box of C12 and the base URLs.

/** A value in mono on a tinted box with Copy (C12). */
export function CopyBox({ value, what, label }: { value: string; what: string; label?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-subtle p-1.5 pl-3">
      <span className="min-w-0 flex-1 break-all py-1 font-mono text-[13px] text-fg">{value}</span>
      <Button size="sm" icon={Copy} onClick={() => void copyText(value, what)} aria-label={label ?? `Copy ${what.toLowerCase()}`}>
        Copy
      </Button>
    </div>
  );
}

/** The global base URLs this Iroha answers on. */
export function baseUrls(origin = window.location.origin) {
  return { openai: `${origin}/v1`, anthropic: origin, gemini: `${origin}/v1beta` };
}
