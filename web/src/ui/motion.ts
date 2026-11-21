const root = () => getComputedStyle(document.documentElement);

export const appearClass = "transition-[opacity,translate] duration-list-in ease-out starting:-translate-y-(--motion-shift-sm) starting:opacity-0";

export const firstScreenRiseIn = "transition-[opacity,translate] duration-dialog-in ease-out starting:translate-y-(--motion-shift) starting:opacity-0";

export function durationOf(token: `--duration-${string}`): number {
  const v = root().getPropertyValue(token).trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return 0;
  return v.endsWith("ms") ? n : v.endsWith("s") ? n * 1000 : n;
}

export function easingOf(token: `--ease-${string}`): string {
  return root().getPropertyValue(token).trim() || "ease";
}
