import type { ReactNode } from "react";
import {
  ScrollArea as Root,
  ScrollAreaContent,
  ScrollAreaCorner,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
  type ScrollAreaController,
  type ScrollAreaType,
} from "@ui-sdk/react/scroll-area";
import { cn } from "./cn";

export { createScrollAreaController } from "@ui-sdk/react/scroll-area";
type Controller = ScrollAreaController;

const bar =
  "flex p-0.5 opacity-0 transition-opacity duration-200 data-visible:opacity-100 data-visible:duration-100 motion-reduce:transition-none";
const thumb = "rounded-full bg-fg/20 transition-colors hover:bg-fg/35 data-dragging:bg-fg/45";

/**
 * Iroha's one scrolling region: UI SDK Scroll Area with a thin bar that shows
 * on hover or scroll, and edge fades where content continues. The root needs a
 * size (or put `max-h-*` in `viewportClassName`); the viewport is the real
 * scroller. `bars={false}` keeps the bar invisible (tab rows): a Scrollbar
 * part must still render, or the browser's own bars come back.
 */
export function ScrollArea({
  children,
  className,
  viewportClassName,
  contentClassName,
  axis = "y",
  bars = true,
  fade = true,
  label,
  role,
  type = "hover",
  stickToEnd,
  controller,
}: {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
  contentClassName?: string;
  axis?: "x" | "y" | "both";
  bars?: boolean;
  fade?: boolean;
  label?: string;
  role?: "region" | "log";
  type?: ScrollAreaType;
  stickToEnd?: boolean;
  controller?: Controller;
}) {
  const y = axis !== "x";
  const x = axis !== "y";
  return (
    <Root className={cn("min-h-0 min-w-0", className)} type={type} stickToEnd={stickToEnd} controller={controller}>
      <ScrollAreaViewport
        role={label ? (role ?? "region") : role}
        aria-label={label}
        className={cn(
          "size-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info",
          fade && (axis === "both" ? "scroll-fade-x scroll-fade-y scroll-fade-both" : x ? "scroll-fade-x" : "scroll-fade-y"),
          viewportClassName,
        )}
      >
        <ScrollAreaContent className={contentClassName}>{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      {y && (
        <ScrollAreaScrollbar orientation="vertical" className={cn(bar, "w-2.5", !bars && "invisible")}>
          <ScrollAreaThumb className={cn(thumb, "w-full")} />
        </ScrollAreaScrollbar>
      )}
      {x && (
        <ScrollAreaScrollbar orientation="horizontal" className={cn(bar, "h-2.5 flex-col", !bars && "invisible")}>
          <ScrollAreaThumb className={cn(thumb, "h-full")} />
        </ScrollAreaScrollbar>
      )}
      {x && y && <ScrollAreaCorner />}
    </Root>
  );
}
