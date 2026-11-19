"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createParts } from "@ui-sdk/react/primitive";
import { Maximize, Minus, Plus } from "lucide-react";
import { IconButton } from "./Button";
import { canvas, createCanvasController } from "./canvas-primitive";
import { cn } from "./cn";
import { durationOf } from "./motion";

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
  const frame = useRef<HTMLDivElement>(null);
  const glide = useGlide(frame);
  return (
    <Root
      ref={frame}
      aria-label={label}
      controller={controller}
      className={cn("cursor-grab select-none bg-subtle outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info active:cursor-grabbing", className)}
      // A press on a card glides the pan that reveals it (focusin); a press on empty space or the wheel is 1:1.
      onPointerDownCapture={(e) => (cardPress(e.target) ? glide.start() : glide.stop())}
      onWheelCapture={glide.stop}
      onKeyDownCapture={glide.stop}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0" style={DOTS} />
      <World className={cn("w-full data-glide:transition-[transform] data-glide:duration-move data-glide:ease-in-out", worldClassName)}>{children}</World>
      {overlay}
      <div className="absolute bottom-6 left-1/2 flex -translate-x-1/2 cursor-default items-center gap-1 rounded-xl border border-border bg-elevated px-1.5 py-1 shadow-elevated" data-canvas-no-pan>
        <IconButton icon={Minus} label="Zoom out" size="sm" onClick={(e) => glide.press(e, () => controller.zoomOut())} />
        <Level aria-label="Zoom level" className="w-12 text-center text-[13.5px] tabular">
          {({ percent }) => `${percent}%`}
        </Level>
        <IconButton icon={Plus} label="Zoom in" size="sm" onClick={(e) => glide.press(e, () => controller.zoomIn())} />
        <span className="mx-1 h-5 w-px bg-border" />
        <IconButton icon={Maximize} label="Reset the view" size="sm" onClick={(e) => glide.press(e, () => controller.reset())} />
      </div>
    </Root>
  );
}

/** A press on something focusable in the world (a card), not on empty space. */
const cardPress = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-slot="canvas-world"] :is(button, a, [tabindex])');

/**
 * Motion (architecture.md "UI motion system"): the world eases from one view
 * to the next for one `--duration-move` after a pointer press on a zoom
 * button or a card (`data-glide` turns its transform transition on). The
 * wheel, a pan and the keys drop it at once, so they stay 1:1 and instant.
 * Under reduced motion the token is 0 ms, so nothing glides.
 */
function useGlide(frame: RefObject<HTMLDivElement | null>) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const world = () => frame.current?.querySelector<HTMLElement>('[data-slot="canvas-world"]');
  const stop = () => {
    clearTimeout(timer.current);
    world()?.removeAttribute("data-glide");
  };
  const start = (change?: () => void) => {
    clearTimeout(timer.current);
    world()?.setAttribute("data-glide", "");
    change?.();
    timer.current = setTimeout(stop, durationOf("--duration-move"));
  };
  // A click made by a key (Enter or Space on the button: `detail` 0) or an agent changes the view at once.
  const press = (e: { detail: number }, change: () => void) => (e.detail > 0 ? start(change) : (stop(), change()));
  useEffect(() => () => clearTimeout(timer.current), []);
  return { start, stop, press };
}
