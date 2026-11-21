import { cloneElement, type ReactElement, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { animateIn, animateOut } from "@ui-sdk/core";

// Elements are found under `root` when needed, not kept in refs: refs inside Skullet's Skeleton don't hold.

type Layout = "table" | "list";
type Drawn = { index: number; node: ReactElement; layout: Layout };
type Ghost = Drawn & { id: string };

const rowSelector = (id: string, leaving = false) => `[data-rows] > [data-row-id="${CSS.escape(id)}"]${leaving ? "[data-leaving]" : ""}`;

export function useRowMotion<T>({ data, getRowId, enabled, root }: { data: T[] | undefined; getRowId: (row: T) => string; enabled: boolean; root: RefObject<HTMLElement | null> }) {
  const committed = useRef(new Map<string, Drawn>());
  const drawing = useRef(new Map<string, Drawn>());
  drawing.current = new Map();

  const [prev, setPrev] = useState(data);
  const [leaving, setLeaving] = useState<Ghost[]>([]);
  const [entering, setEntering] = useState<string[]>([]);
  if (data !== prev) {
    setPrev(data);
    if (enabled && prev && data) {
      const now = new Set(data.map(getRowId));
      const before = new Set(prev.map(getRowId));
      if ([...now].some((id) => before.has(id))) {
        const added = [...now].filter((id) => !before.has(id));
        if (added.length) setEntering(added);
        const gone: Ghost[] = [...committed.current].filter(([id]) => !now.has(id)).map(([id, d]) => ({ id, ...d }));
        setLeaving((l) => {
          const kept = l.filter((g) => !now.has(g.id) && !gone.some((x) => x.id === g.id));
          return gone.length || kept.length !== l.length ? [...kept, ...gone] : l;
        });
      }
    }
  }

  useLayoutEffect(() => {
    committed.current = drawing.current;
  });

  useLayoutEffect(() => {
    if (!entering.length) return;
    const stops = entering.map((id) => {
      const el = root.current?.querySelector<HTMLElement>(rowSelector(id));
      return el ? animateIn(el) : undefined;
    });
    return () => stops.forEach((stop) => stop?.());
  }, [entering, root]);

  const exits = useRef(new Map<string, () => void>());
  useLayoutEffect(() => {
    const drop = (id: string) => setLeaving((l) => l.filter((g) => g.id !== id));
    for (const g of leaving) {
      if (exits.current.has(g.id)) continue;
      const el = root.current?.querySelector<HTMLElement>(rowSelector(g.id, true));
      if (!el) {
        drop(g.id);
        continue;
      }
      exits.current.set(
        g.id,
        animateOut(el, () => {
          exits.current.delete(g.id);
          drop(g.id);
        }),
      );
    }
    for (const [id, stop] of exits.current)
      if (!leaving.some((g) => g.id === id)) {
        stop();
        exits.current.delete(id);
      }
  }, [leaving, root]);
  useLayoutEffect(() => {
    const running = exits.current;
    return () => running.forEach((stop) => stop());
  }, []);

  return {
    record(id: string, index: number, node: ReactElement, layout: Layout) {
      drawing.current.set(id, { index, node, layout });
      return node;
    },
    withLeaving(groups: ReactNode[][], layout: Layout): ReactNode[] {
      const out = [...groups];
      for (const g of [...leaving].filter((x) => x.layout === layout).sort((a, b) => a.index - b.index))
        out.splice(Math.min(g.index, out.length), 0, [cloneElement(g.node as ReactElement<Record<string, unknown>>, { "data-leaving": "", "aria-hidden": true, inert: true })]);
      return out.flat();
    },
  };
}
