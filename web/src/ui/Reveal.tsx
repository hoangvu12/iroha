import type { ReactNode } from "react";
import { Collapsible, CollapsiblePanel } from "@ui-sdk/react/collapsible";

export const collapsePanelClass =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-collapse ease-out data-starting-style:h-0 data-ending-style:h-0";

export const riseIn = "transition-[opacity,translate] duration-list-in ease-out starting:translate-y-(--motion-shift-sm) starting:opacity-0";

export function Reveal({ open, label, children, className }: { open: boolean; label: string; children: ReactNode; className?: string }) {
  return (
    <Collapsible open={open} aria-label={label}>
      <CollapsiblePanel className={className ? `${collapsePanelClass} ${className}` : collapsePanelClass}>{children}</CollapsiblePanel>
    </Collapsible>
  );
}
