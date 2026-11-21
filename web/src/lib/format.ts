const nf = new Intl.NumberFormat("en-US");

export function formatNumber(n: number): string {
  return nf.format(n);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function formatPercent(ratio: number): string {
  const p = ratio * 100;
  return `${p >= 99.95 ? "100" : p.toFixed(1)}%`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(s < 1 ? 2 : 1) : Math.round(s)} s`;
}

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

export function formatDate(when: string | Date): string {
  const t = typeof when === "string" ? new Date(when) : when;
  return t.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function formatTime(when: string | Date): string {
  const t = typeof when === "string" ? new Date(when) : when;
  return t.toLocaleTimeString("en-GB", { hour12: false });
}
