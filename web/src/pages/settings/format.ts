export function shortSecret(secret: string): string {
  const cut = secret.lastIndexOf("_");
  const prefix = cut > 0 && cut < secret.length - 8 ? secret.slice(0, cut + 1) : "";
  return `${prefix}…${secret.slice(-4)}`;
}

export function shortDate(when: string | Date, now: Date = new Date()): string {
  const t = typeof when === "string" ? new Date(when) : when;
  return t.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: t.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

export function clockTime(when: string | Date): string {
  const t = typeof when === "string" ? new Date(when) : when;
  return t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

const DAY = 24 * 60 * 60 * 1000;

export function dayLabel(when: string | Date, now: Date = new Date()): string {
  const t = typeof when === "string" ? new Date(when) : when;
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(t)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (t.getFullYear() !== now.getFullYear()) return t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return t.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export const STALE_MS = 30 * DAY;

export function lastUsed(lastUsedAt: string | undefined, createdAt: string, now: Date = new Date()) {
  const since = new Date(lastUsedAt ?? createdAt).getTime();
  return { stale: now.getTime() - since >= STALE_MS, never: !lastUsedAt };
}
