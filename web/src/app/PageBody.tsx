import type { ReactNode } from "react";
import { cn } from "@/ui/cn";

export type PageWidth = "wide";

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
