import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { copyText } from "@/pages/settings/format";

// Small controls of the Gateway Keys page: checkbox, radio, switch and the
// copyable value box of C12.

export function Checkbox({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors",
        checked ? "border-primary bg-primary text-primary-fg" : "border-border-strong bg-bg",
        className,
      )}
    >
      {checked && <Check size={13} strokeWidth={3} />}
    </span>
  );
}

export function RadioDot({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-colors",
        checked ? "border-primary bg-primary" : "border-border-strong bg-bg",
      )}
    >
      {checked && <span className="size-[7px] rounded-full bg-primary-fg" />}
    </span>
  );
}

/** One option of a radio group: a title and one line under it. */
export function RadioOption({
  checked,
  onSelect,
  title,
  description,
}: {
  checked: boolean;
  onSelect: () => void;
  title: ReactNode;
  description: ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={checked} onClick={onSelect} className="flex w-full gap-3 rounded-lg py-1.5 text-left">
      <RadioDot checked={checked} />
      <span className="min-w-0">
        <span className="block text-[15px] text-fg">{title}</span>
        <span className="mt-0.5 block text-sm text-fg-muted">{description}</span>
      </span>
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-border-strong",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 size-5 rounded-full bg-bg shadow-sm transition-transform duration-150",
          checked && "translate-x-4",
        )}
      />
    </button>
  );
}

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
