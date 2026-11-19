import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// Keeps a live list still while rows arrive above what the reader is looking at
// (DataTable's infinite mode with `newRowsLabel`, the Requests feed). Rows carry
// `data-row-id`; the scroller is the table's Scroll Area viewport, or the page.
//
// Held: the reader has scrolled away from the first row, or the pointer is over
// the rows. Then, when new rows come in on top, the scroller moves by their
// height, so the row the reader was on stays where it was, and `newAbove`
// counts them for the "N new" pill. At the top with the pointer away, rows come
// in on top as before. Back at the top, the count clears.

type Snapshot = { id: string; top: number; held: boolean };

export function useHoldView({
  enabled,
  ids,
  rows,
  scroller,
  inset,
}: {
  enabled: boolean;
  /** The row IDs in their order, top first. */
  ids: string[];
  /** The element whose children are the rows. */
  rows: () => HTMLElement | null;
  /** The element that scrolls, or null for the page. */
  scroller: () => HTMLElement | null;
  /** Height covered at the scroller's top (its sticky header). */
  inset?: () => number;
}) {
  const [newAbove, setNewAbove] = useState(0);
  const snap = useRef<Snapshot | null>(null);
  const pointerIn = useRef(false);
  const lastIds = useRef<string[]>([]);

  const target = useCallback(() => scroller() ?? (document.scrollingElement as HTMLElement | null), [scroller]);
  const visibleTop = useCallback(() => {
    const s = scroller();
    return Math.max(0, s ? s.getBoundingClientRect().top + (inset?.() ?? 0) : 0);
  }, [scroller, inset]);
  const rowEls = useCallback(() => [...(rows()?.children ?? [])].filter((e): e is HTMLElement => e instanceof HTMLElement && e.hasAttribute("data-row-id")), [rows]);

  const atTop = useCallback(() => {
    const s = scroller();
    if (s && s.scrollTop > 1) return false;
    const first = rowEls()[0];
    return !first || first.getBoundingClientRect().top >= visibleTop() - 1;
  }, [scroller, rowEls, visibleTop]);

  /** Remembers the first row in view and where it is. */
  const snapshot = useCallback(() => {
    const els = rowEls();
    if (!enabled || els.length === 0) {
      snap.current = null;
      return;
    }
    const top = visibleTop();
    const el = els.find((e) => e.getBoundingClientRect().bottom > top) ?? els[0];
    const top_ = atTop();
    snap.current = { id: el.getAttribute("data-row-id")!, top: el.getBoundingClientRect().top, held: !top_ || pointerIn.current };
    if (top_) setNewAbove(0);
  }, [enabled, rowEls, visibleTop, atTop]);

  // Follow the reader: scrolling, the pointer coming and going, the window resizing.
  useEffect(() => {
    if (!enabled) return;
    const s = scroller();
    const list = rows();
    const scrollTarget: HTMLElement | Window = s ?? window;
    const enter = () => {
      pointerIn.current = true;
      snapshot();
    };
    const leave = () => {
      pointerIn.current = false;
      snapshot();
    };
    scrollTarget.addEventListener("scroll", snapshot, { passive: true });
    window.addEventListener("resize", snapshot);
    list?.addEventListener("pointerenter", enter);
    list?.addEventListener("pointerleave", leave);
    // We move the view ourselves; the browser's own anchoring would move it twice.
    const anchored = s ?? document.documentElement;
    const before = anchored.style.overflowAnchor;
    anchored.style.overflowAnchor = "none";
    return () => {
      scrollTarget.removeEventListener("scroll", snapshot);
      window.removeEventListener("resize", snapshot);
      list?.removeEventListener("pointerenter", enter);
      list?.removeEventListener("pointerleave", leave);
      anchored.style.overflowAnchor = before;
    };
  }, [enabled, scroller, rows, snapshot]);

  const key = ids.join("\n");
  useLayoutEffect(() => {
    const prev = lastIds.current;
    lastIds.current = ids;
    const s = snap.current;
    if (enabled && s && s.held && prev.length > 0) {
      const at = ids.indexOf(s.id);
      const el = at >= 0 ? rowEls().find((e) => e.getAttribute("data-row-id") === s.id) : undefined;
      if (el) {
        const delta = el.getBoundingClientRect().top - s.top;
        const t = target();
        if (t && Math.abs(delta) >= 1) t.scrollTop += delta;
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
    const s = scroller();
    if (s) {
      s.scrollTop = 0;
      // The table itself may be above the page's view.
      const r = s.getBoundingClientRect();
      if (r.top < 0) s.scrollIntoView?.({ block: "start" });
    } else {
      const first = rowEls()[0];
      const t = target();
      if (first && t) t.scrollTop += first.getBoundingClientRect().top - 16;
    }
    setNewAbove(0);
    snapshot();
  }, [scroller, rowEls, target, snapshot]);

  return { newAbove: enabled ? newAbove : 0, toTop };
}
