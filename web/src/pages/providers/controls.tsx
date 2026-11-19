import type { ReactNode, SelectHTMLAttributes } from "react";
import { forwardRef, useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, ChevronDown, Minus } from "lucide-react";
import { seg } from "@/api/client";
import type { Tone } from "@/ui/bits";
import { StatusDot } from "@/ui/bits";
import { cn } from "@/ui/cn";
import { ProviderTile } from "@/ui/LogoTile";
import type { KeyState, PreviewSkip } from "./api";

export { PoolTile, ProviderTile } from "@/ui/LogoTile";

// Small controls of the Providers page: a switch, a checkbox, a segmented
// filter, a native select, and the Key State label.

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
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className={cn(
        "relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-border-strong",
      )}
    >
      <span
        className={cn(
          "inline-block size-[18px] rounded-full bg-bg shadow-sm transition-transform",
          checked ? "translate-x-[19px]" : "translate-x-[3px]",
        )}
      />
    </button>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean | "mixed";
  onChange: (on: boolean) => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onChange(checked !== true);
      }}
      className={cn(
        "inline-flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors",
        checked ? "border-primary bg-primary text-primary-fg" : "border-border-strong bg-bg hover:border-fg-muted",
        className,
      )}
    >
      {checked === "mixed" ? <Minus size={13} strokeWidth={3} /> : checked ? <Check size={13} strokeWidth={3} /> : null}
    </button>
  );
}

/** "All | With Model Gaps": a filter as a segmented control. */
export function Segmented<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: ReactNode }[];
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex h-9 shrink-0 rounded-lg bg-muted p-1">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            "flex items-center whitespace-nowrap rounded-md px-3 text-[14px] transition-colors",
            value === it.value ? "bg-bg font-medium text-fg shadow-sm" : "text-fg-muted hover:text-fg",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <div className={cn("relative", className)}>
      <select
        ref={ref}
        className="h-9 w-full appearance-none rounded-lg border border-border-strong bg-bg pl-3 pr-8 text-base text-fg outline-none focus:border-info focus:ring-2 focus:ring-info/20 md:text-sm"
        {...rest}
      >
        {children}
      </select>
      <ChevronDown size={15} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-fg-muted" />
    </div>
  );
});

/** Seconds left until a time, ticking every second. */
export function useSecondsLeft(until?: string): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return undefined;
  return Math.max(0, Math.ceil((new Date(until).getTime() - now) / 1000));
}

/** "40 s", "12 min", "3 hr". */
export function shortWait(s: number): string {
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${Math.round(m / 60)} hr`;
}

export const stateTone: Record<KeyState["state"], Tone> = { active: "green", cooling: "amber", invalid: "red", disabled: "gray" };
const stateWord: Record<KeyState["state"], string> = { active: "Active", cooling: "Cooling", invalid: "Invalid", disabled: "Disabled" };
export const toneText: Record<Tone, string> = {
  green: "text-fg",
  amber: "text-warning",
  red: "text-danger-text",
  gray: "text-fg-muted",
  blue: "text-info",
};

/** "● Cooling, 40 s left", with the reason on hover. */
export function KeyStateLabel({ state, className, plain }: { state: KeyState; className?: string; plain?: boolean }) {
  const left = useSecondsLeft(state.state === "cooling" ? state.until : undefined);
  const tone = stateTone[state.state];
  const text = state.state === "cooling" && left !== undefined ? `Cooling, ${shortWait(left)} left` : stateWord[state.state];
  const title = [state.reason, state.rule && `Rule: ${state.rule}`].filter(Boolean).join("\n") || undefined;
  return (
    <span className={cn("inline-flex items-center gap-2", !plain && toneText[tone], className)} title={title}>
      <StatusDot tone={tone} />
      {text}
    </span>
  );
}

export const skipText = (s: PreviewSkip): { text: string; tone: Tone } => {
  switch (s.reason) {
    case "cooling":
      return { text: s.seconds_left !== undefined ? `Cooling, ${shortWait(s.seconds_left)} left` : "Cooling", tone: "amber" };
    case "cooling_model":
      return { text: s.seconds_left !== undefined ? `Cooling for the model, ${shortWait(s.seconds_left)} left` : "Cooling for the model", tone: "amber" };
    case "model_gap":
      return { text: "Model Gap", tone: "blue" };
    case "invalid":
      return { text: "Invalid", tone: "red" };
    case "disabled":
      return { text: "Disabled", tone: "gray" };
    case "restricted":
      return { text: "Not on this Endpoint", tone: "gray" };
    case "endpoint_gap":
      return { text: s.endpoint ? `Endpoint Gap on ${s.endpoint}` : "Endpoint Gap", tone: "blue" };
  }
};

/** A Provider's logo and handle, linking to its keys. */
export function ProviderLink({ handle, className }: { handle: string; className?: string }) {
  return (
    <Link to={`/providers/${seg(handle)}/keys`} className={cn("inline-flex min-w-0 items-center gap-2.5 hover:underline", className)}>
      <ProviderTile handle={handle} size={24} />
      <span className="truncate">{handle}</span>
    </Link>
  );
}

/** A titled group of settings rows (C14). */
export function SettingsCard({ title, children, danger }: { title: string; children: ReactNode; danger?: boolean }) {
  return (
    <section className="mb-9">
      <h2 className={cn("mb-3 text-[17px] font-semibold", danger && "text-danger-text")}>{title}</h2>
      <div className={cn("divide-y rounded-xl border", danger ? "divide-danger/30 border-danger" : "divide-border border-border")}>{children}</div>
    </section>
  );
}

export function SettingsRow({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 md:flex-row md:items-center md:gap-6 md:px-6">
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">{title}</p>
        {hint && <p className="mt-0.5 text-[14px] text-fg-muted">{hint}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2 md:w-[min(420px,45%)] md:justify-end">{children}</div>}
    </div>
  );
}

/** A small grey label pill: "Built-in", "Custom", "Hidden". */
export function Pill({ children, tone = "gray" }: { children: ReactNode; tone?: "gray" | "blue" | "amber" | "green" | "red" }) {
  const tones = {
    gray: "bg-muted text-fg-muted",
    blue: "bg-info-tint text-info",
    amber: "bg-warning-tint text-warning",
    green: "bg-success-tint text-success",
    red: "bg-danger-tint text-danger-text",
  };
  return <span className={cn("inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[13px] font-medium tabular", tones[tone])}>{children}</span>;
}
