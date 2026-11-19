import type { ReactNode } from "react";
import { cn } from "@/ui/cn";

export type PageWidth = "wide" | "readable";

// The two page widths. Shell puts every page in the wide frame (tables, the
// route view, page headers and tabs), centred on big screens; forms and
// settings sit in a readable column inside it, left-aligned under the header.
export const PAGE_WIDTH: Record<PageWidth, string> = {
  wide: "mx-auto w-full max-w-[1280px]",
  readable: "w-full max-w-3xl",
};

export function PageBody({ width, className, children }: { width: PageWidth; className?: string; children: ReactNode }) {
  return (
    <div data-page-width={width} className={cn(PAGE_WIDTH[width], className)}>
      {children}
    </div>
  );
}
