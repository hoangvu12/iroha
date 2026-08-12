import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Database, SessionRecord } from '../../src/persistence/index.ts'
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
  })
}

describe.skipIf(Boolean(POSTGRES_URL))('postgres repository contract', () => {
  test.skip('requires IROHA_TEST_POSTGRES_URL to run', () => {})
})
