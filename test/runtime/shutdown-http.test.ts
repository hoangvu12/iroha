import { afterEach, describe, expect, test } from 'bun:test'
import { ShutdownController } from '../../src/runtime/shutdown.ts'
import {
  completeSetup,
  createTestApp,
  type TestApp,
} from '../support/app.ts'
import { controlledSse, mockUpstreamTransport, sseEvent } from '../support/inference.ts'
import { fakeTimer, type FakeTimer } from '../support/timer.ts'

const UPSTREAM_KEY = 'sk-upstream-secret-value-for-tests'
const BASE_URL = 'https://api.example.com/v1'
const MODEL = 'gpt-4o-mini'

const running: TestApp[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.dispose()))
})

describe('HTTP shutdown lifecycle', () => {
  test('rejects new inference and aborts active upstream work after the grace period', async () => {
    const upstream = mockUpstreamTransport()
    const timer = fakeTimer()
    const shutdown = new ShutdownController({ graceMs: 250, timer })

    const test = await createTestApp({
      upstreamTransport: upstream.fetch,
      shutdown,
    })
    running.push(test)
    const signedIn = await completeSetup(test)

    const connectionResponse = await test.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Shutdown example', baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY }),
      csrf: signedIn.csrf,
    })
    const connection = (await connectionResponse.json()) as { id: string }
    const keyResponse = await test.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Shutdown app', scope: [{ providerId: connection.id }] }),
      csrf: signedIn.csrf,
    })
    const key = (await keyResponse.json()) as { secret: string }
    let release!: (response: Response) => void
    upstream.respondWith((call) => new Promise<Response>((resolve) => {
      call.signal?.addEventListener('abort', () => {
        resolve(new Response('', { status: 500 }))
      }, { once: true })
      release = resolve
    }))

    const first = test.fetch(`/providers/${connection.id}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hello' }] }),
    })
    while (upstream.calls.length === 0) await Bun.sleep(0)

    let drained = false
    const draining = shutdown.drain().then(() => {
      drained = true
    })
    timer.advance(249)
    timer.flush()
    expect(drained).toBe(false)
    expect(upstream.calls[0]?.signal?.aborted).toBe(false)

    timer.advance(1)
    timer.flush()
    expect(drained).toBe(false)
    expect(upstream.calls[0]?.signal?.aborted).toBe(true)
    release(new Response('{}', { status: 200 }))
    await first
    await draining
    expect(drained).toBe(true)

    const afterShutdown = await test.fetch(`/providers/${connection.id}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'again' }] }),
    })
    expect(afterShutdown.status).toBe(503)
    expect(await afterShutdown.json()).toMatchObject({
      error: { code: 'upstream_credentials_unavailable' },
    })
  })

  test('aborts an active streaming upstream after the grace period', async () => {
    const upstream = mockUpstreamTransport()
    const timer = fakeTimer()
    const shutdown = new ShutdownController({ graceMs: 250, timer })
    const test = await createTestApp({ upstreamTransport: upstream.fetch, shutdown })
    running.push(test)
    const signedIn = await completeSetup(test)
    const connectionResponse = await test.fetch('/api/v1/admin/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Streaming shutdown example', baseUrl: BASE_URL, upstreamKey: UPSTREAM_KEY }),
      csrf: signedIn.csrf,
    })
    const connection = (await connectionResponse.json()) as { id: string }
    const keyResponse = await test.fetch('/api/v1/admin/gateway-keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Streaming shutdown app', scope: [{ providerId: connection.id }] }),
      csrf: signedIn.csrf,
    })
    const key = (await keyResponse.json()) as { secret: string }
    let stream: ReturnType<typeof controlledSse> | undefined
    upstream.respondWith((call) => {
      stream = controlledSse(call)
      stream.enqueue(sseEvent('{"delta":{}}'))
      return new Response(stream.stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    })

    const responsePromise = test.fetch(`/providers/${connection.id}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}` },
      body: JSON.stringify({ model: MODEL, stream: true, messages: [{ role: 'user', content: 'hello' }] }),
    })
    while (upstream.calls.length === 0) await Bun.sleep(0)
    const response = await responsePromise
    const reader = response.body!.getReader()
    await reader.read()
    expect(upstream.calls[0]?.signal?.aborted).toBe(false)

    const draining = shutdown.drain()
    timer.advance(250)
    timer.flush()

    expect(upstream.calls[0]?.signal?.aborted).toBe(true)
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    await draining
  })
})
