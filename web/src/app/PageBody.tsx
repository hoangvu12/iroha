import type { ReactNode } from "react";
import { cn } from "@/ui/cn";

export type PageWidth = "wide";

// The page width. Shell puts every page in the wide frame, centred on big
// screens, so nothing stretches across a wide monitor. Forms and settings use
// it too (Owner, 2026-11-20: no narrower column under a full-width header);
// their rows keep the label on the left and the control in a column of its
// own width on the right (`SettingsRow`), so inputs never run the frame wide.
// Login and Setup are centred forms, not pages, and size their own column.
export const PAGE_WIDTH: Record<PageWidth, string> = {
  wide: "mx-auto w-full max-w-[1280px]",
};

export function PageBody({ width, className, children }: { width: PageWidth; className?: string; children: ReactNode }) {
  return (
    <div data-page-width={width} className={cn(PAGE_WIDTH[width], className)}>
      {children}
    </div>
  );
}
