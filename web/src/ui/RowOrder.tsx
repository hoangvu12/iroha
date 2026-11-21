"use client";

import { useEffect, useId, useLayoutEffect, useRef } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { createParts } from "@ui-sdk/react/primitive";
import { GripVertical } from "lucide-react";
import { cn } from "./cn";
import { durationOf, easingOf } from "./motion";
import { rowOrder } from "./reorder-primitive";
import { useIsSample } from "./Skeleton";

const { Root, Handle } = createParts(rowOrder, { root: "div", handle: "button" });

type OrderState = { order: string[]; moving: string | null; dragging: boolean };

export function RowOrder({
  label,
  value,
  onValueChange,
  itemLabel,
  children,
  className,
}: {
  label: string;
  value: string[];
  onValueChange: (value: string[], moved?: string) => void;
  itemLabel?: (key: string) => string | undefined;
  children: (state: { order: string[]; moving: string | null }) => ReactNode;
  className?: string;
}) {
  const help = useId();
  const root = useRef<HTMLDivElement>(null);
  const held = useRef<string | null>(null);
  const glide = useRef<GlideState>({ tops: new WeakMap(), drag: null, settling: null });
  return (
    <Root
      ref={root}
      aria-label={label}
      aria-describedby={help}
      value={value}
      onValueChange={(v) => {
        const moved = held.current ?? undefined;
        held.current = null;
        onValueChange(v, moved);
      }}
      itemLabel={itemLabel}
      onPointerDownCapture={(e) => {
        const row = e.target instanceof Element && e.target.closest(HANDLE) ? rowOf(e.target.closest(HANDLE)!) : null;
        glide.current.press = row ? { row, y: e.clientY, top: row.offsetTop, at: e.clientY } : undefined;
      }}
      onPointerMoveCapture={(e) => {
        if (glide.current.press) glide.current.press.at = e.clientY;
      }}
      className={cn("[&_[data-row-id]:has([data-grabbed])]:relative [&_[data-row-id]:has([data-grabbed])]:z-10 [&_[data-row-id]:has([data-grabbed])]:bg-subtle [&_[data-row-id]:has([data-grabbed])]:shadow-elevated", className)}
    >
      {(state: OrderState) => (
        <>
          <Held state={state} held={held} />
          <Glide root={root} glide={glide} dragging={state.dragging} />
          <p id={help} className="sr-only">
            Press Space or Enter on a handle to pick a row up, the arrow keys to move it, Space or Enter to drop it, Escape to put it back.
          </p>
          {children(state)}
        </>
      )}
    </Root>
  );
}

function Held({ state, held }: { state: { moving: string | null }; held: RefObject<string | null> }) {
  useEffect(() => {
    held.current = state.moving;
  }, [state.moving, held]);
  return null;
}

const HANDLE = '[aria-roledescription="drag handle"]';
const rowOf = (handle: Element) => (handle.closest("[data-row-id]") ?? handle) as HTMLElement;

type Drag = { row: HTMLElement; y: number; top: number; at: number };
type GlideState = {
  tops: WeakMap<Element, number>;
  press?: Drag;
  drag: Drag | null;
  settling: HTMLElement | null;
};

function offsetOf(row: HTMLElement): number {
  const t = getComputedStyle(row).transform;
  if (!t || t === "none") return 0;
  const m = t.match(/^matrix\(([^)]+)\)$/);
  if (m) return Number.parseFloat(m[1].split(",")[5]) || 0;
  const m3 = t.match(/^matrix3d\(([^)]+)\)$/);
  if (m3) return Number.parseFloat(m3[1].split(",")[13]) || 0;
  const ty = t.match(/translateY\((-?[\d.]+)px\)/);
  return ty ? Number.parseFloat(ty[1]) : 0;
}

const follow = (d: Drag) => {
  d.row.style.transform = `translateY(${d.at - d.y - (d.row.offsetTop - d.top)}px)`;
};

function Glide({ root, glide, dragging }: { root: RefObject<HTMLDivElement | null>; glide: RefObject<GlideState>; dragging: boolean }) {
  const g = glide.current;
  if (dragging && !g.drag && g.press) g.drag = g.press;
  if (!dragging && g.drag) {
    g.settling = g.drag.row;
    g.drag = null;
  }

  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const d = glide.current.drag;
      if (!d) return;
      d.at = e.clientY;
      follow(d);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => window.removeEventListener("pointermove", move);
  }, [dragging, glide]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const duration = durationOf("--duration-move");
    const easing = easingOf("--ease-in-out");
    for (const handle of el.querySelectorAll(HANDLE)) {
      const row = rowOf(handle);
      const top = row.offsetTop;
      const prev = g.tops.get(row) ?? top;
      g.tops.set(row, top);
      if (g.drag?.row === row) {
        follow(g.drag);
        continue;
      }
      const settles = g.settling === row;
      if (!settles && (!g.drag || prev === top)) continue;
      const from = prev + offsetOf(row) - top;
      for (const a of row.getAnimations()) if (a.id === "row-glide") a.cancel();
      row.style.transform = "";
      if (from !== 0 && duration > 0) row.animate([{ transform: `translateY(${from}px)` }, { transform: "none" }], { duration, easing, id: "row-glide" } as KeyframeAnimationOptions);
    }
    g.settling = null;
  });
  return null;
}

export function RowHandle({ value, name, ...rest }: { value: string; name: string } & Omit<ComponentProps<typeof Handle>, "value" | "children">) {
  if (useIsSample()) return <span className={handleClass} />;
  return (
    <Handle value={value} aria-label={`Reorder ${name}`} className={handleClass} {...rest}>
      <GripVertical size={16} aria-hidden />
    </Handle>
  );
}

const handleClass =
  "grid size-7 cursor-grab touch-none select-none place-items-center rounded text-fg-subtle outline-none hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-info/30 data-grabbed:cursor-grabbing data-grabbed:text-fg";
