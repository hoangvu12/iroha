import type { ReactNode } from "react";
import { Collapsible, CollapsiblePanel } from "@ui-sdk/react/collapsible";

// A section that opens under a choice made elsewhere (a radio, a switch), with
// the collapse recipe of architecture.md "UI motion system": it grows from 0
// to its measured height and folds back, staying mounted until it has. Open on
// its first paint, it shows at once. Under reduced motion `--duration-collapse`
// is 0, so it appears and goes at once. Use Disclosure when the section has its
// own trigger.

/** The collapse recipe on a UI SDK Collapsible (or Accordion) panel. */
export const collapsePanelClass =
  "h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-collapse ease-out data-starting-style:h-0 data-ending-style:h-0";

/**
 * Content that appears in place of other content after the page has painted
 * (a dialog turning into its result): rises a row's distance and fades in,
 * from `@starting-style`. Block or flex elements only (`translate` ignores
 * inline ones). Under reduced motion the shift is 0: a plain fade.
 */
export const riseIn = "transition-[opacity,translate] duration-list-in ease-out starting:translate-y-(--motion-shift-sm) starting:opacity-0";

/** The same for content that must not move (details opening under a table row): a fade only. */
export const fadeIn = "transition-opacity duration-fade ease-out starting:opacity-0";

/** `label` names the section for agents, which see it as a collapsible with no trigger to name it. */
export function Reveal({ open, label, children, className }: { open: boolean; label: string; children: ReactNode; className?: string }) {
  return (
    <Collapsible open={open} aria-label={label}>
      <CollapsiblePanel className={className ? `${collapsePanelClass} ${className}` : collapsePanelClass}>{children}</CollapsiblePanel>
    </Collapsible>
  );
}
