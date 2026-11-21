import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

// Read once per page: a style read right after rows were added would recompute the page's styles.
let cached: { listIn: number; flash: number; easing: string; shift: string } | undefined;
function tokens() {
  if (cached) return cached;
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim();
  const ms = (name: string) => {
    const v = token(name);
    const n = parseFloat(v);
    return Number.isFinite(n) ? (v.endsWith("ms") ? n : n * 1000) : 0;
  };
  const t = { listIn: ms("--duration-list-in"), flash: ms("--duration-flash"), easing: token("--ease-out"), shift: token("--motion-shift-sm") };
  if (t.flash) cached = t;
  return t;
}

function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  const scroller = el.closest<HTMLElement>("[role=region]");
  const box = scroller?.getBoundingClientRect();
  const header = scroller?.querySelector("thead")?.getBoundingClientRect().height ?? 0;
  const top = Math.max(0, box ? box.top : 0) + header;
  const bottom = Math.min(window.innerHeight, box ? box.bottom : Infinity);
  return r.top + r.height / 2 > top && r.top + r.height / 2 < bottom;
}

function flash(el: Element) {
  if (!tokens().easing) return;
  el.animate?.([{ backgroundColor: "var(--info-tint)", offset: 0 }], { duration: tokens().flash, easing: tokens().easing });
}

export function useArrivals(box: RefObject<HTMLElement | null>, added: Set<string>) {
  const seen = useRef(new Set<string>());
  const io = useRef<IntersectionObserver | null>(null);
  useEffect(() => () => io.current?.disconnect(), []);

  useLayoutEffect(() => {
    const fresh = [...added].filter((id) => !seen.current.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) seen.current.add(id);
    const { listIn, easing, shift } = tokens();
    if (!easing) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const id of fresh) {
      const el = box.current?.querySelector<HTMLElement>(`[data-rows] > [data-row-id="${CSS.escape(id)}"]`);
      if (!el) continue;
      if (inView(el)) {
        const from: Keyframe = still || !shift ? { opacity: 0, offset: 0 } : { opacity: 0, translate: `0 ${shift}`, offset: 0 };
        el.animate?.([from], { duration: listIn, easing });
        flash(el);
        continue;
      }
      if (typeof IntersectionObserver === "undefined") continue;
      io.current ??= new IntersectionObserver(
        (entries, observer) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            observer.unobserve(e.target);
            flash(e.target);
          }
        },
        { threshold: 0.5 },
      );
      io.current.observe(el);
    }
  }, [added, box]);
}
