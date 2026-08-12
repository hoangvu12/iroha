import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createApp } from '../../src/http/app.ts'
import { ReadinessState } from '../../src/http/readiness.ts'
import { OwnerIdentity } from '../../src/identity/index.ts'
import type { Database } from '../../src/persistence/index.ts'
import { sqliteEngine } from '../persistence/engines.ts'
import { providerRegistryFor } from '../support/app.ts'

describe('health endpoints', () => {
  let database: Database
  let dispose: () => Promise<void>
  let readiness: ReadinessState
  let app: ReturnType<typeof createApp>

  beforeEach(async () => {
    ;({ database, dispose } = await sqliteEngine.open())
    readiness = new ReadinessState()
    app = createApp({
      database,
      readiness,
      identity: new OwnerIdentity({ database }),
      providers: providerRegistryFor(database),
    })
  })

  afterEach(async () => {
    await dispose()
  })

  const get = (path: string) => app.handle(new Request(`http://iroha.test${path}`))

  test('liveness reports a running process before migrations complete', async () => {
    const response = await get('/health/live')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'alive' })
  })

  test('readiness withholds traffic until migrations complete', async () => {
    const response = await get('/health/ready')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'not_ready', reason: 'migrations_pending' })
  })

  test('readiness reports the engine once migrated', async () => {
    readiness.markMigrated()

    const response = await get('/health/ready')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'ready', database: { dialect: 'sqlite' } })
  })

  test('liveness stays healthy while readiness reports a database outage', async () => {
    readiness.markMigrated()
    await dispose()
    dispose = async () => undefined

    expect((await get('/health/live')).status).toBe(200)

    const ready = await get('/health/ready')
    expect(ready.status).toBe(503)
    expect(await ready.json()).toEqual({ status: 'not_ready', reason: 'database_unavailable' })
  })

  test('readiness stops accepting traffic once shutdown begins', async () => {
    readiness.markMigrated()
    readiness.beginShutdown()

    const response = await get('/health/ready')

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ status: 'not_ready', reason: 'shutting_down' })
  })

  test('neither endpoint discloses the connection target', async () => {
    readiness.markMigrated()

    for (const path of ['/health/live', '/health/ready']) {
      const body = await (await get(path)).text()
      expect(body).not.toContain(database.describe)
      expect(body).not.toContain('sqlite (test)')
    }
  })
})

describe('generated API documentation', () => {
  test('describes the health routes', async () => {
    const { database, dispose } = await sqliteEngine.open()
    const app = createApp({
      database,
      readiness: new ReadinessState(),
      identity: new OwnerIdentity({ database }),
      providers: providerRegistryFor(database),
    })

    try {
      const document = (await (
        await app.handle(new Request('http://iroha.test/docs/json'))
      ).json()) as { paths?: Record<string, unknown> }

      expect(Object.keys(document.paths ?? {})).toEqual(
        expect.arrayContaining([
          '/health/live',
          '/health/ready',
          '/api/v1/auth/state',
          '/api/v1/auth/setup',
          '/api/v1/auth/login',
        ]),
      )
    } finally {
      await dispose()
    }
  })
})
