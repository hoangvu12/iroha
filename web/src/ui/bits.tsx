import type { ReactNode } from "react";
import { cn } from "./cn";

export type Tone = "green" | "amber" | "red" | "gray" | "blue";

const dot: Record<Tone, string> = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-danger-text",
  gray: "bg-fg-subtle",
  blue: "bg-info",
};

export function StatusDot({ tone, className, label }: { tone: Tone; className?: string; label?: string }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-block size-2 shrink-0 rounded-full", dot[tone], className)}
    />
  );
}

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong px-1 font-sans text-[11px] font-medium text-fg-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[13px]", className)}>{children}</span>;
}
