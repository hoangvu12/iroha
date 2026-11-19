import { describe, expect, it } from "vitest";
import css from "./index.css?raw";

// The motion system (architecture.md "UI motion system") lives in
// styles/index.css. jsdom can't evaluate media queries or Tailwind, so this
// reads the stylesheet through the CSSOM: the tokens on :root, and what the
// prefers-reduced-motion rule sets them to.

function sheet(): CSSStyleSheet {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const s = style.sheet!;
  style.remove();
  return s;
}

function rootDeclarations(rules: CSSRuleList): Map<string, string> {
  const out = new Map<string, string>();
  for (const rule of Array.from(rules)) {
    if (!(rule instanceof CSSStyleRule) || rule.selectorText !== ":root") continue;
    for (const name of Array.from(rule.style)) out.set(name, rule.style.getPropertyValue(name).trim());
  }
  return out;
}

function reducedMotionRoot(s: CSSStyleSheet): Map<string, string> {
  const media = Array.from(s.cssRules).filter(
    (r): r is CSSMediaRule => r instanceof CSSMediaRule && /prefers-reduced-motion:\s*reduce/.test(r.media.mediaText),
  );
  expect(media, "one top-level @media (prefers-reduced-motion: reduce) rule").toHaveLength(1);
  return rootDeclarations(media[0].cssRules);
}

const tokens: Record<string, string> = {
  "--duration-hover": "150ms",
  "--duration-press": "160ms",
  "--duration-release": "100ms",
  "--duration-tooltip": "125ms",
  "--duration-popup-in": "180ms",
  "--duration-popup-out": "120ms",
  "--duration-dialog-in": "200ms",
  "--duration-dialog-out": "150ms",
  "--duration-sheet-in": "300ms",
  "--duration-sheet-out": "240ms",
  "--duration-indicator": "200ms",
  "--duration-collapse": "200ms",
  "--duration-move": "250ms",
  "--duration-list-in": "200ms",
  "--duration-list-out": "150ms",
  "--duration-toast": "400ms",
  "--duration-fade": "150ms",
  "--duration-flash": "1600ms",
  "--duration-scrollbar-in": "100ms",
  "--duration-scrollbar-out": "200ms",
  "--motion-scale-popup": "0.96",
  "--motion-scale-press": "0.97",
  "--motion-shift": "8px",
  "--motion-shift-sm": "4px",
  "--motion-sheet-offset": "100%",
  "--motion-toast-offset": "100%",
};

describe("motion tokens", () => {
  it("defines every duration, distance and scale on :root", () => {
    const root = rootDeclarations(sheet().cssRules);
    for (const [name, value] of Object.entries(tokens)) expect(root.get(name), name).toBe(value);
  });

  it("defines the three curves", () => {
    // Tailwind's @theme isn't plain CSS, so read the curves from the source.
    expect(css).toMatch(/--ease-out:\s*cubic-bezier\(0\.23, 1, 0\.32, 1\)/);
    expect(css).toMatch(/--ease-in-out:\s*cubic-bezier\(0\.77, 0, 0\.175, 1\)/);
    expect(css).toMatch(/--ease-drawer:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\)/);
  });

  it("presses down slower than it lets go, for a pointer only, with hover colours on their own curve", () => {
    // The `press` utility (ui/Button.tsx). Tailwind's @utility isn't plain CSS, so read the source.
    const press = css.match(/@utility press \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(press, "@utility press").not.toBe("");
    // Let go: the scale snaps back on --duration-release; colours on hover's duration and `ease`.
    expect(press).toMatch(
      /transition:\s*scale var\(--duration-release\) var\(--ease-out\),\s*background-color var\(--duration-hover\) ease,\s*color var\(--duration-hover\) ease;/,
    );
    // Held: down on --duration-press; never for a key press (focus-visible), a disabled or a pending button.
    expect(press).toMatch(
      /&:active:not\(:focus-visible\):not\(\[data-disabled\]\):not\(\[data-pending\]\)\s*\{[^}]*scale:\s*var\(--motion-scale-press\);[^}]*transition-duration:\s*var\(--duration-press\), var\(--duration-hover\), var\(--duration-hover\);/,
    );
  });

  it("has a one-time rise-in that also plays on page load, built from the tokens", () => {
    // @starting-style is skipped when an element is styled before the first
    // frame (Chrome, a fast reload of the login page), so a page's first
    // screen uses this keyframe entrance instead.
    expect(css).toMatch(/--animate-rise-in:\s*rise-in var\(--duration-dialog-in\) var\(--ease-out\) backwards;/);
    const rule = Array.from(sheet().cssRules).find((r): r is CSSKeyframesRule => r instanceof CSSKeyframesRule && r.name === "rise-in");
    expect(rule, "@keyframes rise-in").toBeDefined();
    const from = rule!.findRule("from") ?? rule!.findRule("0%");
    expect(from?.style.getPropertyValue("opacity")).toBe("0");
    expect(from?.style.getPropertyValue("translate")).toBe("0 var(--motion-shift)");
  });

  it("turns every transition off while the theme flips (app/theme.tsx)", () => {
    const rule = Array.from(sheet().cssRules).find(
      (r): r is CSSStyleRule => r instanceof CSSStyleRule && r.selectorText.includes(".theme-switching"),
    );
    expect(rule?.selectorText).toMatch(/\.theme-switching \*/);
    expect(rule?.style.getPropertyValue("transition")).toBe("none");
    expect(rule?.style.getPropertyPriority("transition")).toBe("important");
  });

  it("holds movement still under reduced motion and keeps fades", () => {
    const reduce = reducedMotionRoot(sheet());
    // Nothing moves or changes size...
    for (const name of ["--duration-press", "--duration-release", "--duration-indicator", "--duration-collapse", "--duration-move", "--duration-sheet-in", "--duration-sheet-out"])
      expect(reduce.get(name), name).toBe("0ms");
    for (const name of ["--motion-shift", "--motion-shift-sm"]) expect(reduce.get(name), name).toBe("0px");
    for (const name of ["--motion-sheet-offset", "--motion-toast-offset"]) expect(reduce.get(name), name).toBe("0%");
    for (const name of ["--motion-scale-popup", "--motion-scale-press"]) expect(reduce.get(name), name).toBe("1");
    // ...nothing loops...
    for (const name of ["--animate-pulse", "--animate-ping", "--animate-bounce"]) expect(reduce.get(name), name).toBe("none");
    // ...and enter/exit, hover and arrival keep their durations, now as fades.
    for (const name of ["--duration-hover", "--duration-tooltip", "--duration-popup-in", "--duration-dialog-in", "--duration-list-in", "--duration-toast", "--duration-fade", "--duration-flash"])
      expect(reduce.has(name), `${name} untouched`).toBe(false);
  });
});
