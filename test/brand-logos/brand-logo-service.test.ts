import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { BrandLogoService } from '../../src/brand-logos/index.ts'
import type { ProviderTemplate } from '../../src/providers/index.ts'

const TEMPLATE_WITH_BRAND: ProviderTemplate = {
  id: 'openai',
  displayName: 'OpenAI',
  description: 'OpenAI-compatible endpoint.',
  baseUrl: 'https://api.openai.com/v1',
  authHeader: 'authorization',
  authPrefix: 'Bearer ',
  capabilities: {
    chat: true,
    streaming: true,
    tools: true,
    structuredOutput: true,
    responses: true,
  },
  knownModels: [],
  inferenceAdapterId: 'generic-inference-adapter',
  usageAdapterId: 'reactive-only-usage-adapter',
  brand: { domain: 'openai.com', accentColor: '#10A37F' },
}

const TEMPLATE_WITHOUT_BRAND: ProviderTemplate = {
  ...TEMPLATE_WITH_BRAND,
  id: 'generic-openai-compatible',
  brand: null,
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02])

interface FetchCall {
  readonly url: string
}

function stubbedFetch(responses: ReadonlyMap<string, Response>): {
  fetch: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fn = (async (input: Request | URL | string): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push({ url })
    const response = responses.get(url)
    if (response === undefined) {
      return new Response('not found', { status: 404 })
    }
    return response
  }) as unknown as typeof fetch
  return { fetch: fn, calls }
}

describe('BrandLogoService', () => {
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'iroha-brand-logos-'))
  })

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true })
  })

  test('returns null when the template is unknown', async () => {
    const { fetch } = stubbedFetch(new Map())
    const service = new BrandLogoService({
      token: 'tok',
      cacheDirectory: cacheDir,
      templates: [TEMPLATE_WITH_BRAND],
      fetch,
    })

    expect(await service.getLogo('not-a-template')).toBeNull()
  })

  test('returns null when the template has no brand identity', async () => {
    const { fetch } = stubbedFetch(new Map())
    const service = new BrandLogoService({
      token: 'tok',
      cacheDirectory: cacheDir,
      templates: [TEMPLATE_WITHOUT_BRAND],
      fetch,
    })

    expect(await service.getLogo('generic-openai-compatible')).toBeNull()
  })

  test('falls back to Google favicons when no logo.dev token is configured', async () => {
    const upstream = new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
    const url = 'https://www.google.com/s2/favicons?domain=openai.com&sz=64'
    const { fetch, calls } = stubbedFetch(new Map([[url, upstream]]))
    const service = new BrandLogoService({
      token: undefined,
      cacheDirectory: cacheDir,
      templates: [TEMPLATE_WITH_BRAND],
      fetch,
    })

    const logo = await service.getLogo('openai')
    expect(logo).not.toBeNull()
    expect(logo?.contentType).toBe('image/png')
    expect(Array.from(logo?.bytes ?? [])).toEqual(Array.from(PNG_BYTES))
    expect(calls.map((call) => call.url)).toEqual([url])
  })

  test('falls back to Google favicons when logo.dev refuses the token', async () => {
    const refused = new Response('rate limited', { status: 429 })
    const fallback = new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } })
    const logoDevUrl =
      'https://img.logo.dev/openai.com?token=tok&size=64&retina=true&format=webp'
    const faviconUrl = 'https://www.google.com/s2/favicons?domain=openai.com&sz=64'
    const { fetch, calls } = stubbedFetch(
      new Map([
        [logoDevUrl, refused],
        [faviconUrl, fallback],
      ]),
    )
    const service = new BrandLogoService({
      token: 'tok',
      cacheDirectory: cacheDir,
      templates: [TEMPLATE_WITH_BRAND],
      fetch,
    })

    const logo = await service.getLogo('openai')
    expect(logo).not.toBeNull()
    expect(logo?.contentType).toBe('image/png')
    expect(calls.map((call) => call.url)).toEqual([logoDevUrl, faviconUrl])
  })

  test('fetches from logo.dev on first miss and caches the bytes on disk and in memory', async () => {
    const upstream = new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/webp' } })
    const url = 'https://img.logo.dev/openai.com?token=tok&size=64&retina=true&format=webp'
    const { fetch, calls } = stubbedFetch(new Map([[url, upstream]]))
    const service = new BrandLogoService({
      token: 'tok',
      cacheDirectory: cacheDir,
      templates: [TEMPLATE_WITH_BRAND],
      fetch,
    })

    const first = await service.getLogo('openai')
    expect(first).not.toBeNull()
    expect(first?.contentType).toBe('image/webp')
    expect(Array.from(first?.bytes ?? [])).toEqual(Array.from(PNG_BYTES))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(url)

    // Disk cache should hold both the body and the content-type metadata so a
    // second instance can read it back without consulting logo.dev.
    const body = await readFile(join(cacheDir, 'openai.bin'))
    expect(Array.from(body)).toEqual(Array.from(PNG_BYTES))
    const meta = JSON.parse(await readFile(join(cacheDir, 'openai.meta.json'), 'utf8'))
    expect(meta.contentType).toBe('image/webp')

    // The in-memory cache means the second call does not hit the stubbed
    // fetch at all, even with the disk cache torn out from under it.
    const second = await service.getLogo('openai')
    expect(second).not.toBeNull()
    expect(calls).toHaveLength(1)
  })

  test('reads from the disk cache on a fresh service without contacting logo.dev', async () => {
    // Seed the disk cache by running one service, then construct a second
    // service that shares the same cache directory but has its own empty
    // in-memory map and a fetch that must never be called.
    const upstream = new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/webp' } })
    const seededUrl = 'https://img.logo.dev/openai.com?token=tok&size=64&retina=true&format=webp'
    const seeded = stubbedFetch(new Map([[seededUrl, upstream]]))
    const seeder = new BrandLogoService({
      token: 'tok',
      cacheDirectory: cacheDir,
      templates: [TEMPLATE_WITH_BRAND],
      fetch: seeded.fetch,
    })
    await seeder.getLogo('openai')

    const { fetch, calls } = stubbedFetch(new Map())
    const reader = new BrandLogoService({
      token: 'tok',
      cacheDirectory: cacheDir,
      templates: [TEMPLATE_WITH_BRAND],
      fetch,
    })

    const logo = await reader.getLogo('openai')
    expect(logo?.contentType).toBe('image/webp')
    expect(Array.from(logo?.bytes ?? [])).toEqual(Array.from(PNG_BYTES))
    expect(calls).toHaveLength(0)
  })

  test('returns null when both upstreams refuse', async () => {
    const logoDev = new Response('rate limited', { status: 429 })
    const favicon = new Response('not found', { status: 404 })
    const logoDevUrl =
      'https://img.logo.dev/openai.com?token=tok&size=64&retina=true&format=webp'
    const faviconUrl = 'https://www.google.com/s2/favicons?domain=openai.com&sz=64'
    const { fetch, calls } = stubbedFetch(
      new Map([
        [logoDevUrl, logoDev],
        [faviconUrl, favicon],
      ]),
    )
    const service = new BrandLogoService({
      token: 'tok',
      cacheDirectory: cacheDir,
      templates: [TEMPLATE_WITH_BRAND],
      fetch,
    })

    expect(await service.getLogo('openai')).toBeNull()
    expect(calls.map((call) => call.url)).toEqual([logoDevUrl, faviconUrl])
  })

  test('returns null when the upstream fetch throws', async () => {
    const fetchImpl = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const service = new BrandLogoService({
      token: 'tok',
      cacheDirectory: cacheDir,
      templates: [TEMPLATE_WITH_BRAND],
      fetch: fetchImpl,
    })

    expect(await service.getLogo('openai')).toBeNull()
  })
})
