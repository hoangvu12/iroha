import { isApiError, request, seg } from "./client";

// Logo URLs. Iroha fetches and caches every logo and serves it itself, so
// the browser never loads a third-party image. A logo that is missing
// answers 404, and LogoTile then draws the first letter (round for
// Providers, rounded square for Model Pools).
//
// `version` is what the logo was looked up for (a Provider's logo_domain, a
// Pool's maker) when the caller knows it, so a change shows at once instead
// of after the browser's cache expires.

/** A Provider's logo, from its logo domain. */
export function providerLogo(handle: string, version?: string): string {
  return `/api/providers/${seg(handle)}/logo${version !== undefined ? `?v=${encodeURIComponent(version)}` : ""}`;
}

/** A Model Pool's logo: its model maker's. */
export function poolLogo(name: string, version?: string): string {
  return `/api/pools/${seg(name)}/logo${version !== undefined ? `?v=${encodeURIComponent(version)}` : ""}`;
}

/**
 * The logo a Provider's domain or a Pool's maker value (a maker ID or a
 * website) would give, to preview a change before saving it.
 */
export function logoPreview(q: { domain: string } | { maker: string }): string {
  return "domain" in q ? `/api/logos?domain=${encodeURIComponent(q.domain)}` : `/api/logos?maker=${encodeURIComponent(q.maker)}`;
}

/**
 * Whether Iroha finds a logo at `url` (one of the URLs above): false when it
 * answers 404 logo_unavailable; any other failure (a value Iroha refuses is a
 * 400) is thrown as its ApiError.
 */
export async function findLogo(url: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await request("GET", url, undefined, { signal, headers: { Accept: "image/*" } });
    return true;
  } catch (e) {
    if (isApiError(e) && e.status === 404) return false;
    throw e;
  }
}
