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

/**
 * Rows put in order by a handle (UI SDK core `createReorder`): wrap the table
 * and render its rows in `order` (the order shown while a row moves), with a
 * `RowHandle` in each. `value` is the saved order of row keys; only a drop calls
 * `onValueChange`. The row being moved is tinted and lifted; while a pointer
 * drags it, it follows the pointer and the rows it passes glide aside (see
 * `useRowGlide`).
 */
export function RowOrder({
  label,
  value,
  onValueChange,
  itemLabel,
  children,
  className,
}: {
  /** Names the list for agents and screen readers ("Order of fast's members"). */
  label: string;
  value: string[];
  /** `moved` is the row that was picked up and dropped (none for a move from code, like an agent's). */
  onValueChange: (value: string[], moved?: string) => void;
  itemLabel?: (key: string) => string | undefined;
  children: (state: { order: string[]; moving: string | null }) => ReactNode;
  className?: string;
}) {
  const help = useId();
  const root = useRef<HTMLDivElement>(null);
  // The draft is gone by the time the drop reports, so remember which row was up.
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
      // Where a pointer took a row: what the row follows once the drag starts.
      onPointerDownCapture={(e) => {
        const row = e.target instanceof Element && e.target.closest(HANDLE) ? rowOf(e.target.closest(HANDLE)!) : null;
        glide.current.press = row ? { row, y: e.clientY, top: row.offsetTop, at: e.clientY } : undefined;
      }}
      // The move that starts a drag arrives before the drag does.
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

/** Keeps `held` on the row that is up (none once it drops or goes back). */
function Held({ state, held }: { state: { moving: string | null }; held: RefObject<string | null> }) {
  useEffect(() => {
    held.current = state.moving;
  }, [state.moving, held]);
  return null;
}

const HANDLE = '[aria-roledescription="drag handle"]';
/** The row a handle moves: DataTable's row (`data-row-id`), else its own box. */
const rowOf = (handle: Element) => (handle.closest("[data-row-id]") ?? handle) as HTMLElement;

type Drag = { row: HTMLElement; y: number; top: number; at: number };
type GlideState = {
  /** Each row's place in the layout (offsetTop, untransformed) when last seen. */
  tops: WeakMap<Element, number>;
  /** The press that may become a drag, and where the pointer is since. */
  press?: Drag;
  /** The row a pointer drags: where the pointer took it (`y`, the row at `top`) and where it is now (`at`). */
  drag: Drag | null;
  /** The row just dropped, settling into its slot on the next layout. */
  settling: HTMLElement | null;
};

/** How far a row is drawn from its layout place right now (an inline offset or a running glide). */
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

/** The held row's offset that keeps it under the pointer, wherever the list has put it. */
const follow = (d: Drag) => {
  d.row.style.transform = `translateY(${d.at - d.y - (d.row.offsetTop - d.top)}px)`;
};

/**
 * Motion of a pointer reorder (architecture.md "UI motion system", "UI ticket
 * 17"). The held row follows the pointer 1:1 (no transition). Each row the
 * draft order moves glides from where it was drawn to its new place (WAAPI
 * `transform`, `--duration-move`, `--ease-in-out`; from its current offset
 * when it was still moving), all together. On drop or Escape the held row
 * settles from under the pointer into its slot the same way. A keyboard move,
 * a menu's Move and an agent's `move` are instant. Under reduced motion the
 * move token is 0 ms: rows jump, and the held row still follows the pointer.
 */
function Glide({ root, glide, dragging }: { root: RefObject<HTMLDivElement | null>; glide: RefObject<GlideState>; dragging: boolean }) {
  const g = glide.current;
  if (dragging && !g.drag && g.press) g.drag = g.press;
  if (!dragging && g.drag) {
    g.settling = g.drag.row;
    g.drag = null;
  }

  // The pointer, while it drags a row.
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

  // After each render: rows the layout moved glide from where they were drawn.
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

/** A row's drag handle, named "Reorder <name>". */
export function RowHandle({ value, name, ...rest }: { value: string; name: string } & Omit<ComponentProps<typeof Handle>, "value" | "children">) {
  // A skeleton's sample is drawn away from the RowOrder it belongs to: the same box, no behaviour.
  if (useIsSample()) return <span className={handleClass} />;
  return (
    <Handle value={value} aria-label={`Reorder ${name}`} className={handleClass} {...rest}>
      <GripVertical size={16} aria-hidden />
    </Handle>
  );
}

const handleClass =
  "grid size-7 cursor-grab touch-none select-none place-items-center rounded text-fg-subtle outline-none hover:text-fg-muted focus-visible:ring-2 focus-visible:ring-info/30 data-grabbed:cursor-grabbing data-grabbed:text-fg";
