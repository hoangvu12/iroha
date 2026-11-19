import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@ui-sdk/react/collapsible";
import { cn } from "./cn";

// A summary line that shows more under it when pressed.
export function Disclosure({ summary, children, className, triggerClassName }: { summary: ReactNode; children: ReactNode; className?: string; triggerClassName?: string }) {
  return (
    <Collapsible className={className}>
      <CollapsibleTrigger className={cn("group inline-flex select-none items-center gap-1 text-left text-fg-muted hover:text-fg", triggerClassName)}>
        <ChevronRight size={14} aria-hidden className="shrink-0 transition-transform group-data-open:rotate-90 motion-reduce:transition-none" />
        {summary}
      </CollapsibleTrigger>
      <CollapsiblePanel className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-200 ease-out data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none">
        {children}
      </CollapsiblePanel>
    </Collapsible>
  );
}
