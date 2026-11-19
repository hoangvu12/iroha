/** "iroha_admin_…a91e": the secret's prefix and last four characters. */
export function shortSecret(secret: string): string {
  const cut = secret.lastIndexOf("_");
  const prefix = cut > 0 && cut < secret.length - 8 ? secret.slice(0, cut + 1) : "";
  return `${prefix}…${secret.slice(-4)}`;
}

/** "Oct 18" this year, "Oct 18, 2025" otherwise. */
export function shortDate(when: string | Date, now: Date = new Date()): string {
  const t = typeof when === "string" ? new Date(when) : when;
  return t.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: t.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

/** "14:32". */
export function clockTime(when: string | Date): string {
  const t = typeof when === "string" ? new Date(when) : when;
  return t.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

const DAY = 24 * 60 * 60 * 1000;

/** "Today", "Yesterday", "Mon, Nov 17", or "Nov 17, 2025" for an earlier year: the day groups of Audit Entries. */
export function dayLabel(when: string | Date, now: Date = new Date()): string {
  const t = typeof when === "string" ? new Date(when) : when;
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((start(now) - start(t)) / DAY);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (t.getFullYear() !== now.getFullYear()) return t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return t.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** A token or session not used for a month is worth a second look (C28: amber). */
export const STALE_MS = 30 * DAY;

/** "Last used" of an Admin Token, and whether it reads as stale. */
export function lastUsed(lastUsedAt: string | undefined, createdAt: string, now: Date = new Date()) {
  const since = new Date(lastUsedAt ?? createdAt).getTime();
  return { stale: now.getTime() - since >= STALE_MS, never: !lastUsedAt };
}
