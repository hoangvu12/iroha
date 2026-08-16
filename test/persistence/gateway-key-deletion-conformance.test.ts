import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GatewayKeyRegistry } from '../../src/keys/index.ts'
import type { Database } from '../../src/persistence/index.ts'
import { availableEngines } from './engines.ts'

for (const engine of availableEngines) {
  describe(`${engine.name} revoked Gateway Key deletion`, () => {
    let database: Database
    let registry: GatewayKeyRegistry
    let dispose: () => Promise<void>

    beforeEach(async () => {
      ;({ database, dispose } = await engine.open())
      registry = new GatewayKeyRegistry({
        database,
        clock: { now: () => new Date('2026-08-17T00:00:00.000Z') },
      })
    })

    afterEach(async () => await dispose())

    test('removes only revoked credential material and preserves its safe audit snapshot', async () => {
      const created = await registry.create({ name: 'Dialect snapshot', scope: [] })
      if (!created.ok) throw new Error('expected key creation')
      const { key, secret } = created.value

      expect((await registry.delete(key.id)).ok).toBe(false)
      expect(await database.gatewayKeys.get(key.id)).not.toBeNull()
      await registry.revoke(key.id)
      expect((await registry.delete(key.id)).ok).toBe(true)
      expect(await database.gatewayKeys.get(key.id)).toBeNull()

      const deletion = (await database.audit.list()).find((event) => event.action === 'gateway_key.deleted')
      expect(deletion?.detail).toEqual({ gatewayKeyId: key.id, name: 'Dialect snapshot' })
      expect(JSON.stringify(deletion)).not.toContain(secret)
      expect(JSON.stringify(deletion)).not.toContain(secret.split('.')[1]!)
    })
  })
}
