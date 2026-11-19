import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "./cn";
import { ScrollArea } from "./ScrollArea";

// Table primitives in the calm style of the design: one fact per cell,
// hairline row borders, grey header labels, no zebra stripes. Pages build
// their tables from these (and may add sorting, selection, etc. on top).

export function Table({ className, ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <ScrollArea axis="x" className="w-full" contentClassName="min-w-full">
      <table className={cn("w-full border-collapse text-left text-sm", className)} {...rest} />
    </ScrollArea>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn("border-b border-border", className)} {...rest} />;
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function TR({
  className,
  selected,
  interactive,
  tone,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { selected?: boolean; interactive?: boolean; tone?: "danger" }) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={cn(
        "border-b border-border last:border-b-0",
        interactive && "cursor-pointer hover:bg-subtle",
        tone === "danger" && "bg-danger-tint/50",
        selected && "bg-selected hover:bg-selected",
        className,
      )}
      {...rest}
    />
  );
}

export function TH({ className, align, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { align?: "right" }) {
  return (
    <th
      scope="col"
      className={cn("h-10 px-1.5 text-[13px] font-normal text-fg-muted first:pl-1.5", align === "right" && "text-right", className)}
      {...rest}
    />
  );
}

export function TD({ className, align, mono, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { align?: "right"; mono?: boolean }) {
  return (
    <td
      className={cn(
        "h-12 px-1.5 align-middle",
        align === "right" && "text-right tabular",
        mono && "font-mono text-[13px] text-fg-muted",
        className,
      )}
      {...rest}
    />
  );
}
