import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Keeps a live list still while rows arrive above what the reader is looking at
// (DataTable's infinite mode with `newRowsLabel`, the Requests feed).
//
// Under `root`, the element marked `data-rows` holds the rows, each with
// `data-row-id`. The scroller is the page: tables grow with their rows and the
// page scrolls them (UI ticket 25), with a table's header stuck to the top of
// the window. Elements are found when needed, not kept in refs: the table sits
// inside a Skeleton, which replaces refs on what it renders.
//
// Held: the reader has scrolled away from the first row, or the pointer is over
// the rows. Then, when new rows come in on top, the scroller moves by their
// height, so the row the reader was on stays where it was, and `newAbove`
// counts them for the "N new" pill. At the top with the pointer away, rows come
// in on top as before. Back at the top, the count clears.

type Snapshot = { id: string; top: number; held: boolean };

export function useHoldView({ enabled, ids, root }: { enabled: boolean; /** The row IDs in their order, top first. */ ids: string[]; root: RefObject<HTMLElement | null> }) {
  const [newAbove, setNewAbove] = useState(0);
  const snap = useRef<Snapshot | null>(null);
  const pointerIn = useRef(false);
  const lastIds = useRef<string[]>([]);

  const parts = useCallback(() => {
    const rows = root.current?.querySelector<HTMLElement>("[data-rows]") ?? null;
    const els = [...(rows?.children ?? [])].filter((e): e is HTMLElement => e instanceof HTMLElement && e.hasAttribute("data-row-id"));
    // The top of what the reader sees: under the table's header stuck to the top of the window (phones' lists have none).
    const visibleTop = rows?.closest("table")?.tHead?.getBoundingClientRect().height ?? 0;
    return { rows, els, visibleTop, target: (document.scrollingElement ?? document.documentElement) as HTMLElement };
  }, [root]);

  /** Remembers the first row in view and where it is. */
  const snapshot = useCallback(() => {
    const { els, visibleTop } = parts();
    if (!enabled || els.length === 0) {
      snap.current = null;
      return;
    }
    const atTop = els[0].getBoundingClientRect().top >= visibleTop - 1;
    const el = els.find((e) => e.getBoundingClientRect().bottom > visibleTop) ?? els[0];
    snap.current = { id: el.getAttribute("data-row-id")!, top: el.getBoundingClientRect().top, held: !atTop || pointerIn.current };
    if (atTop) setNewAbove(0);
  }, [enabled, parts]);

  // Follow the reader: the page's scroll, the pointer, resizes.
  useEffect(() => {
    if (!enabled) return;
    const box = root.current;
    const onScroll = (e: Event) => {
      if (e.target === document) snapshot();
    };
    const over = (e: PointerEvent) => {
      const inside = !!parts().rows?.contains(e.target as Node);
      if (inside !== pointerIn.current) {
        pointerIn.current = inside;
        snapshot();
      }
    };
    const leave = () => {
      pointerIn.current = false;
      snapshot();
    };
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", snapshot);
    box?.addEventListener("pointerover", over);
    box?.addEventListener("pointerleave", leave);
    // We move the view ourselves; the browser's own anchoring would move it twice.
    const page = document.documentElement;
    const before = page.style.overflowAnchor;
    page.style.overflowAnchor = "none";
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", snapshot);
      box?.removeEventListener("pointerover", over);
      box?.removeEventListener("pointerleave", leave);
      page.style.overflowAnchor = before;
    };
  }, [enabled, root, parts, snapshot]);

  const key = ids.join("\n");
  useLayoutEffect(() => {
    const prev = lastIds.current;
    lastIds.current = ids;
    const s = snap.current;
    if (enabled && s && s.held && prev.length > 0) {
      const at = ids.indexOf(s.id);
      const { els, target } = parts();
      const el = at >= 0 ? els.find((e) => e.getAttribute("data-row-id") === s.id) : undefined;
      if (el) {
        const delta = el.getBoundingClientRect().top - s.top;
        if (target && Math.abs(delta) >= 1) target.scrollTop += delta;
        const had = new Set(prev);
        const added = ids.slice(0, at).filter((id) => !had.has(id)).length;
        if (added > 0) setNewAbove((n) => n + added);
      }
    }
    if (enabled && prev.length > 0 && !ids.some((id) => prev.includes(id))) setNewAbove(0); // a different list (filters changed)
    snapshot();
  }, [key, enabled]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Back to the first row (the pill). */
  const toTop = useCallback(() => {
    const { els, visibleTop, target } = parts();
    // The first row just under the header (a table's top at the window's top), or 16 px down on a phone's list.
    if (els[0]) target.scrollTop += els[0].getBoundingClientRect().top - (visibleTop || 16);
    setNewAbove(0);
    snapshot();
  }, [parts, snapshot]);

  return { newAbove: enabled ? newAbove : 0, toTop };
}
