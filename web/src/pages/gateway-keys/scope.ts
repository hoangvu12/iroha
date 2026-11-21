import { plural } from "@/lib/format";
import type { Scope } from "./api";

export type Draft = { all: boolean; providers: Map<string, string[] | null>; pools: Set<string> };

export function emptyDraft(): Draft {
  return { all: false, providers: new Map(), pools: new Set() };
}

export function toDraft(s: Scope): Draft {
  const providers = new Map<string, string[] | null>();
  for (const p of s.providers ?? []) providers.set(p.provider, p.models?.length ? [...p.models] : null);
  return { all: s.all, providers, pools: new Set(s.pools ?? []) };
}

export function toScope(d: Draft): Scope {
  if (d.all) return { all: true };
  return {
    all: false,
    providers: [...d.providers].map(([provider, models]) => (models ? { provider, models } : { provider })),
    pools: [...d.pools],
  };
}


export function scopeSummary(s: Scope): string {
  if (s.all) return "Everything";
  const p = s.providers?.length ?? 0;
  const q = s.pools?.length ?? 0;
  if (p === 0 && q === 0) return "Nothing";
  return [p && plural(p, "Provider"), q && plural(q, "Pool")].filter(Boolean).join(", ");
}

export function scopeDetail(s: Scope): string {
  if (s.all) return "Every Provider and Model Pool, including ones added later";
  const parts = (s.providers ?? []).map((p) => (p.models?.length ? `${p.provider} (${plural(p.models.length, "model")})` : p.provider));
  return [...parts, ...(s.pools ?? [])].join(", ") || "No Provider or Pool: every Request is refused";
}

export function modelsLabel(models: string[] | null): string {
  return models ? plural(models.length, "model") : "All models";
}

export function sameScope(a: Scope, b: Scope): boolean {
  return JSON.stringify(toScope(toDraft(a))) === JSON.stringify(toScope(toDraft(b)));
}
