// Formatting shared by every page. One fact per cell: these return one
// short value each.

const nf = new Intl.NumberFormat("en-US");

/** 4112 -> "4,112". */
export function formatNumber(n: number): string {
  return nf.format(n);
}

/** A count with its noun: (1, "key") -> "1 key"; (1200, "key") -> "1,200 keys"; (2, "entry", "entries"). */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

/** 0.989 -> "98.9%"; 1 -> "100%". */
export function formatPercent(ratio: number): string {
  const p = ratio * 100;
  return `${p >= 99.95 ? "100" : p.toFixed(1)}%`;
}

/** Milliseconds -> "0.44 s", "2.1 s", "850 ms". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(s < 1 ? 2 : 1) : Math.round(s)} s`;
}

/** "just now", "12 sec ago", "4 min ago", "2 days ago" (C05). */
export function timeAgo(when: string | Date | undefined | null, now: Date = new Date()): string {
  if (!when) return "never";
  const t = typeof when === "string" ? new Date(when) : when;
  const s = Math.round((now.getTime() - t.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s} sec ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d} day${d === 1 ? "" : "s"} ago`;
  return formatDate(t);
}

/** "19 Nov 2026". */
export function formatDate(when: string | Date): string {
  const t = typeof when === "string" ? new Date(when) : when;
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** "14:03:22". */
export function formatTime(when: string | Date): string {
  const t = typeof when === "string" ? new Date(when) : when;
  return t.toLocaleTimeString("en-GB", { hour12: false });
}
