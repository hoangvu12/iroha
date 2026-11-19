import type { MouseEvent, ReactNode } from "react";
import { forwardRef } from "react";
import { Link, useLocation } from "react-router";
import { Button as SdkButton } from "@ui-sdk/react/button";
import { cn } from "@/ui/cn";
import { type SheetRecord, writeStack } from "./records";
import { useMaybeSheets, useSheetLevel } from "./stack";

export { rec } from "./records";
export type { SheetRecord } from "./records";

export const recordLinkClass = "inline-flex min-w-0 max-w-full items-center gap-2 rounded-sm text-fg underline-offset-2 hover:underline";

/**
 * A record's name that opens its sheet beside the page (or above the sheet
 * it sits in). A real link: its href is the URL with that sheet open, so
 * Ctrl/⌘-click and middle-click open it in a new tab.
 */
export const RecordLink = forwardRef<
  HTMLAnchorElement,
  { record: SheetRecord; children: ReactNode; className?: string; "aria-label"?: string; title?: string }
>(function RecordLink({ record, children, className, ...rest }, ref) {
  const sheets = useMaybeSheets();
  const level = useSheetLevel();
  const location = useLocation();
  const href = sheets ? sheets.hrefFor(record, level) : location.pathname + writeStack(location.search, [record]);
  const onClick = (e: MouseEvent) => {
    if (!sheets || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    sheets.open(record, level);
  };
  return (
    <SdkButton
      ref={ref as never}
      render={<Link to={href} />}
      className={cn(recordLinkClass, className)}
      onClick={onClick}
      {...rest}
    >
      {children}
    </SdkButton>
  );
});
