/**
 * Verifies the full brand-logo flow: the management UI hits the proxy, the
 * proxy returns the upstream bytes, the UI sees a successful response. Runs
 * in-process — no browser, but every server-side seam is exercised end to
 * end through the assembled HTTP application.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrandLogoService } from '../../src/brand-logos/index.ts'
import { createTestApp, type TestApp } from '../support/app.ts'

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02, 0x03, 0x04,
])

function stubbedFetch(bytes: Uint8Array, contentType: string): typeof fetch {
  return (async (input: Request | URL | string) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (!url.includes('img.logo.dev/openai.com')) {
      return new Response('not found', { status: 404 })
    }
    return new Response(bytes, { status: 200, headers: { 'content-type': contentType } })
  }) as unknown as typeof fetch
}

describe('end-to-end brand logo flow through the assembled app', () => {
  let iroha: TestApp
  let cacheDir: string

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'iroha-e2e-brand-'))
    const brandLogos = new BrandLogoService({
      token: 'live_test_token',
      cacheDirectory: cacheDir,
      templates: [
        {
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
        },
      ],
      fetch: stubbedFetch(PNG_BYTES, 'image/png'),
    })
    iroha = await createTestApp({ brandLogos })
  })

  afterEach(async () => {
    await iroha.dispose()
    await rm(cacheDir, { recursive: true, force: true })
  })

  test('a browser-shaped GET returns 200 + image bytes the moment the picker renders', async () => {
    const response = await iroha.fetch('/api/v1/brand-logos/openai', {
      headers: {
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        // Browsers do not send Origin on `<img>` requests; mimic that.
      },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    const body = new Uint8Array(await response.arrayBuffer())
    expect(Array.from(body)).toEqual(Array.from(PNG_BYTES))
  })
})
