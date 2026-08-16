import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from '../../src/persistence/index.ts'
import { GatewayKeyRegistry } from '../../src/keys/index.ts'
import type { Clock } from '../../src/runtime/clock.ts'
import { providerRecord } from '../support/providers.ts'
import { availableEngines } from './engines.ts'

/**
 * Cross-dialect conformance for the Gateway Key registry's scope validation.
 *
 * The Directory and `/v1/models` endpoints depend on every Gateway Key's
 * scope naming real, non-archived Provider IDs. That contract must hold against
 * every supported engine; if SQLite accepts a scope the application would
 * later crash on, the rename would have leaked through the storage layer.
 */
for (const engine of availableEngines) {
  describe(`${engine.name} Gateway Key scope contract`, () => {
    let database: Database
    let clock: Clock
    let registry: GatewayKeyRegistry
    let dispose: () => Promise<void>

    beforeEach(async () => {
      ;({ database, dispose } = await engine.open())
      clock = { now: () => new Date('2026-01-01T00:00:00.000Z') }
      registry = new GatewayKeyRegistry({ database, clock })
    })

    afterEach(async () => {
      await dispose()
    })

    test('accepts a scope entry that names a real Provider', async () => {
      await database.providers.insertProvider(providerRecord('pr_alpha'))

      const created = await registry.create({ name: 'Admitted key', scope: [{ providerId: 'pr_alpha' }] })
      expect(created.ok).toBe(true)
    })

    test('persists unrestricted access without requiring a Provider', async () => {
      const created = await registry.create({ name: 'Future Providers', access: { mode: 'all' } })

      expect(created.ok).toBe(true)
      if (!created.ok) throw new Error('expected unrestricted key creation')
      expect(created.value.key.access).toEqual({ mode: 'all' })
      expect((await database.gatewayKeys.get(created.value.key.id))?.access).toEqual({ mode: 'all' })
    })

    test('atomically compares and increments the edit revision', async () => {
      const created = await registry.create({ name: 'Before', access: { mode: 'all' } })
      if (!created.ok) throw new Error('expected unrestricted key creation')
      const id = created.value.key.id

      const saved = await database.gatewayKeys.updateActive(
        id,
        1,
        { name: 'After', access: { mode: 'selected', providers: [] }, scope: [], corsOrigins: ['https://app.example'] },
        clock.now(),
      )
      expect(saved).toMatchObject({ name: 'After', revision: 2, access: { mode: 'selected', providers: [] } })

      const stale = await database.gatewayKeys.updateActive(
        id,
        1,
        { name: 'Stale', access: { mode: 'all' }, scope: [], corsOrigins: [] },
        clock.now(),
      )
      expect(stale).toBeNull()
      expect(await database.gatewayKeys.get(id)).toMatchObject({ name: 'After', revision: 2 })
    })

    test('rejects a scope entry that names an unknown Provider', async () => {
      const created = await registry.create({
        name: 'Unknown key',
        scope: [{ providerId: 'pr_does_not_exist' }],
      })

      expect(created.ok).toBe(false)
      if (created.ok) throw new Error('expected a validation failure')
      const failure = created.failure
      expect(failure.code).toBe('validation_failed')
      if (failure.code !== 'validation_failed') throw new Error('expected validation_failed')
      expect(failure.problems.every((problem) => problem.field === 'scope')).toBe(true)
    })

    test('rejects a scope entry that names an archived Provider', async () => {
      await database.providers.insertProvider(
        providerRecord('pr_archived', { archivedAt: new Date('2025-12-31T00:00:00.000Z') }),
      )

      const created = await registry.create({
        name: 'Archived key',
        scope: [{ providerId: 'pr_archived' }],
      })

      expect(created.ok).toBe(false)
      if (created.ok) throw new Error('expected a validation failure')
      const failure = created.failure
      expect(failure.code).toBe('validation_failed')
      if (failure.code !== 'validation_failed') throw new Error('expected validation_failed')
      expect(failure.problems.every((problem) => problem.field === 'scope')).toBe(true)
    })

    test('rejects a scope entry that does not name a Provider at all', async () => {
      const created = await registry.create({
        name: 'Garbled key',
        scope: [{ providerId: 42 } as unknown as { providerId: string }],
      })

      expect(created.ok).toBe(false)
      if (created.ok) throw new Error('expected a validation failure')
      const failure = created.failure
      expect(failure.code).toBe('validation_failed')
      if (failure.code !== 'validation_failed') throw new Error('expected validation_failed')
      expect(failure.problems.every((problem) => problem.field === 'scope')).toBe(true)
    })
  })
}
