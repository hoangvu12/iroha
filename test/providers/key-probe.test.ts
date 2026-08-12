import { describe, expect, test } from 'bun:test'
import { createGenericKeyProbe } from '../../src/providers/index.ts'

const API_KEY = 'sk-upstream-secret-value'

interface Seen {
  url: string
  init: RequestInit | undefined
}

/** Records the request and answers with a prepared response or error. */
function fakeFetch(answer: (() => Promise<Response>) | (() => never)) {
  const seen: Seen[] = []

  const fetchImpl = (async (input: Request | URL | string, init?: RequestInit) => {
    seen.push({ url: String(input), init })
    return await answer()
  }) as typeof fetch

  return { seen, fetch: fetchImpl }
}

describe('the generic key probe', () => {
  test('reads the models endpoint with the key as a bearer credential', async () => {
    const { seen, fetch } = fakeFetch(async () => new Response('{}', { status: 200 }))
    const probe = createGenericKeyProbe({ fetch })

    await probe.test({ baseUrl: 'https://api.example.com/v1', upstreamKey: API_KEY })

    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe('https://api.example.com/v1/models')
    expect(seen[0]?.init?.method).toBe('GET')

    const headers = (seen[0]?.init?.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${API_KEY}`)
    expect(seen[0]?.init?.redirect).toBe('manual')
  })

  test('joins base URLs with or without a trailing slash the same way', async () => {
    const { seen, fetch } = fakeFetch(async () => new Response('{}', { status: 200 }))
    const probe = createGenericKeyProbe({ fetch })

    await probe.test({ baseUrl: 'https://api.example.com/v1/', upstreamKey: API_KEY })

    expect(seen[0]?.url).toBe('https://api.example.com/v1/models')
  })

  test('calls a usable key usable', async () => {
    for (const status of [200, 204, 299]) {
      const { fetch } = fakeFetch(async () => new Response('{}', { status }))
      const result = await createGenericKeyProbe({ fetch }).test({
        baseUrl: 'https://api.example.com/v1',
        upstreamKey: API_KEY,
      })

      expect(result.verdict).toBe('usable')
      expect(result.reason).toBeNull()
    }
  })

  test('calls an explicit 401 a rejected key', async () => {
    const { fetch } = fakeFetch(async () => new Response('{}', { status: 401 }))

    const result = await createGenericKeyProbe({ fetch }).test({
      baseUrl: 'https://api.example.com/v1',
      upstreamKey: API_KEY,
    })

    expect(result.verdict).toBe('rejected')
    expect(result.reason).toContain('401')
  })

  test.each([
    ['a redirect', 302],
    ['an ambiguous 403', 403],
    ['a missing models endpoint', 404],
    ['a rate limit', 429],
    ['a server error', 500],
    ['an upstream outage', 503],
  ])('keeps the key and its reason after %s', async (_label, status) => {
    const { fetch } = fakeFetch(async () => new Response('{}', { status }))

    const result = await createGenericKeyProbe({ fetch }).test({
      baseUrl: 'https://api.example.com/v1',
      upstreamKey: API_KEY,
    })

    expect(result.verdict).toBe('inconclusive')
    expect(result.reason).not.toBeNull()
  })

  test('reports an unreachable provider as inconclusive', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed')
    })

    const result = await createGenericKeyProbe({ fetch }).test({
      baseUrl: 'https://api.example.com/v1',
      upstreamKey: API_KEY,
    })

    expect(result).toEqual({ verdict: 'inconclusive', reason: 'the provider could not be reached' })
  })

  test('reports a slow provider as inconclusive', async () => {
    const { fetch } = fakeFetch(() => {
      throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' })
    })

    const result = await createGenericKeyProbe({ fetch }).test({
      baseUrl: 'https://api.example.com/v1',
      upstreamKey: API_KEY,
    })

    expect(result.verdict).toBe('inconclusive')
    expect(result.reason).toContain('timed out')
  })

  test('rejects a stored base URL that cannot name a models endpoint', async () => {
    const probe = createGenericKeyProbe({ fetch: fakeFetch(async () => new Response('{}')).fetch })

    const result = await probe.test({ baseUrl: 'not a url', upstreamKey: API_KEY })

    expect(result.verdict).toBe('inconclusive')
  })

  test('never lets the key appear in a reported reason', async () => {
    const answers = [
      async () => new Response('{}', { status: 200 }),
      async () => new Response('{}', { status: 401 }),
      async () => new Response('{}', { status: 403 }),
      async () => new Response('{}', { status: 429 }),
      async () => new Response('{}', { status: 500 }),
      () => {
        throw new TypeError('fetch failed')
      },
    ] as const

    for (const answer of answers) {
      const probe = createGenericKeyProbe({ fetch: answer as unknown as typeof fetch })
      const result = await probe.test({ baseUrl: 'https://api.example.com/v1', upstreamKey: API_KEY })

      expect(`${result.reason ?? ''}`).not.toContain(API_KEY)
    }
  })
})
