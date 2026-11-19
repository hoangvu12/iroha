"use client";

import { useEffect, useId, useRef } from "react";
import type { ComponentProps, ReactNode, RefObject } from "react";
import { createParts } from "@ui-sdk/react/primitive";
import { GripVertical } from "lucide-react";
import { cn } from "./cn";
import { rowOrder } from "./reorder-primitive";
import { useIsSample } from "./Skeleton";

const { Root, Handle } = createParts(rowOrder, { root: "div", handle: "button" });

/**
 * Rows put in order by a handle (UI SDK core `createReorder`): wrap the table
 * and render its rows in `order` (the order shown while a row moves), with a
 * `RowHandle` in each. `value` is the saved order of row keys; only a drop calls
 * `onValueChange`. The row being moved is tinted.
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
  // The draft is gone by the time the drop reports, so remember which row was up.
  const held = useRef<string | null>(null);
  return (
    <Root
      aria-label={label}
      aria-describedby={help}
      value={value}
      onValueChange={(v) => {
        const moved = held.current ?? undefined;
        held.current = null;
        onValueChange(v, moved);
      }}
      itemLabel={itemLabel}
      className={cn("[&_tr:has([data-grabbed])]:bg-subtle", className)}
    >
      {(state: { order: string[]; moving: string | null }) => (
        <>
          <Held state={state} held={held} />
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
