import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  Database,
  ProviderConnectionRecord,
  SessionRecord,
  UpstreamKeyRecord,
} from '../../src/persistence/index.ts'
import { availableEngines, POSTGRES_URL } from './engines.ts'

/**
 * One suite, run unchanged against every supported engine.
 *
 * If SQLite and PostgreSQL ever disagree here, the repository boundary has
 * leaked and a caller elsewhere in Iroha is about to depend on the difference.
 */
for (const engine of availableEngines) {
  describe(`${engine.name} repository contract`, () => {
    let database: Database
    let dispose: () => Promise<void>

    beforeEach(async () => {
      ;({ database, dispose } = await engine.open())
    })

    afterEach(async () => {
      await dispose()
    })

    test('reports its own dialect', () => {
      expect(database.dialect).toBe(engine.name)
    })

    test('responds to a ping once migrated', async () => {
      await expect(database.ping()).resolves.toBeUndefined()
    })

    test('applies migrations idempotently', async () => {
      await expect(database.migrate()).resolves.toBeUndefined()
      await expect(database.settings.list()).resolves.toEqual([])
    })

    test('returns null for an unknown setting', async () => {
      expect(await database.settings.get('absent')).toBeNull()
    })

    test.each([
      ['an object', { retention: { days: 30 }, enabled: true }],
      ['an array', [1, 'two', false, null]],
      ['a string', 'plain'],
      ['a number', 42],
      ['a boolean', true],
      ['null', null],
    ])('round-trips %s without changing its shape', async (_label, value) => {
      await database.settings.put('shape', value)

      expect((await database.settings.get('shape'))?.value).toEqual(value)
    })

    test('replaces the value of an existing setting', async () => {
      await database.settings.put('retention', { days: 30 })
      await database.settings.put('retention', { days: 7 })

      expect((await database.settings.get('retention'))?.value).toEqual({ days: 7 })
      expect(await database.settings.list()).toHaveLength(1)
    })

    test('stores an updated timestamp as a UTC Date', async () => {
      const before = Date.now()
      const stored = await database.settings.put('stamped', 'value')
      const after = Date.now()

      expect(stored.updatedAt).toBeInstanceOf(Date)

      const read = await database.settings.get('stamped')
      const readAt = read?.updatedAt.getTime() ?? 0

      // A one-second tolerance covers PostgreSQL's microsecond rounding.
      expect(readAt).toBeGreaterThanOrEqual(before - 1000)
      expect(readAt).toBeLessThanOrEqual(after + 1000)
      expect(read?.updatedAt.toISOString()).toEndWith('Z')
    })

    test('lists settings ordered by key', async () => {
      await database.settings.put('zulu', 1)
      await database.settings.put('alpha', 2)
      await database.settings.put('mike', 3)

      expect((await database.settings.list()).map((record) => record.key)).toEqual([
        'alpha',
        'mike',
        'zulu',
      ])
    })

    test('reports whether a removal found anything', async () => {
      await database.settings.put('temporary', 'value')

      expect(await database.settings.remove('temporary')).toBe(true)
      expect(await database.settings.remove('temporary')).toBe(false)
      expect(await database.settings.get('temporary')).toBeNull()
    })

    test('commits a successful transaction', async () => {
      const result = await database.transaction(async (repositories) => {
        await repositories.settings.put('first', 1)
        await repositories.settings.put('second', 2)
        return 'done'
      })

      expect(result).toBe('done')
      expect(await database.settings.list()).toHaveLength(2)
    })

    test('rolls a failed transaction back completely', async () => {
      await database.settings.put('existing', 'original')

      const failure = database.transaction(async (repositories) => {
        await repositories.settings.put('existing', 'overwritten')
        await repositories.settings.put('added', 'value')
        throw new Error('deliberate failure')
      })

      await expect(failure).rejects.toThrow('deliberate failure')

      expect((await database.settings.get('existing'))?.value).toBe('original')
      expect(await database.settings.get('added')).toBeNull()
    })

    test('keeps working after a rolled-back transaction', async () => {
      await database
        .transaction(async () => {
          throw new Error('deliberate failure')
        })
        .catch(() => undefined)

      await database.settings.put('after', 'value')
      expect((await database.settings.get('after'))?.value).toBe('value')
    })

    test('fails a ping once closed', async () => {
      await dispose()
      dispose = async () => undefined

      await expect(database.ping()).rejects.toThrow()
    })

    describe('owner', () => {
      test('reports no Owner on a fresh installation', async () => {
        expect(await database.owner.get()).toBeNull()
      })

      test('creates the sole Owner', async () => {
        const at = new Date('2026-01-01T00:00:00.000Z')
        const created = await database.owner.create({
          username: 'owner',
          passwordHash: 'hash-one',
          at,
        })

        expect(created).toEqual({
          username: 'owner',
          passwordHash: 'hash-one',
          createdAt: at,
          passwordChangedAt: at,
        })
        expect(await database.owner.get()).toEqual(created)
      })

      test('refuses to create a second Owner and leaves the first untouched', async () => {
        await database.owner.create({
          username: 'first',
          passwordHash: 'hash-one',
          at: new Date('2026-01-01T00:00:00.000Z'),
        })

        const second = await database.owner.create({
          username: 'second',
          passwordHash: 'hash-two',
          at: new Date('2026-02-01T00:00:00.000Z'),
        })

        expect(second).toBeNull()
        expect((await database.owner.get())?.username).toBe('first')
      })

      test('changes the password and records when it changed', async () => {
        const created = new Date('2026-01-01T00:00:00.000Z')
        const changed = new Date('2026-03-01T00:00:00.000Z')
        await database.owner.create({ username: 'owner', passwordHash: 'old', at: created })

        const updated = await database.owner.changePassword('new', changed)

        expect(updated?.passwordHash).toBe('new')
        expect(updated?.passwordChangedAt).toEqual(changed)
        expect(updated?.createdAt).toEqual(created)
      })

      test('reports a password change against no Owner', async () => {
        expect(await database.owner.changePassword('new', new Date())).toBeNull()
      })
    })

    describe('sessions', () => {
      const session = (id: string, overrides: Partial<SessionRecord> = {}): SessionRecord => ({
        id,
        secretHash: `${id}-secret-hash`,
        csrfToken: `${id}-csrf`,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2026-01-08T00:00:00.000Z'),
        userAgent: 'Test Browser',
        ...overrides,
      })

      test('round-trips a session', async () => {
        const created = await database.sessions.create(session('one'))

        expect(created).toEqual(session('one'))
        expect(await database.sessions.get('one')).toEqual(session('one'))
      })

      test('returns null for an unknown session', async () => {
        expect(await database.sessions.get('absent')).toBeNull()
      })

      test('accepts a session without a client description', async () => {
        await database.sessions.create(session('one', { userAgent: null }))

        expect((await database.sessions.get('one'))?.userAgent).toBeNull()
      })

      test('lists sessions most recently seen first', async () => {
        await database.sessions.create(
          session('older', { lastSeenAt: new Date('2026-01-02T00:00:00.000Z') }),
        )
        await database.sessions.create(
          session('newer', { lastSeenAt: new Date('2026-01-03T00:00:00.000Z') }),
        )

        expect((await database.sessions.list()).map((record) => record.id)).toEqual([
          'newer',
          'older',
        ])
      })

      test('slides the idle expiry forward', async () => {
        await database.sessions.create(session('one'))
        const seenAt = new Date('2026-01-02T09:00:00.000Z')
        const expiresAt = new Date('2026-01-09T09:00:00.000Z')

        expect(await database.sessions.touch('one', seenAt, expiresAt)).toBe(true)

        const stored = await database.sessions.get('one')
        expect(stored?.lastSeenAt).toEqual(seenAt)
        expect(stored?.expiresAt).toEqual(expiresAt)
      })

      test('reports a touch against a revoked session', async () => {
        expect(await database.sessions.touch('absent', new Date(), new Date())).toBe(false)
      })

      test('reports whether a revocation found a session', async () => {
        await database.sessions.create(session('one'))

        expect(await database.sessions.remove('one')).toBe(true)
        expect(await database.sessions.remove('one')).toBe(false)
        expect(await database.sessions.get('one')).toBeNull()
      })

      test('revokes every session at once', async () => {
        await database.sessions.create(session('one'))
        await database.sessions.create(session('two'))

        expect(await database.sessions.removeAll()).toBe(2)
        expect(await database.sessions.list()).toEqual([])
      })

      test('removes only sessions whose expiry has passed', async () => {
        await database.sessions.create(
          session('expired', { expiresAt: new Date('2026-01-01T00:00:00.000Z') }),
        )
        await database.sessions.create(
          session('live', { expiresAt: new Date('2026-02-01T00:00:00.000Z') }),
        )

        expect(await database.sessions.removeExpired(new Date('2026-01-15T00:00:00.000Z'))).toBe(1)
        expect((await database.sessions.list()).map((record) => record.id)).toEqual(['live'])
      })
    })

    describe('audit', () => {
      test('records an event with structured detail', async () => {
        const at = new Date('2026-01-01T00:00:00.000Z')

        const recorded = await database.audit.record({
          action: 'owner.recovered',
          outcome: 'success',
          detail: { sessionsRevoked: 3 },
          at,
        })

        expect(recorded).toEqual({
          id: expect.any(Number),
          occurredAt: at,
          action: 'owner.recovered',
          outcome: 'success',
          detail: { sessionsRevoked: 3 },
        })
      })

      test('defaults detail to null', async () => {
        await database.audit.record({ action: 'owner.logged_out', outcome: 'success', at: new Date() })

        expect((await database.audit.list())[0]?.detail).toBeNull()
      })

      test('lists events most recent first and honours a limit', async () => {
        for (const [index, action] of ['first', 'second', 'third'].entries()) {
          await database.audit.record({
            action,
            outcome: 'success',
            at: new Date(Date.UTC(2026, 0, index + 1)),
          })
        }

        expect((await database.audit.list()).map((event) => event.action)).toEqual([
          'third',
          'second',
          'first',
        ])
        expect((await database.audit.list({ limit: 2 })).map((event) => event.action)).toEqual([
          'third',
          'second',
        ])
      })

      test('keeps events written inside a rolled-back transaction out of history', async () => {
        await database
          .transaction(async (repositories) => {
            await repositories.audit.record({
              action: 'owner.recovered',
              outcome: 'success',
              at: new Date(),
            })
            throw new Error('deliberate failure')
          })
          .catch(() => undefined)

        expect(await database.audit.list()).toEqual([])
      })
    })

    describe('providers', () => {
      const at = new Date('2026-01-01T00:00:00.000Z')

      const connection = (
        id: string,
        overrides: Partial<ProviderConnectionRecord> = {},
      ): ProviderConnectionRecord => ({
        id,
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        allowInsecureHttp: false,
        enabled: true,
        archivedAt: null,
        templateId: null,
        capabilities: {
          chat: false,
          streaming: false,
          tools: false,
          structuredOutput: false,
          responses: false,
        },
        createdAt: at,
        updatedAt: at,
        ...overrides,
      })

      const key = (
        id: string,
        connectionId: string,
        overrides: Partial<UpstreamKeyRecord> = {},
      ): UpstreamKeyRecord => ({
        id,
        connectionId,
        encryptedKey: `v1.stored.${id}`,
        health: 'unverified',
        lastProbeAt: null,
        lastProbeVerdict: null,
        lastProbeReason: null,
        createdAt: at,
        updatedAt: at,
        ...overrides,
      })

      test('round-trips a connection', async () => {
        const created = await database.providers.insertConnection(connection('pc_one'))

        expect(created).toEqual(connection('pc_one'))
        expect(await database.providers.getConnection('pc_one')).toEqual(connection('pc_one'))
      })

      test('preserves booleans and a null archive', async () => {
        await database.providers.insertConnection(connection('pc_flags'))

        const stored = await database.providers.getConnection('pc_flags')
        expect(stored?.allowInsecureHttp).toBe(false)
        expect(stored?.enabled).toBe(true)
        expect(stored?.archivedAt).toBeNull()
      })

      test('returns null for an unknown connection', async () => {
        expect(await database.providers.getConnection('pc_absent')).toBeNull()
      })

      test('lists connections most recently created first', async () => {
        await database.providers.insertConnection(
          connection('pc_older', { createdAt: new Date('2026-01-01T00:00:00.000Z') }),
        )
        await database.providers.insertConnection(
          connection('pc_newer', { createdAt: new Date('2026-01-02T00:00:00.000Z') }),
        )

        expect(
          (await database.providers.listConnections()).map((record) => record.id),
        ).toEqual(['pc_newer', 'pc_older'])
      })

      test('patches only the supplied connection fields and moves updatedAt', async () => {
        await database.providers.insertConnection(connection('pc_one'))
        const later = new Date('2026-02-01T00:00:00.000Z')

        const updated = await database.providers.updateConnection(
          'pc_one',
          { displayName: 'Renamed', enabled: false },
          later,
        )

        expect(updated).toEqual(
          connection('pc_one', { displayName: 'Renamed', enabled: false, updatedAt: later }),
        )
      })

      test('records an archive and clears it', async () => {
        await database.providers.insertConnection(connection('pc_one'))
        const archivedAt = new Date('2026-02-01T00:00:00.000Z')

        await database.providers.updateConnection('pc_one', { archivedAt }, archivedAt)
        expect((await database.providers.getConnection('pc_one'))?.archivedAt).toEqual(archivedAt)

        await database.providers.updateConnection('pc_one', { archivedAt: null }, archivedAt)
        expect((await database.providers.getConnection('pc_one'))?.archivedAt).toBeNull()
      })

      test('reports an update or removal against an unknown connection', async () => {
        expect(await database.providers.updateConnection('pc_absent', { enabled: false }, at)).toBeNull()
        expect(await database.providers.deleteConnection('pc_absent')).toBe(false)
      })

      test('round-trips an Upstream Key', async () => {
        await database.providers.insertConnection(connection('pc_one'))
        const created = await database.providers.insertKey(key('uk_one', 'pc_one'))

        expect(created).toEqual(key('uk_one', 'pc_one'))
        expect(await database.providers.getKey('uk_one')).toEqual(key('uk_one', 'pc_one'))
      })

      test('lists only the keys of one connection, oldest first', async () => {
        await database.providers.insertConnection(connection('pc_one'))
        await database.providers.insertConnection(connection('pc_two'))

        await database.providers.insertKey(
          key('uk_newer', 'pc_one', { createdAt: new Date('2026-01-02T00:00:00.000Z') }),
        )
        await database.providers.insertKey(key('uk_other', 'pc_two'))
        await database.providers.insertKey(
          key('uk_older', 'pc_one', { createdAt: new Date('2026-01-01T00:00:00.000Z') }),
        )

        expect((await database.providers.listKeys('pc_one')).map((record) => record.id)).toEqual([
          'uk_older',
          'uk_newer',
        ])
      })

      test('patches key health without touching the stored secret', async () => {
        await database.providers.insertConnection(connection('pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one'))
        const later = new Date('2026-02-01T00:00:00.000Z')

        const updated = await database.providers.updateKey(
          'uk_one',
          {
            health: 'active',
            lastProbeAt: later,
            lastProbeVerdict: 'usable',
            lastProbeReason: null,
          },
          later,
        )

        expect(updated?.health).toBe('active')
        expect(updated?.lastProbeAt).toEqual(later)
        expect(updated?.lastProbeVerdict).toBe('usable')
        expect(updated?.encryptedKey).toBe('v1.stored.uk_one')
      })

      test('reports an unknown key', async () => {
        expect(await database.providers.getKey('uk_absent')).toBeNull()
        expect(await database.providers.updateKey('uk_absent', { health: 'active' }, at)).toBeNull()
      })

      test('removes every key of a connection', async () => {
        await database.providers.insertConnection(connection('pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one'))
        await database.providers.insertKey(key('uk_two', 'pc_one'))

        expect(await database.providers.deleteKeysForConnection('pc_one')).toBe(2)
        expect(await database.providers.listKeys('pc_one')).toEqual([])
      })

      test('takes a connection and its keys with it, inside a transaction', async () => {
        await database.providers.insertConnection(connection('pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one'))

        const removed = await database.transaction(async (repositories) => {
          const keys = await repositories.providers.deleteKeysForConnection('pc_one')
          const gone = await repositories.providers.deleteConnection('pc_one')
          return { keys, gone }
        })

        expect(removed).toEqual({ keys: 1, gone: true })
        expect(await database.providers.listConnections()).toEqual([])
        expect(await database.providers.listKeys('pc_one')).toEqual([])
      })
    })

    describe('model catalog', () => {
      const at = new Date('2026-01-01T00:00:00.000Z')
      const later = new Date('2026-01-02T00:00:00.000Z')

      const connection = (
        id: string,
        overrides: Partial<ProviderConnectionRecord> = {},
      ): ProviderConnectionRecord => ({
        id,
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        allowInsecureHttp: false,
        enabled: true,
        archivedAt: null,
        templateId: null,
        capabilities: {
          chat: false,
          streaming: false,
          tools: false,
          structuredOutput: false,
          responses: false,
        },
        createdAt: at,
        updatedAt: at,
        ...overrides,
      })

      test('merges discovery, prunes only stale discovered rows, and keeps Owner intent', async () => {
        await database.providers.insertConnection(connection('pc_catalog'))

        await database.modelCatalog.syncDiscovered('pc_catalog', ['gpt-4o-mini', 'gpt-4o'], at)
        await database.modelCatalog.addOwnerModel('pc_catalog', 'custom-model', at)
        await database.modelCatalog.setExcluded('pc_catalog', 'o1-preview', true, at)

        const afterDiscovery = (await database.modelCatalog.listEntries('pc_catalog')).map(
          (entry) => `${entry.modelId}:${entry.source}:${entry.excluded}`,
        )
        expect(afterDiscovery.sort()).toEqual([
          'custom-model:owner_added:false',
          'gpt-4o-mini:discovered:false',
          'gpt-4o:discovered:false',
          'o1-preview:excluded:true',
        ])

        // A later discovery omits gpt-4o but re-reports gpt-4o-mini: only the
        // stale discovered row goes; Owner additions and exclusions survive.
        await database.modelCatalog.syncDiscovered('pc_catalog', ['gpt-4o-mini'], later)

        const afterResync = (await database.modelCatalog.listEntries('pc_catalog')).map(
          (entry) => `${entry.modelId}:${entry.source}:${entry.excluded}`,
        )
        expect(afterResync.sort()).toEqual([
          'custom-model:owner_added:false',
          'gpt-4o-mini:discovered:false',
          'o1-preview:excluded:true',
        ])
      })

      test('scopes every entry operation to its own connection', async () => {
        await database.providers.insertConnection(connection('pc_one'))
        await database.providers.insertConnection(connection('pc_two'))

        await database.modelCatalog.syncDiscovered('pc_one', ['gpt-4o-mini'], at)
        await database.modelCatalog.syncDiscovered('pc_two', ['claude-3.5'], at)

        // An edit aimed at one connection must not touch the other's rows.
        expect(await database.modelCatalog.removeOwnerModel('pc_two', 'gpt-4o-mini')).toBe(false)
        expect(await database.modelCatalog.isExcluded('pc_two', 'gpt-4o-mini')).toBe(false)
        await database.modelCatalog.setExcluded('pc_one', 'gpt-4o-mini', true, later)
        expect(await database.modelCatalog.isExcluded('pc_two', 'gpt-4o-mini')).toBe(false)
        expect(await database.modelCatalog.isExcluded('pc_one', 'gpt-4o-mini')).toBe(true)
      })

      test('tracks overrides per model without leaking across connections', async () => {
        await database.providers.insertConnection(connection('pc_one'))
        await database.providers.insertConnection(connection('pc_two'))

        await database.modelCatalog.updateOverrides(
          'pc_one',
          'gpt-4o-mini',
          { streaming: true },
          at,
        )
        await database.modelCatalog.updateOverrides(
          'pc_two',
          'gpt-4o-mini',
          { streaming: false },
          at,
        )

        const one = await database.modelCatalog.listEntries('pc_one')
        const two = await database.modelCatalog.listEntries('pc_two')
        expect(one.find((entry) => entry.modelId === 'gpt-4o-mini')?.overrides).toEqual({
          streaming: true,
        })
        expect(two.find((entry) => entry.modelId === 'gpt-4o-mini')?.overrides).toEqual({
          streaming: false,
        })
      })
    })
  })
}

describe.skipIf(Boolean(POSTGRES_URL))('postgres repository contract', () => {
  test.skip('requires IROHA_TEST_POSTGRES_URL to run', () => {})
})
