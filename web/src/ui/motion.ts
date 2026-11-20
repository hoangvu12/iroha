// Motion tokens for JS-driven motion (WAAPI, timers), read from `:root`
// (styles/index.css "Motion tokens"), so JS uses the same values as CSS,
// including the reduced-motion rule that turns move and press durations to 0.

const root = () => getComputedStyle(document.documentElement);

/**
 * An error line (a Field error, a dialog's or a sheet form's): drops 4 px and fades in where it
 * appears, on the list recipe; no shake. The one copy: import it, don't write it out.
 */
export const appearClass = "transition-[opacity,translate] duration-list-in ease-out starting:-translate-y-(--motion-shift-sm) starting:opacity-0";

/** A `--duration-*` token in ms ("250ms", "0.25s"); 0 when it is missing or zeroed by reduced motion. */
export function durationOf(token: `--duration-${string}`): number {
  const v = root().getPropertyValue(token).trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

/** An `--ease-*` token as a CSS easing string, for `element.animate`. */
export function easingOf(token: `--ease-${string}`): string {
  return root().getPropertyValue(token).trim() || "ease";
}
