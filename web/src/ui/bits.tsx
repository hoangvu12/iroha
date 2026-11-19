import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "./cn";

export type Tone = "green" | "amber" | "red" | "gray" | "blue";

const dot: Record<Tone, string> = {
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-danger-text",
  gray: "bg-fg-subtle",
  blue: "bg-info",
};

/** Status colour comes only from dots like this one (and logos, and the art). */
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

/** "● Cooling": a status dot and its word. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      <StatusDot tone={tone} />
      {children}
    </span>
  );
}

/** A keyboard shortcut hint, as in the sidebar (P, G, R, C). */
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

/** Underline tabs (Provider: Keys / Endpoints / Models; Settings). Each tab is a route. */
export function Tabs({ items }: { items: { to: string; label: ReactNode; end?: boolean }[] }) {
  return (
    <nav className="flex gap-6 overflow-x-auto border-b border-border">
      {items.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cn(
              "-mb-px whitespace-nowrap border-b-2 pb-2.5 text-[15px] transition-colors",
              isActive ? "border-fg text-fg" : "border-transparent text-fg-muted hover:text-fg",
            )
          }
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** Mono secret or ID text, truncated in the middle by the caller if needed. */
export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[13px]", className)}>{children}</span>;
}
