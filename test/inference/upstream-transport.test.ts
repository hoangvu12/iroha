import { describe, expect, test } from 'bun:test'
import {
  MAX_SAME_ORIGIN_REDIRECTS,
  redirectPolicy,
  sameOriginOf,
  upstreamFetch,
} from '../../src/inference/upstream-transport.ts'

function requestOptions(overrides: Partial<Parameters<typeof upstreamFetch>[1]> = {}) {
  return {
    url: 'https://api.example.com/start',
    method: 'POST' as const,
    headers: {},
    body: undefined,
    follow: 'manual' as const,
    origin: 'https://api.example.com',
    signal: null,
    headerTimeoutMs: 1_000,
    totalTimeoutMs: 1_000,
    ...overrides,
  }
}

describe('upstreamFetch redirects', () => {
  test('follows same-origin redirects to the final response', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls < 3) {
        return new Response(null, { status: 302, headers: { location: `/hop${calls}` } })
      }
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch

    const result = await upstreamFetch(fetchImpl, requestOptions({ follow: 'follow-same-origin' }))
    expect(result.response.status).toBe(200)
    expect(await result.readText()).toBe('ok')
    expect(calls).toBe(3)
    result.dispose()
  })

  test('stops a same-origin redirect loop at the hop cap instead of looping forever', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { location: '/loop' } })
    }) as unknown as typeof fetch

    const result = await upstreamFetch(fetchImpl, requestOptions({ follow: 'follow-same-origin' }))
    // The over-limit chain is returned as the redirect response itself.
    expect(result.response.status).toBe(302)
    expect(calls).toBe(MAX_SAME_ORIGIN_REDIRECTS + 1)
    result.dispose()
  })

  test('never follows a cross-origin redirect', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { location: 'https://evil.example.com/steal' } })
    }) as unknown as typeof fetch

    const result = await upstreamFetch(fetchImpl, requestOptions({ follow: 'follow-same-origin' }))
    expect(result.response.status).toBe(302)
    expect(calls).toBe(1)
    result.dispose()
  })

  test('manual policy returns the redirect without following it', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { location: '/next' } })
    }) as unknown as typeof fetch

    const result = await upstreamFetch(fetchImpl, requestOptions({ follow: 'manual' }))
    expect(result.response.status).toBe(302)
    expect(calls).toBe(1)
    result.dispose()
  })
})

describe('upstreamFetch deadlines', () => {
  test('aborts when response headers outlive the header deadline', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
      })) as unknown as typeof fetch

    await expect(
      upstreamFetch(fetchImpl, requestOptions({ headerTimeoutMs: 10 })),
    ).rejects.toThrow()
  })

  test('aborts a buffered body read that outlives the total deadline', async () => {
    const body = new ReadableStream<Uint8Array>({ start() {} })
    const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch

    const result = await upstreamFetch(fetchImpl, requestOptions({ headerTimeoutMs: 1_000, totalTimeoutMs: 10 }))
    await expect(result.readText()).rejects.toThrow()
    result.dispose()
  })

  test('a caller abort propagates to the upstream request', async () => {
    const controller = new AbortController()
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')))
      })) as unknown as typeof fetch

    const pending = upstreamFetch(fetchImpl, requestOptions({ signal: controller.signal, headerTimeoutMs: 0 }))
    controller.abort(new Error('caller went away'))
    await expect(pending).rejects.toThrow('caller went away')
  })
})

describe('redirectPolicy', () => {
  test('allows same-origin following only when the connection opts in', () => {
    expect(redirectPolicy({ redirectAllowSameOrigin: false, baseUrl: 'https://api.example.com/v1' })).toEqual({
      follow: 'manual',
      origin: null,
    })
    expect(redirectPolicy({ redirectAllowSameOrigin: true, baseUrl: 'https://api.example.com/v1' })).toEqual({
      follow: 'follow-same-origin',
      origin: 'https://api.example.com',
    })
  })

  test('sameOriginOf returns null for an invalid base URL', () => {
    expect(sameOriginOf('not a url')).toBeNull()
  })
})