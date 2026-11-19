import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { seg } from "@/api/client";
import type { Tone } from "@/ui/bits";
import { StatusDot } from "@/ui/bits";
import { cn } from "@/ui/cn";
import { ProviderTile } from "@/ui/LogoTile";
import type { KeyState, PreviewSkip } from "./api";

export { PoolTile, ProviderTile } from "@/ui/LogoTile";

// Small controls of the Providers page live in src/ui; the Key State label
// and settings cards are here.
export { Checkbox } from "@/ui/Checkbox";
export { Segmented } from "@/ui/Segmented";
export { Select } from "@/ui/Select";
export { Switch } from "@/ui/Switch";

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

/** A dialog's error line: drops 4 px and fades in, as a Field error does (list recipe). */
export const appearClass = "transition-[opacity,translate] duration-list-in ease-out starting:-translate-y-(--motion-shift-sm) starting:opacity-0";

/**
 * On a `Reveal` panel holding inputs: room for their 2 px focus ring, which the
 * panel's `overflow-hidden` would clip at its sides and bottom.
 */
export const ringRoom = "-mx-1 px-1 -mb-1 pb-1";

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
