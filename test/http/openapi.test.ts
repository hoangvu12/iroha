import { afterEach, describe, expect, test } from 'bun:test'
import { createTestApp, type TestApp } from '../support/app.ts'

const running: TestApp[] = []

afterEach(async () => {
  await Promise.all(running.splice(0).map((app) => app.dispose()))
})

describe('generated API documentation', () => {
  test('describes custom APIs and links the OpenAI capability matrix', async () => {
    const test = await createTestApp()
    running.push(test)
    const document = (await (await test.fetch('/docs/json')).json()) as {
      paths?: Record<string, unknown>
      components?: { securitySchemes?: Record<string, unknown> }
      externalDocs?: { url?: string }
    }
    const paths = Object.keys(document.paths ?? {})

    expect(paths).toEqual(expect.arrayContaining([
      '/api/v1/admin/providers',
      '/api/v1/admin/metrics',
      '/api/v1/directory/providers',
      '/docs/capability-matrix',
    ]))
    expect(paths.some((path) => /^\/providers\/[^/]+\/v1\//.test(path))).toBe(false)
    expect(document.components?.securitySchemes).toMatchObject({
      GatewayKey: { type: 'http', scheme: 'bearer' },
      OwnerSession: { type: 'apiKey', in: 'cookie', name: 'iroha_session' },
    })
    expect((document.paths?.['/api/v1/directory/providers'] as { get?: { security?: unknown } })?.get?.security)
      .toEqual([{ GatewayKey: [] }])
    expect((document.paths?.['/api/v1/admin/providers'] as { get?: { security?: unknown } })?.get?.security)
      .toEqual([{ OwnerSession: [] }])
    for (const [path, operations] of Object.entries(document.paths ?? {})) {
      if (!path.startsWith('/api/v1/admin/')) continue
      for (const operation of Object.values(operations as Record<string, { security?: unknown }>)) {
        expect(operation.security).toEqual([{ OwnerSession: [] }])
      }
    }
    expect(document.externalDocs?.url).toBe('/docs/capability-matrix')

    const capability = await test.fetch('/docs/capability-matrix')
    expect(capability.status).toBe(200)
    expect(await capability.text()).toContain('Chat Completions')
  })
})
