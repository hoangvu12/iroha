"use client";

import { useState, type CSSProperties, type ReactNode } from "react";
import { createParts } from "@ui-sdk/react/primitive";
import { Maximize, Minus, Plus } from "lucide-react";
import { IconButton } from "./Button";
import { canvas, createCanvasController } from "./canvas-primitive";
import { cn } from "./cn";

const { Root, World, Level } = createParts(canvas, { root: "div", world: "div", level: "output" });

const DOTS: CSSProperties = {
  backgroundImage: "radial-gradient(var(--border-strong) 1px, transparent 1px)",
  backgroundSize: "20px 20px",
};

/**
 * The dotted route canvas (Pool Route tab, Request Route view): `children`
 * is the world that pans and zooms, `overlay` stays put above it (the live
 * bar). Zoom controls sit at the bottom centre. Give it a size.
 */
export function Canvas({
  label,
  children,
  overlay,
  className,
  worldClassName,
}: {
  label: string;
  children: ReactNode;
  overlay?: ReactNode;
  className?: string;
  worldClassName?: string;
}) {
  const [controller] = useState(createCanvasController);
  return (
    <Root
      aria-label={label}
      controller={controller}
      className={cn("cursor-grab select-none bg-subtle outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info active:cursor-grabbing", className)}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0" style={DOTS} />
      <World className={cn("w-full", worldClassName)}>{children}</World>
      {overlay}
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 cursor-default items-center gap-1 rounded-xl border border-border bg-elevated px-1.5 py-1 shadow-elevated" data-canvas-no-pan>
        <IconButton icon={Minus} label="Zoom out" size="sm" onClick={() => controller.zoomOut()} />
        <Level aria-label="Zoom level" className="w-12 text-center text-[13.5px] tabular">
          {({ percent }) => `${percent}%`}
        </Level>
        <IconButton icon={Plus} label="Zoom in" size="sm" onClick={() => controller.zoomIn()} />
        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton icon={Maximize} label="Reset the view" size="sm" onClick={() => controller.reset()} />
      </div>
    </Root>
  );
}
