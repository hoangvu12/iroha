import { isApiError, request, seg } from "./client";

export function providerLogo(handle: string, cacheKey?: string): string {
  return `/api/providers/${seg(handle)}/logo${cacheKey !== undefined ? `?v=${encodeURIComponent(cacheKey)}` : ""}`;
}

export function poolLogo(name: string, cacheKey?: string): string {
  return `/api/pools/${seg(name)}/logo${cacheKey !== undefined ? `?v=${encodeURIComponent(cacheKey)}` : ""}`;
}

export function logoPreview(q: { domain: string } | { maker: string }): string {
  return "domain" in q ? `/api/logos?domain=${encodeURIComponent(q.domain)}` : `/api/logos?maker=${encodeURIComponent(q.maker)}`;
}

export async function findLogo(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await request("GET", url, undefined, { signal, headers: { Accept: "image/*" } });
    return true;
  } catch (e) {
    if (isApiError(e) && e.status === 404) return false;
    throw e;
  }
}
