import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

// Requests arriving live (UI ticket 18, architecture.md "UI motion system"):
// the only arrival motion in the app. The rows of one poll that land in view
// rise by --motion-shift-sm and fade in over --duration-list-in, all together
// (no stagger), and their background flashes --info-tint back to the row's own
// colour over --duration-flash. Rows that land out of view (DataTable holds the
// view while the reader is scrolled down or pointing at the rows) don't enter:
// each flashes once, the first time it comes into view (the "N new" pill, a
// scroll), so the reader still sees which are new. Under reduced motion nothing
// moves: the fade and the colour flash stay.
//
// WAAPI, so the values are read from the tokens at run time. Rows are found
// under `box` by `data-row-id` (refs inside DataTable's Skeleton don't hold).

const root = () => getComputedStyle(document.documentElement);
const token = (name: string) => root().getPropertyValue(name).trim();
const ms = (name: string) => {
  const v = token(name);
  const n = parseFloat(v);
  return Number.isFinite(n) ? (v.endsWith("ms") ? n : n * 1000) : 0;
};

function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const scroller = el.closest<HTMLElement>("[role=region]");
  // Under the scroller's sticky header, inside the scroller and the window.
  const box = scroller?.getBoundingClientRect();
  const header = scroller?.querySelector("thead")?.getBoundingClientRect().height ?? 0;
  const top = Math.max(0, box ? box.top + header : 0);
  const bottom = Math.min(window.innerHeight, box ? box.bottom : Infinity);
  return r.top + r.height / 2 > top && r.top + r.height / 2 < bottom;
}

function flash(el: Element, easing: string) {
  // One keyframe at the start: the end is the row's own background (selected, a failed row's red tint).
  el.animate?.([{ backgroundColor: "var(--info-tint)", offset: 0 }], { duration: ms("--duration-flash"), easing });
}

export function useArrivals(box: RefObject<HTMLElement | null>, added: Set<string>) {
  const seen = useRef(new Set<string>());
  const io = useRef<IntersectionObserver | null>(null);
  useEffect(() => () => io.current?.disconnect(), []);

  // After DataTable's own layout effect has held the view, before the frame is painted.
  useLayoutEffect(() => {
    const fresh = [...added].filter((id) => !seen.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.current.add(id);
    const easing = token("--ease-out") || "ease-out";
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shift = token("--motion-shift-sm");
    for (const id of fresh) {
      const el = box.current?.querySelector<HTMLElement>(`[data-rows] > [data-row-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      if (inView(el)) {
        const from: Keyframe = still || !shift ? { opacity: 0, offset: 0 } : { opacity: 0, translate: `0 ${shift}`, offset: 0 };
        el.animate?.([from], { duration: ms("--duration-list-in"), easing });
        flash(el, easing);
        continue;
      }
      if (typeof IntersectionObserver === "undefined") continue;
      io.current ??= new IntersectionObserver(
        (entries, observer) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            observer.unobserve(e.target);
            flash(e.target, token("--ease-out") || "ease-out");
          }
        },
        // The implicit root clips by every scroller up the tree: the table's and the page's.
        { threshold: 0.5 },
      );
      io.current.observe(el);
    }
  }, [added, box]);
}
