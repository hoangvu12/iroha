import type { ReactNode } from "react";
import { ArrowUpRight, ChevronLeft, X } from "lucide-react";
import { Link } from "react-router";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { DialogClose, DialogTitle } from "@ui-sdk/react/dialog";
import { isApiError } from "@/api/client";
import { useIsPhone } from "@/lib/media";
import { buttonClass, iconButtonClass } from "@/ui/Button";
import { cn } from "@/ui/cn";
import { CopyButton } from "@/ui/CopyButton";
import { ScrollArea } from "@/ui/ScrollArea";
import { ErrorState } from "@/ui/States";
import { Tip } from "@/ui/Tooltip";

// The parts every record sheet is made of: the bar (kind, Open page, Close),
// the title (logo, name, state), the scrolling body with its sections and
// facts, and the actions row. A sheet's body renders inside the stack's
// DialogContent, so DialogTitle names the sheet.

/** The bar at the top: what kind of record, extra buttons, "Open page" and Close (Back on phones). */
export function SheetBar({ kind, page, start, children }: { kind: ReactNode; page?: string; start?: ReactNode; children?: ReactNode }) {
  const phone = useIsPhone();
  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
      {phone && (
        <DialogClose className={cn(buttonClass("ghost", "sm"), "-ml-2 px-2")}>
          <ChevronLeft size={16} aria-hidden />
          Back
        </DialogClose>
      )}
      {start}
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-fg-muted">{kind}</span>
      {children}
      {page && (
        <SdkButton render={<Link to={page} />} className={buttonClass("secondary", "sm")}>
          Open page
          <ArrowUpRight size={14} aria-hidden />
        </SdkButton>
      )}
      {!phone && (
        <Tip label="Close (Esc)" type="label">
          <DialogClose className={iconButtonClass()}>
            <X size={17} aria-hidden />
          </DialogClose>
        </Tip>
      )}
    </div>
  );
}

/** The record's logo, name (the sheet's accessible name, after its kind), state and a line under it. */
export function SheetTitle({
  kind,
  logo,
  title,
  mono,
  subtitle,
  state,
}: {
  kind: string;
  logo?: ReactNode;
  title: string;
  mono?: boolean;
  subtitle?: ReactNode;
  state?: ReactNode;
}) {
  return (
    <header className="flex items-start gap-3.5 pb-5 pt-6">
      {logo}
      <div className="min-w-0 flex-1">
        <DialogTitle className={cn("break-words text-[20px] font-semibold leading-tight", mono && "font-mono text-[18px]")}>
          <span className="sr-only">{kind}</span> {title}
        </DialogTitle>
        {subtitle && <div className="mt-1 text-[14.5px] text-fg-muted">{subtitle}</div>}
      </div>
      {state && <div className="shrink-0 pt-0.5 text-[14px]">{state}</div>}
    </header>
  );
}

export function SheetBody({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="flex-1" contentClassName="px-6 pb-10">
      {children}
    </ScrollArea>
  );
}

export function SheetSection({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-border py-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Facts({ children }: { children: ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-8 gap-y-4">{children}</dl>;
}

export function Fact({ label, children, mono, wide }: { label: string; children: ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={cn("min-w-0", wide && "col-span-2")}>
      <dt className="text-[13px] text-fg-muted">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-[15px] text-fg", mono && "font-mono text-[14px]")}>{children}</dd>
    </div>
  );
}

/** A list of linked records, one per row. */
export function LinkList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-border rounded-lg border border-border text-[14.5px]">{children}</ul>;
}

export function LinkRow({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <li className="flex min-w-0 items-center gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">{children}</div>
      {aside && <div className="shrink-0 text-[13.5px] text-fg-muted">{aside}</div>}
    </li>
  );
}

/** The common actions (Test, enable or disable, copy) under the title. */
export function SheetActions({ children, result }: { children: ReactNode; result?: ReactNode }) {
  return (
    <div className="pb-5">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {result && (
        <p role="status" className="mt-2.5 text-[14px] text-fg-muted">
          {result}
        </p>
      )}
    </div>
  );
}

/** Copies `text` and says "Copied" in place (`CopyButton`, UI ticket 04). */
export function CopyIconButton({ text, what }: { text: string; what: string }) {
  return <CopyButton icon value={text} what={what} label={`Copy ${what}`} />;
}

export const none = <span className="text-fg-subtle">–</span>;

/** Loading, missing (404) and failed bodies, inside the sheet. */
export function SheetLoading({ name }: { name: string }) {
  return (
    <div className="space-y-3 p-6" aria-busy="true">
      <DialogTitle className="sr-only">{name}</DialogTitle>
      <div className="skeleton h-5 w-48 rounded-full bg-muted" />
      <div className="skeleton h-3 w-32 rounded-full bg-muted" />
    </div>
  );
}

export function SheetProblem({ kind, name, error, onRetry }: { kind: string; name: string; error: unknown; onRetry: () => void }) {
  const gone = isApiError(error) && error.status === 404;
  return (
    <div className="p-6">
      <DialogTitle className="mb-2 text-[17px] font-semibold">
        {gone ? `No ${kind} ${name}` : `Couldn't load ${kind} ${name}`}
      </DialogTitle>
      {gone ? (
        <p className="text-[14.5px] text-fg-muted">It may have been renamed or deleted.</p>
      ) : (
        <ErrorState title={`Couldn't load ${kind} ${name}`} error={error} onRetry={onRetry} />
      )}
    </div>
  );
}
