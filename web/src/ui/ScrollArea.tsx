import type { CSSProperties, ReactNode, Ref, UIEventHandler } from "react";
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
  "flex p-0.5 opacity-0 transition-opacity duration-scrollbar-out data-visible:opacity-100 data-visible:duration-scrollbar-in motion-reduce:transition-none";
const thumb = "rounded-full bg-fg/20 transition-colors hover:bg-fg/35 data-dragging:bg-fg/45";

/** A Scrollbar part renders even with `bars={false}`: UI SDK hides the browser's own bars only while one does. */
export function ScrollArea({
  children,
  className,
  style,
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
  viewportRef,
  onScroll,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
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
  viewportRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  const y = axis !== "x";
  const x = axis !== "y";
  return (
    <Root className={cn("min-h-0 min-w-0", className)} style={style} type={type} stickToEnd={stickToEnd} controller={controller}>
      <ScrollAreaViewport
        ref={viewportRef}
        onScroll={onScroll}
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
