import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ProviderTemplate } from '../providers/index.ts'

/**
 * Server-side proxy for Provider brand logos.
 *
 * Two upstreams, picked per deployment:
 *
 *   - `logo.dev` when `LOGO_DEV_TOKEN` is set. Higher-quality brand marks;
 *     the token stays on the server and never reaches the browser.
 *   - Google's favicon service otherwise. No key, no setup; the trade-off
 *     is smaller and simpler marks (the site's favicon instead of its full
 *     brand lockup). Picking this path keeps a fresh deployment from showing
 *     a generic server icon on every Provider until the Owner gets a key.
 *
 * Either way the bytes are cached on disk (survives restart) and in memory
 * (short-circuits hot tiles). A 24-hour TTL means a stale logo self-heals on
 * the next read; the 256-entry in-memory cap is a defensive bound for a
 * misconfigured registry. Three preconditions still gate a fetch: the
 * template must exist, the template must declare a brand, and at least one
 * upstream must answer 200 — any miss returns null so the route answers 404
 * and the UI falls back to the generic icon.
 *
 * A caller may request a specific logo theme (`light` or `dark`) so the mark
 * stays visible on its background; logo.dev adjusts dominant-colour logos to
 * suit. Light and dark variants are cached under separate keys so both can
 * coexist, and `auto` (the default) skips the adjustment entirely.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 256

/** logo.dev's upstream image endpoint; the response honours `format=webp`. */
const LOGO_DEV_UPSTREAM = 'https://img.logo.dev'

/**
 * Google's free favicon service. No token, no signup; the `sz` param
 * requests the largest size Google has cached for the domain (typically 64).
 */
const GOOGLE_FAVICON_UPSTREAM = 'https://www.google.com/s2/favicons'

interface CacheEntry {
  readonly bytes: Uint8Array
  readonly contentType: string
  readonly expiresAt: number
}

/**
 * Which background the logo will sit on. `auto` asks logo.dev for no colour
 * adjustment (its default); `light` and `dark` flip dominant-colour logos so
 * they stay visible on that background. Only the logo.dev upstream honours
 * it; Google's favicon service has no such option.
 */
export type BrandLogoTheme = 'auto' | 'light' | 'dark'

export interface BrandLogoServiceOptions {
  /**
   * logo.dev API token. When set, the service uses logo.dev for higher
   * quality brand marks; when null, it falls back to Google's favicon
   * service so a fresh deployment still gets a logo on every Provider.
   * Never logged.
   */
  readonly token: string | undefined
  /**
   * Directory the disk cache lives in. Created on first write. An absolute
   * path is used verbatim; a relative path is resolved against the working
   * directory the way DATABASE_URL's SQLite path is.
   */
  readonly cacheDirectory: string
  /** The Provider Templates the service knows how to render. */
  readonly templates: readonly ProviderTemplate[]
  /** Replaces the upstream fetch; tests inject a stub. */
  readonly fetch?: typeof fetch
}

export interface CachedBrandLogo {
  readonly bytes: Uint8Array
  readonly contentType: string
}

/**
 * Resolves the bytes for a Provider Template's brand logo, fetching from
 * the configured upstream on first miss and serving cached bytes thereafter.
 */
export class BrandLogoService {
  readonly #token: string | undefined
  readonly #cacheDirectory: string
  readonly #templates: ReadonlyMap<string, ProviderTemplate>
  readonly #fetch: typeof fetch
  readonly #cache = new Map<string, CacheEntry>()

  constructor(options: BrandLogoServiceOptions) {
    this.#token = options.token
    this.#cacheDirectory = isAbsolute(options.cacheDirectory)
      ? options.cacheDirectory
      : join(process.cwd(), options.cacheDirectory)
    this.#templates = new Map(options.templates.map((template) => [template.id, template]))
    this.#fetch = options.fetch ?? globalThis.fetch
  }

  /**
   * Returns the logo bytes and content type for one template, or null when
   * the template has no brand or every upstream refused. The route answers
   * 404 in every null case so the UI's `<img onerror>` fallback fires.
   *
   * The theme selects a logo adjusted for a light or dark background; each
   * theme is cached under its own key so both variants can be served.
   */
  async getLogo(templateId: string, theme: BrandLogoTheme = 'auto'): Promise<CachedBrandLogo | null> {
    const template = this.#templates.get(templateId)
    if (template === undefined || template.brand === null) return null

    const cacheKey = this.#cacheKey(templateId, theme)

    const cached = this.#readFromMemory(cacheKey)
    if (cached !== null) return cached

    const onDisk = await this.#readFromDisk(cacheKey)
    if (onDisk !== null) {
      this.#writeToMemory(cacheKey, onDisk.contentType, onDisk.bytes)
      return onDisk
    }

    const fetched = await this.#fetchFromUpstream(template.brand.domain, theme)
    if (fetched === null) return null

    await this.#writeToDisk(cacheKey, fetched)
    this.#writeToMemory(cacheKey, fetched.contentType, fetched.bytes)
    return fetched
  }

  /** A theme shares the plain template id; themed variants get a suffix. */
  #cacheKey(templateId: string, theme: BrandLogoTheme): string {
    return theme === 'auto' ? templateId : `${templateId}.${theme}`
  }

  #readFromMemory(cacheKey: string): CachedBrandLogo | null {
    const entry = this.#cache.get(cacheKey)
    if (entry === undefined) return null
    if (entry.expiresAt <= Date.now()) {
      this.#cache.delete(cacheKey)
      return null
    }
    return { bytes: entry.bytes, contentType: entry.contentType }
  }

  #writeToMemory(cacheKey: string, contentType: string, bytes: Uint8Array): void {
    if (this.#cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.#cache.keys().next().value
      if (oldest !== undefined) this.#cache.delete(oldest)
    }
    this.#cache.set(cacheKey, {
      bytes,
      contentType,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
  }

  async #readFromDisk(cacheKey: string): Promise<CachedBrandLogo | null> {
    const bodyPath = join(this.#cacheDirectory, `${cacheKey}.bin`)
    const metaPath = join(this.#cacheDirectory, `${cacheKey}.meta.json`)
    try {
      const [body, metaRaw] = await Promise.all([
        readFile(bodyPath),
        readFile(metaPath, 'utf8'),
      ])
      const meta = JSON.parse(metaRaw) as { contentType?: unknown }
      if (typeof meta.contentType !== 'string') return null
      return { bytes: new Uint8Array(body), contentType: meta.contentType }
    } catch {
      return null
    }
  }

  async #writeToDisk(cacheKey: string, logo: CachedBrandLogo): Promise<void> {
    await mkdir(this.#cacheDirectory, { recursive: true })
    const bodyPath = join(this.#cacheDirectory, `${cacheKey}.bin`)
    const metaPath = join(this.#cacheDirectory, `${cacheKey}.meta.json`)
    await Promise.all([
      writeFile(bodyPath, logo.bytes),
      writeFile(metaPath, JSON.stringify({ contentType: logo.contentType })),
    ])
  }

  async #fetchFromUpstream(domain: string, theme: BrandLogoTheme): Promise<CachedBrandLogo | null> {
    // Try logo.dev first when a token is configured, then fall back to
    // Google's favicon service. Both upstreams can fail for benign reasons
    // (rate limit, transient outage, no cached favicon for an obscure
    // domain); the route collapses every failure into a single 404 so the
    // UI's `<img onerror>` fallback is the only consumer-side branch.
    if (this.#token !== undefined) {
      const logoDev = await this.#fetchFromLogoDev(domain, theme)
      if (logoDev !== null) return logoDev
    }
    return await this.#fetchFromGoogleFavicon(domain)
  }

  async #fetchFromLogoDev(domain: string, theme: BrandLogoTheme): Promise<CachedBrandLogo | null> {
    const url = new URL(`${LOGO_DEV_UPSTREAM}/${domain}`)
    url.searchParams.set('token', this.#token as string)
    url.searchParams.set('size', '64')
    url.searchParams.set('retina', 'true')
    url.searchParams.set('format', 'webp')
    if (theme !== 'auto') url.searchParams.set('theme', theme)

    return await this.#fetchImage(url.toString(), 'image/webp')
  }

  async #fetchFromGoogleFavicon(domain: string): Promise<CachedBrandLogo | null> {
    const url = new URL(GOOGLE_FAVICON_UPSTREAM)
    url.searchParams.set('domain', domain)
    url.searchParams.set('sz', '64')

    return await this.#fetchImage(url.toString(), 'image/png')
  }

  async #fetchImage(url: string, fallbackContentType: string): Promise<CachedBrandLogo | null> {
    let response: Response
    try {
      response = await this.#fetch(url)
    } catch {
      return null
    }
    if (!response.ok) return null

    const arrayBuffer = await response.arrayBuffer()
    const contentType = response.headers.get('content-type') ?? fallbackContentType
    return { bytes: new Uint8Array(arrayBuffer), contentType }
  }
}
