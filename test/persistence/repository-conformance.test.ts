import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type {
  Database,
  ProviderRecord,
  SessionRecord,
  UpstreamAccountRecord,
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
        overrides: Partial<ProviderRecord> = {},
      ): ProviderRecord => ({
        id,
        handle: id,
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        allowInsecureHttp: false,
        enabled: true,
        retryMaxAttempts: 3,
        retryAmbiguousNetwork: false,
        archivedAt: null,
        templateId: null,
        capabilities: {
          chat: false,
          streaming: false,
          tools: false,
          structuredOutput: false,
          responses: false,
        },
        authHeader: 'authorization',
        authPrefix: 'Bearer ',
        staticHeadersEncrypted: '[]',
        redirectAllowSameOrigin: false,
        connectionTimeoutMs: 10_000,
        firstByteTimeoutMs: 20_000,
        nonStreamingTotalTimeoutMs: 120_000,
        streamingIdleTimeoutMs: 30_000,
        totalRetryTimeoutMs: 30_000,
        idempotencyHeader: 'Idempotency-Key',
        createdAt: at,
        updatedAt: at,
        ...overrides,
      })

      const key = (
        id: string,
        providerId: string,
        overrides: Partial<UpstreamKeyRecord> = {},
      ): UpstreamKeyRecord => ({
        id,
        providerId,
        baseUrl: null,
        accountId: null,
        encryptedKey: `v1.stored.${id}`,
        health: 'unverified',
        lastProbeAt: null,
        lastProbeVerdict: null,
        lastProbeReason: null,
        healthReason: null,
        healthChangedAt: at,
        retryAfterAt: null,
        healthScope: 'key',
        healthScopeId: null,
        healthModel: null,
        allowedModels: null,
        deniedModels: null,
        createdAt: at,
        updatedAt: at,
        ...overrides,
      })

      const account = (
        id: string,
        providerId: string,
        overrides: Partial<UpstreamAccountRecord> = {},
      ): UpstreamAccountRecord => ({
        id,
        providerId,
        displayName: 'Shared account',
        createdAt: at,
        updatedAt: at,
        ...overrides,
      })

      test('round-trips a connection', async () => {
        const created = await database.providers.insertProvider(connection('pc_one'))

        expect(created).toEqual(connection('pc_one'))
        expect(await database.providers.getProvider('pc_one')).toEqual(connection('pc_one'))
      })

      test('enforces globally unique immutable Provider Handles', async () => {
        await database.providers.insertProvider(connection('pc_one', { handle: 'shared' }))
        expect(database.providers.insertProvider(connection('pc_two', { handle: 'shared' }))).rejects.toThrow()

        expect(database.providers.updateProvider(
          'pc_one',
          { handle: 'different' } as never,
          new Date('2026-02-01T00:00:00.000Z'),
        )).rejects.toThrow()
      })

      test('preserves booleans and a null archive', async () => {
        await database.providers.insertProvider(connection('pc_flags'))

        const stored = await database.providers.getProvider('pc_flags')
        expect(stored?.allowInsecureHttp).toBe(false)
        expect(stored?.enabled).toBe(true)
        expect(stored?.archivedAt).toBeNull()
      })

      test('returns null for an unknown connection', async () => {
        expect(await database.providers.getProvider('pc_absent')).toBeNull()
      })

      test('lists connections most recently created first', async () => {
        await database.providers.insertProvider(
          connection('pc_older', { createdAt: new Date('2026-01-01T00:00:00.000Z') }),
        )
        await database.providers.insertProvider(
          connection('pc_newer', { createdAt: new Date('2026-01-02T00:00:00.000Z') }),
        )

        expect(
          (await database.providers.listProviders()).map((record) => record.id),
        ).toEqual(['pc_newer', 'pc_older'])
      })

      test('patches only the supplied connection fields and moves updatedAt', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        const later = new Date('2026-02-01T00:00:00.000Z')

        const updated = await database.providers.updateProvider(
          'pc_one',
          { displayName: 'Renamed', enabled: false },
          later,
        )

        expect(updated).toEqual(
          connection('pc_one', { displayName: 'Renamed', enabled: false, updatedAt: later }),
        )
      })

      test('records an archive and clears it', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        const archivedAt = new Date('2026-02-01T00:00:00.000Z')

        await database.providers.updateProvider('pc_one', { archivedAt }, archivedAt)
        expect((await database.providers.getProvider('pc_one'))?.archivedAt).toEqual(archivedAt)

        await database.providers.updateProvider('pc_one', { archivedAt: null }, archivedAt)
        expect((await database.providers.getProvider('pc_one'))?.archivedAt).toBeNull()
      })

      test('reports an update or removal against an unknown connection', async () => {
        expect(await database.providers.updateProvider('pc_absent', { enabled: false }, at)).toBeNull()
        expect(await database.providers.deleteProvider('pc_absent')).toBe(false)
      })

      test('round-trips an Upstream Key', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        const created = await database.providers.insertKey(key('uk_one', 'pc_one'))

        expect(created).toEqual(key('uk_one', 'pc_one'))
        expect(await database.providers.getKey('uk_one')).toEqual(key('uk_one', 'pc_one'))
      })

      test('round-trips a Key with a per-Key base URL override', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        const overrideUrl = 'https://override.example.com/v1'
        const created = await database.providers.insertKey(
          key('uk_override', 'pc_one', { baseUrl: overrideUrl }),
        )

        expect(created.baseUrl).toBe(overrideUrl)
        expect((await database.providers.getKey('uk_override'))?.baseUrl).toBe(overrideUrl)
      })

      test('patches a Key base URL override and clears it', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one'))
        const later = new Date('2026-02-01T00:00:00.000Z')

        const updated = await database.providers.updateKey(
          'uk_one',
          { baseUrl: 'https://override.example.com/v1' },
          later,
        )
        expect(updated?.baseUrl).toBe('https://override.example.com/v1')
        expect(updated?.updatedAt).toEqual(later)

        const cleared = await database.providers.updateKey(
          'uk_one',
          { baseUrl: null },
          later,
        )
        expect(cleared?.baseUrl).toBeNull()
      })

      test('resolves the Provider default base URL when a Key has no override', async () => {
        const provider = connection('pc_default', { baseUrl: 'https://provider.example.com/v1' })
        await database.providers.insertProvider(provider)
        await database.providers.insertKey(key('uk_default', 'pc_default'))

        expect(await database.providers.providerDefaultBaseUrl('pc_default', 'uk_default')).toBe(
          'https://provider.example.com/v1',
        )
      })

      test('returns the Key override when one is set', async () => {
        const provider = connection('pc_override', { baseUrl: 'https://provider.example.com/v1' })
        await database.providers.insertProvider(provider)
        await database.providers.insertKey(
          key('uk_override', 'pc_override', { baseUrl: 'https://key.example.com/v1' }),
        )

        expect(await database.providers.providerDefaultBaseUrl('pc_override', 'uk_override')).toBe(
          'https://key.example.com/v1',
        )
      })

      test('returns null when the Key does not belong to the Provider', async () => {
        await database.providers.insertProvider(connection('pc_a'))
        await database.providers.insertProvider(connection('pc_b'))
        await database.providers.insertKey(key('uk_a', 'pc_a'))

        expect(await database.providers.providerDefaultBaseUrl('pc_b', 'uk_a')).toBeNull()
      })

      test('returns null for an unknown Key or Provider', async () => {
        await database.providers.insertProvider(connection('pc_one'))

        expect(await database.providers.providerDefaultBaseUrl('pc_one', 'uk_absent')).toBeNull()
        expect(await database.providers.providerDefaultBaseUrl('pc_absent', 'uk_anything')).toBeNull()
      })

      test('lists only the keys of one connection, oldest first', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertProvider(connection('pc_two'))

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
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one'))
        const later = new Date('2026-02-01T00:00:00.000Z')

        const updated = await database.providers.updateKey(
          'uk_one',
          {
            health: 'active',
            lastProbeAt: later,
            lastProbeVerdict: 'authenticated',
            lastProbeReason: null,
          },
          later,
        )

        expect(updated?.health).toBe('active')
        expect(updated?.lastProbeAt).toEqual(later)
        expect(updated?.lastProbeVerdict).toBe('authenticated')
        expect(updated?.encryptedKey).toBe('v1.stored.uk_one')
      })

      test('reports an unknown key', async () => {
        expect(await database.providers.getKey('uk_absent')).toBeNull()
        expect(await database.providers.updateKey('uk_absent', { health: 'active' }, at)).toBeNull()
      })

      test('round-trips key model lists and an account assignment', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertAccount(account('ua_one', 'pc_one'))

        const created = await database.providers.insertKey(
          key('uk_one', 'pc_one', {
            accountId: 'ua_one',
            allowedModels: ['gpt-4o', 'gpt-4o-mini'],
            deniedModels: ['o1-preview'],
          }),
        )

        expect(created).toEqual(
          key('uk_one', 'pc_one', {
            accountId: 'ua_one',
            allowedModels: ['gpt-4o', 'gpt-4o-mini'],
            deniedModels: ['o1-preview'],
          }),
        )
        expect(await database.providers.getKey('uk_one')).toEqual(created)
      })

      test('patches the account and the per-key model lists', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertAccount(account('ua_one', 'pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one'))
        const later = new Date('2026-02-01T00:00:00.000Z')

        const updated = await database.providers.updateKey(
          'uk_one',
          {
            accountId: 'ua_one',
            allowedModels: ['gpt-4o'],
            deniedModels: null,
          },
          later,
        )

        expect(updated?.accountId).toBe('ua_one')
        expect(updated?.allowedModels).toEqual(['gpt-4o'])
        expect(updated?.deniedModels).toBeNull()
        expect(updated?.updatedAt).toEqual(later)
        expect(updated?.encryptedKey).toBe('v1.stored.uk_one')
      })

      test('removes a single key', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one'))
        await database.providers.insertKey(key('uk_two', 'pc_one'))

        expect(await database.providers.deleteKey('uk_one')).toBe(true)
        expect(await database.providers.deleteKey('uk_one')).toBe(false)
        expect((await database.providers.listKeys('pc_one')).map((record) => record.id)).toEqual([
          'uk_two',
        ])
      })

      test('round-trips an Upstream Account', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        const created = await database.providers.insertAccount(account('ua_one', 'pc_one'))

        expect(created).toEqual(account('ua_one', 'pc_one'))
        expect(await database.providers.getAccount('ua_one')).toEqual(account('ua_one', 'pc_one'))
      })

      test('lists only the accounts of one connection, oldest first', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertProvider(connection('pc_two'))

        await database.providers.insertAccount(account('ua_other', 'pc_two'))
        await database.providers.insertAccount(
          account('ua_newer', 'pc_one', { createdAt: new Date('2026-01-02T00:00:00.000Z') }),
        )
        await database.providers.insertAccount(account('ua_older', 'pc_one'))

        expect((await database.providers.listAccounts('pc_one')).map((record) => record.id)).toEqual([
          'ua_older',
          'ua_newer',
        ])
      })

      test('renames an account and moves updatedAt', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertAccount(account('ua_one', 'pc_one'))
        const later = new Date('2026-02-01T00:00:00.000Z')

        const updated = await database.providers.updateAccount('ua_one', { displayName: 'Renamed' }, later)

        expect(updated?.displayName).toBe('Renamed')
        expect(updated?.updatedAt).toEqual(later)
        expect(updated?.id).toBe('ua_one')
      })

      test('deleting an account leaves its keys independent', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertAccount(account('ua_one', 'pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one', { accountId: 'ua_one' }))

        expect(await database.providers.deleteAccount('ua_one')).toBe(true)
        expect(await database.providers.getAccount('ua_one')).toBeNull()

        const stored = await database.providers.getKey('uk_one')
        expect(stored?.accountId).toBeNull()
        expect(stored?.encryptedKey).toBe('v1.stored.uk_one')
      })

      test('reports an update or removal against an unknown account', async () => {
        expect(await database.providers.getAccount('ua_absent')).toBeNull()
        expect(await database.providers.updateAccount('ua_absent', { displayName: 'Nope' }, at)).toBeNull()
        expect(await database.providers.deleteAccount('ua_absent')).toBe(false)
      })

      test('takes an account with its connection in a purge, inside a transaction', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertAccount(account('ua_one', 'pc_one'))

        const removed = await database.transaction(async (repositories) => {
          await repositories.providers.deleteKeysForProvider('pc_one')
          return await repositories.providers.deleteProvider('pc_one')
        })

        expect(removed).toBe(true)
        expect(await database.providers.getAccount('ua_one')).toBeNull()
      })

      test('removes every key of a connection', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one'))
        await database.providers.insertKey(key('uk_two', 'pc_one'))

        expect(await database.providers.deleteKeysForProvider('pc_one')).toBe(2)
        expect(await database.providers.listKeys('pc_one')).toEqual([])
      })

      test('takes a connection and its keys with it, inside a transaction', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertKey(key('uk_one', 'pc_one'))

        const removed = await database.transaction(async (repositories) => {
          const keys = await repositories.providers.deleteKeysForProvider('pc_one')
          const gone = await repositories.providers.deleteProvider('pc_one')
          return { keys, gone }
        })

        expect(removed).toEqual({ keys: 1, gone: true })
        expect(await database.providers.listProviders()).toEqual([])
        expect(await database.providers.listKeys('pc_one')).toEqual([])
      })
    })

    describe('model catalog', () => {
      const at = new Date('2026-01-01T00:00:00.000Z')
      const later = new Date('2026-01-02T00:00:00.000Z')

      const connection = (
        id: string,
        overrides: Partial<ProviderRecord> = {},
      ): ProviderRecord => ({
        id,
        handle: id,
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        allowInsecureHttp: false,
        enabled: true,
        retryMaxAttempts: 3,
        retryAmbiguousNetwork: false,
        archivedAt: null,
        templateId: null,
        capabilities: {
          chat: false,
          streaming: false,
          tools: false,
          structuredOutput: false,
          responses: false,
        },
        authHeader: 'authorization',
        authPrefix: 'Bearer ',
        staticHeadersEncrypted: '[]',
        redirectAllowSameOrigin: false,
        connectionTimeoutMs: 10_000,
        firstByteTimeoutMs: 20_000,
        nonStreamingTotalTimeoutMs: 120_000,
        streamingIdleTimeoutMs: 30_000,
        totalRetryTimeoutMs: 30_000,
        idempotencyHeader: 'Idempotency-Key',
        createdAt: at,
        updatedAt: at,
        ...overrides,
      })

      test('merges discovery, prunes only stale discovered rows, and keeps Owner intent', async () => {
        await database.providers.insertProvider(connection('pc_catalog'))

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
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertProvider(connection('pc_two'))

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
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertProvider(connection('pc_two'))

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

    describe('usage snapshots', () => {
      const at = new Date('2026-01-01T00:00:00.000Z')
      const later = new Date('2026-01-02T00:00:00.000Z')

      const connection = (
        id: string,
        overrides: Partial<ProviderRecord> = {},
      ): ProviderRecord => ({
        id,
        handle: id,
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        allowInsecureHttp: false,
        enabled: true,
        retryMaxAttempts: 3,
        retryAmbiguousNetwork: false,
        archivedAt: null,
        templateId: null,
        capabilities: {
          chat: false,
          streaming: false,
          tools: false,
          structuredOutput: false,
          responses: false,
        },
        authHeader: 'authorization',
        authPrefix: 'Bearer ',
        staticHeadersEncrypted: '[]',
        redirectAllowSameOrigin: false,
        connectionTimeoutMs: 10_000,
        firstByteTimeoutMs: 20_000,
        nonStreamingTotalTimeoutMs: 120_000,
        streamingIdleTimeoutMs: 30_000,
        totalRetryTimeoutMs: 30_000,
        idempotencyHeader: 'Idempotency-Key',
        createdAt: at,
        updatedAt: at,
        ...overrides,
      })

      const snapshot = (
        providerId: string,
        overrides: {
          visibility?: 'reactive_only' | 'authoritative'
          syncedAt?: Date | null
          lastSuccessAt?: Date | null
          lastFailureAt?: Date | null
          lastFailureCode?: string | null
          lastFailureMessage?: string | null
          result?: unknown
        } = {},
      ) => ({
        providerId,
        visibility: 'reactive_only' as const,
        syncedAt: null,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastFailureCode: null,
        lastFailureMessage: null,
        result: null,
        ...overrides,
      })

      test('round-trips a snapshot for one connection', async () => {
        await database.providers.insertProvider(connection('pc_usage'))
        const stored = snapshot('pc_usage', {
          visibility: 'authoritative',
          syncedAt: at,
          lastSuccessAt: at,
          result: {
            unit: 'usd',
            balance: 42,
            used: 8,
            limit: 50,
            resetAt: null,
            scope: { kind: 'provider' },
            confidence: 'confirmed',
            diagnostics: { provider: 'mock' },
          },
        })
        await database.usage.put(stored)

        const read = await database.usage.get('pc_usage')
        expect(read).toEqual(stored)
      })

      test('returns null for an unknown connection', async () => {
        expect(await database.usage.get('pc_absent')).toBeNull()
      })

      test('replaces the snapshot of an existing connection', async () => {
        await database.providers.insertProvider(connection('pc_usage'))
        await database.usage.put(snapshot('pc_usage', { visibility: 'reactive_only' }))
        await database.usage.put(
          snapshot('pc_usage', {
            visibility: 'authoritative',
            syncedAt: later,
            lastSuccessAt: later,
            lastFailureCode: 'upstream_refused',
            lastFailureMessage: 'HTTP 503',
            result: { unit: 'usd', balance: 5 },
          }),
        )

        const read = await database.usage.get('pc_usage')
        expect(read).toMatchObject({
          visibility: 'authoritative',
          syncedAt: later,
          lastSuccessAt: later,
          lastFailureCode: 'upstream_refused',
          lastFailureMessage: 'HTTP 503',
        })
      })

      test('retains the prior success when a later record carries only failure data', async () => {
        await database.providers.insertProvider(connection('pc_usage'))
        await database.usage.put(
          snapshot('pc_usage', {
            visibility: 'authoritative',
            syncedAt: at,
            lastSuccessAt: at,
            result: { balance: 12, unit: 'usd' },
          }),
        )
        // The Usage Service writes a fresh record that carries the previous
        // success fields forward alongside the new failure fields; the
        // repository faithfully stores whatever it receives.
        await database.usage.put({
          providerId: 'pc_usage',
          visibility: 'authoritative',
          syncedAt: later,
          lastSuccessAt: at,
          lastFailureAt: later,
          lastFailureCode: 'upstream_unreachable',
          lastFailureMessage: 'the provider timed out',
          result: { balance: 12, unit: 'usd' },
        })

        const read = await database.usage.get('pc_usage')
        expect(read?.lastSuccessAt).toEqual(at)
        expect(read?.lastFailureAt).toEqual(later)
        expect(read?.lastFailureCode).toBe('upstream_unreachable')
        expect(read?.result).toEqual({ balance: 12, unit: 'usd' })
      })

      test('takes the snapshot with its connection when the connection is purged', async () => {
        await database.providers.insertProvider(connection('pc_usage'))
        await database.usage.put(
          snapshot('pc_usage', { visibility: 'authoritative', lastSuccessAt: at }),
        )

        await database.transaction(async (repositories) => {
          await repositories.providers.deleteKeysForProvider('pc_usage')
          await repositories.providers.deleteProvider('pc_usage')
        })

        expect(await database.usage.get('pc_usage')).toBeNull()
      })

      test('scopes each snapshot to its own connection', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertProvider(connection('pc_two'))

        await database.usage.put(snapshot('pc_one', { visibility: 'authoritative' }))
        await database.usage.put(snapshot('pc_two', { visibility: 'reactive_only' }))

        const one = await database.usage.get('pc_one')
        const two = await database.usage.get('pc_two')
        expect(one?.visibility).toBe('authoritative')
        expect(two?.visibility).toBe('reactive_only')
      })
    })

    describe('request history', () => {
      const at = new Date('2026-01-01T00:00:00.000Z')
      const later = new Date('2026-01-02T00:00:00.000Z')

      const connection = (
        id: string,
        overrides: Partial<ProviderRecord> = {},
      ): ProviderRecord => ({
        id,
        handle: id,
        displayName: 'Example',
        baseUrl: 'https://api.example.com/v1',
        allowInsecureHttp: false,
        enabled: true,
        retryMaxAttempts: 3,
        retryAmbiguousNetwork: false,
        archivedAt: null,
        templateId: null,
        capabilities: {
          chat: false,
          streaming: false,
          tools: false,
          structuredOutput: false,
          responses: false,
        },
        authHeader: 'authorization',
        authPrefix: 'Bearer ',
        staticHeadersEncrypted: '[]',
        redirectAllowSameOrigin: false,
        connectionTimeoutMs: 10_000,
        firstByteTimeoutMs: 20_000,
        nonStreamingTotalTimeoutMs: 120_000,
        streamingIdleTimeoutMs: 30_000,
        totalRetryTimeoutMs: 30_000,
        idempotencyHeader: 'Idempotency-Key',
        createdAt: at,
        updatedAt: at,
        ...overrides,
      })

      const event = (
        id: string,
        providerId: string,
        overrides: Partial<{
          occurredAt: Date
          lifecycle: 'in_progress' | 'completed' | 'abandoned'
          model: string
          gatewayKeyId: string | null
          keyId: string | null
          status: number
          outcome: 'success' | 'failure'
          latencyMs: number
          isStreaming: boolean
          promptTokens: number | null
          completionTokens: number | null
          totalTokens: number | null
          errorCode: string | null
        }> = {},
      ) => ({
        id,
        lifecycle: 'completed' as const,
        occurredAt: at,
        providerId,
        model: 'gpt-4o-mini',
        gatewayKeyId: 'gw_one',
        keyId: 'uk_one',
        status: 200,
        outcome: 'success' as const,
        latencyMs: 250,
        isStreaming: false,
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
        errorCode: null,
        ...overrides,
      })

      test('round-trips an event with every column preserved', async () => {
        await database.providers.insertProvider(connection('pc_rh'))
        await database.requestHistory.recordEvent(
          event('req_one', 'pc_rh', {
            gatewayKeyId: null,
            keyId: null,
            status: 503,
            outcome: 'failure',
            latencyMs: 1234,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            errorCode: 'upstream_credentials_unavailable',
          }),
        )

        const stored = await database.requestHistory.getEvent('req_one')
        expect(stored).toEqual(
          event('req_one', 'pc_rh', {
            gatewayKeyId: null,
            keyId: null,
            status: 503,
            outcome: 'failure',
            latencyMs: 1234,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            errorCode: 'upstream_credentials_unavailable',
          }),
        )
      })

      test('overwrites an event with the same id so streaming can update usage', async () => {
        await database.providers.insertProvider(connection('pc_rh'))
        await database.requestHistory.recordEvent(
          event('req_one', 'pc_rh', { totalTokens: 0, isStreaming: true }),
        )
        await database.requestHistory.recordEvent(
          event('req_one', 'pc_rh', { totalTokens: 17, isStreaming: true }),
        )

        const stored = await database.requestHistory.getEvent('req_one')
        expect(stored?.totalTokens).toBe(17)
      })

      test('overwrites every field between the startAttempt default write and the finalize write', async () => {
        // Mirrors the inference code path: startAttempt lazily writes the
        // event row with the schema defaults (status=0, outcome='failure',
        // latencyMs=0, keyId=null) so the FK to providers can fail safely if
        // the connection vanishes mid-call, then finalize overwrites every
        // field with the real values. Every field must update — a partial
        // update is the bug that previously made the requests page show a
        // red dot on a 200-status call.
        await database.providers.insertProvider(connection('pc_rh'))
        await database.requestHistory.recordEvent(
          event('req_one', 'pc_rh', {
            lifecycle: 'in_progress',
            status: 0,
            outcome: 'failure',
            latencyMs: 0,
            keyId: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            errorCode: null,
          }),
        )
        await database.requestHistory.recordEvent(
          event('req_one', 'pc_rh', {
            status: 200,
            outcome: 'success',
            latencyMs: 1234,
            keyId: 'uk_one',
            promptTokens: 40,
            completionTokens: 57,
            totalTokens: 97,
            errorCode: null,
          }),
        )

        const stored = await database.requestHistory.getEvent('req_one')
        expect(stored).toEqual(
          event('req_one', 'pc_rh', {
            status: 200,
            outcome: 'success',
            latencyMs: 1234,
            keyId: 'uk_one',
            promptTokens: 40,
            completionTokens: 57,
            totalTokens: 97,
            errorCode: null,
          }),
        )
      })

      test('records attempts and patches the outcome', async () => {
        await database.providers.insertProvider(connection('pc_rh'))
        await database.requestHistory.recordEvent(event('req_one', 'pc_rh'))

        const started = await database.requestHistory.recordAttempt({
          requestId: 'req_one',
          attemptNumber: 1,
          keyId: 'uk_one',
          startedAt: at,
          completedAt: null,
          status: null,
          outcome: 'failure',
          errorCode: null,
          retryAfterSeconds: null,
          diagnostics: {
            status: 429,
            providerCode: 'quota_window',
            classification: 'capacity_limited',
            capacityScope: 'key',
            remainingPercent: 0,
            message: 'must not persist',
          },
        })

        await database.requestHistory.recordAttempt({
          requestId: 'req_one',
          attemptNumber: 2,
          keyId: 'uk_two',
          startedAt: later,
          completedAt: later,
          status: 200,
          outcome: 'success',
          errorCode: null,
          retryAfterSeconds: null,
        })

        await database.requestHistory.updateAttempt(started.id, {
          completedAt: at,
          status: 401,
          outcome: 'failure',
          errorCode: 'upstream_invalid_credentials',
          retryAfterSeconds: 30,
        })

        const attempts = await database.requestHistory.getAttempts('req_one')
        expect(attempts.map((a) => ({ number: a.attemptNumber, key: a.keyId, outcome: a.outcome, status: a.status, error: a.errorCode }))).toEqual([
          { number: 1, key: 'uk_one', outcome: 'failure', status: 401, error: 'upstream_invalid_credentials' },
          { number: 2, key: 'uk_two', outcome: 'success', status: 200, error: null },
        ])
        expect(attempts[0]?.diagnostics).toEqual({
          status: 429,
          providerCode: 'quota_window',
          classification: 'capacity_limited',
          capacityScope: 'key',
          remainingPercent: 0,
        })
        expect(JSON.stringify(attempts)).not.toContain('must not persist')
      })

      test('orders events most-recent first and supports filters', async () => {
        await database.providers.insertProvider(connection('pc_one'))
        await database.providers.insertProvider(connection('pc_two'))

        await database.requestHistory.recordEvent(event('req_a', 'pc_one', { outcome: 'success' }))
        await database.requestHistory.recordEvent(event('req_b', 'pc_two', { outcome: 'failure', status: 502 }))
        await database.requestHistory.recordEvent(event('req_c', 'pc_one', { keyId: 'uk_two', latencyMs: 100, status: 200 }))

        const all = await database.requestHistory.listEvents()
        expect(all.total).toBe(3)
        expect(all.events.map((row) => row.id)).toEqual(['req_c', 'req_b', 'req_a'])

        const onlyPcOne = await database.requestHistory.listEvents({
          filter: { providerId: 'pc_one' },
        })
        expect(onlyPcOne.events.map((row) => row.id)).toEqual(['req_c', 'req_a'])

        const onlyFailures = await database.requestHistory.listEvents({ filter: { outcome: 'failure' } })
        expect(onlyFailures.events.map((row) => row.id)).toEqual(['req_b'])

        const byKey = await database.requestHistory.listEvents({ filter: { keyId: 'uk_two' } })
        expect(byKey.events.map((row) => row.id)).toEqual(['req_c'])
      })

      test('paginates events with a stable order under a limit', async () => {
        await database.providers.insertProvider(connection('pc_rh'))
        for (let i = 0; i < 5; i++) {
          await database.requestHistory.recordEvent(
            event(`req_${i}`, 'pc_rh', {
              occurredAt: new Date(at.getTime() + i * 1000),
            }),
          )
        }

        const page1 = await database.requestHistory.listEvents({ limit: 2, offset: 0 })
        const page2 = await database.requestHistory.listEvents({ limit: 2, offset: 2 })
        const page3 = await database.requestHistory.listEvents({ limit: 2, offset: 4 })

        expect(page1.events.map((row) => row.id)).toEqual(['req_4', 'req_3'])
        expect(page2.events.map((row) => row.id)).toEqual(['req_2', 'req_1'])
        expect(page3.events.map((row) => row.id)).toEqual(['req_0'])
        expect(page1.total).toBe(5)
      })

      test('prunes events older than a cutoff', async () => {
        await database.providers.insertProvider(connection('pc_rh'))
        await database.requestHistory.recordEvent(event('req_old', 'pc_rh', { occurredAt: new Date('2026-01-01T00:00:00.000Z') }))
        await database.requestHistory.recordEvent(event('req_new', 'pc_rh', { occurredAt: new Date('2026-02-01T00:00:00.000Z') }))

        const removed = await database.requestHistory.pruneEvents(new Date('2026-01-15T00:00:00.000Z'))
        expect(removed).toBe(1)
        expect((await database.requestHistory.listEvents()).events.map((row) => row.id)).toEqual(['req_new'])
      })

      test('cascades attempts when their event is pruned through a connection purge', async () => {
        await database.providers.insertProvider(connection('pc_rh'))
        await database.requestHistory.recordEvent(event('req_one', 'pc_rh'))
        await database.requestHistory.recordAttempt({
          requestId: 'req_one',
          attemptNumber: 1,
          keyId: 'uk_one',
          startedAt: at,
          completedAt: at,
          status: 200,
          outcome: 'success',
          errorCode: null,
          retryAfterSeconds: null,
        })

        await database.transaction(async (repositories) => {
          await repositories.providers.deleteKeysForProvider('pc_rh')
          await repositories.providers.deleteProvider('pc_rh')
        })

        expect(await database.requestHistory.getEvent('req_one')).toBeNull()
        expect(await database.requestHistory.getAttempts('req_one')).toEqual([])
      })

      test('lists and clears audit events', async () => {
        await database.audit.record({ action: 'owner.login', outcome: 'success', at })
        await database.audit.record({ action: 'owner.logout', outcome: 'success', at: later })
        await database.audit.record({ action: 'key.test.failure', outcome: 'failure', at: later })

        const all = await database.requestHistory.listAudit()
        expect(all.events.map((row) => row.action)).toEqual(['key.test.failure', 'owner.logout', 'owner.login'])

        const loginOnly = await database.requestHistory.listAudit({
          filter: { actionPrefix: 'owner.login' },
        })
        expect(loginOnly.events.map((row) => row.action)).toEqual(['owner.login'])

        const failures = await database.requestHistory.listAudit({ filter: { outcome: 'failure' } })
        expect(failures.events.map((row) => row.action)).toEqual(['key.test.failure'])

        expect(await database.requestHistory.clearAudit()).toBe(3)
        expect((await database.requestHistory.listAudit()).total).toBe(0)
      })
    })

    describe('background jobs', () => {
      test('returns null for an unknown job', async () => {
        expect(await database.backgroundJobs.get('absent')).toBeNull()
      })

      test('creates an idle row that has not run yet', async () => {
        const at = new Date('2026-01-01T00:00:00.000Z')
        const seeded = await database.backgroundJobs.ensureIdle('model_sync', at)
        expect(seeded.jobId).toBe('model_sync')
        expect(seeded.status).toBe('idle')
        expect(seeded.lastStartedAt).toBeNull()
        expect(seeded.lastCompletedAt).toBeNull()
        expect(seeded.lastOutcome).toBeNull()
        expect(seeded.updatedAt).toEqual(at)
      })

      test('ensureIdle is idempotent on a pre-existing row', async () => {
        const first = new Date('2026-01-01T00:00:00.000Z')
        const second = new Date('2026-02-01T00:00:00.000Z')
        await database.backgroundJobs.ensureIdle('retention_cleanup', first)
        const reloaded = await database.backgroundJobs.ensureIdle('retention_cleanup', second)
        expect(reloaded.updatedAt).toEqual(second)
        const stored = await database.backgroundJobs.get('retention_cleanup')
        expect(stored?.status).toBe('idle')
      })

      test('tryClaim transitions an idle row to running', async () => {
        const at = new Date('2026-01-01T00:00:00.000Z')
        await database.backgroundJobs.ensureIdle('model_sync', at)
        const started = await database.backgroundJobs.tryClaim('model_sync', new Date('2026-01-02T00:00:00.000Z'))
        expect(started).toEqual(new Date('2026-01-02T00:00:00.000Z'))
        const record = await database.backgroundJobs.get('model_sync')
        expect(record?.status).toBe('running')
      })

      test('tryClaim rejects a second concurrent claim of the same job', async () => {
        const at = new Date('2026-01-01T00:00:00.000Z')
        await database.backgroundJobs.ensureIdle('model_sync', at)
        const first = await database.backgroundJobs.tryClaim('model_sync', new Date('2026-01-02T00:00:00.000Z'))
        expect(first).not.toBeNull()
        const second = await database.backgroundJobs.tryClaim('model_sync', new Date('2026-01-03T00:00:00.000Z'))
        expect(second).toBeNull()
      })

      test('tryClaim returns null for a job that has no row', async () => {
        const started = await database.backgroundJobs.tryClaim('unknown', new Date())
        expect(started).toBeNull()
      })

      test('recordCompletion writes the terminal status, timing, and error context', async () => {
        const at = new Date('2026-01-01T00:00:00.000Z')
        await database.backgroundJobs.ensureIdle('model_sync', at)
        await database.backgroundJobs.tryClaim('model_sync', new Date('2026-01-02T00:00:00.000Z'))

        const completedAt = new Date('2026-01-02T00:00:01.000Z')
        const record = await database.backgroundJobs.recordCompletion('model_sync', {
          completedAt,
          status: 'failed',
          outcome: 'failure',
          errorCode: 'temporary',
          errorMessage: 'try again later',
          durationMs: 1000,
          affectedCount: 3,
        })

        expect(record.status).toBe('failed')
        expect(record.lastOutcome).toBe('failure')
        expect(record.lastErrorCode).toBe('temporary')
        expect(record.lastErrorMessage).toBe('try again later')
        expect(record.lastDurationMs).toBe(1000)
        expect(record.lastAffectedCount).toBe(3)
        expect(record.lastCompletedAt).toEqual(completedAt)
      })

      test('recordCompletion lets a fresh claim run again after the previous one finished', async () => {
        const at = new Date('2026-01-01T00:00:00.000Z')
        await database.backgroundJobs.ensureIdle('model_sync', at)
        await database.backgroundJobs.tryClaim('model_sync', new Date('2026-01-02T00:00:00.000Z'))
        await database.backgroundJobs.recordCompletion('model_sync', {
          completedAt: new Date('2026-01-02T00:00:01.000Z'),
          status: 'succeeded',
          outcome: 'success',
          durationMs: 1000,
        })

        const next = await database.backgroundJobs.tryClaim('model_sync', new Date('2026-01-02T00:00:05.000Z'))
        expect(next).not.toBeNull()
      })

      test('resetRunning moves every running row back to idle and keeps the timestamps', async () => {
        const at = new Date('2026-01-01T00:00:00.000Z')
        await database.backgroundJobs.ensureIdle('model_sync', at)
        const startedAt = new Date('2026-01-02T00:00:00.000Z')
        await database.backgroundJobs.tryClaim('model_sync', startedAt)

        const removed = await database.backgroundJobs.resetRunning()
        expect(removed).toBe(1)

        const record = await database.backgroundJobs.get('model_sync')
        expect(record?.status).toBe('idle')
        expect(record?.lastStartedAt).toEqual(startedAt)
      })

      test('list returns every row in job-id order', async () => {
        const at = new Date('2026-01-01T00:00:00.000Z')
        await database.backgroundJobs.ensureIdle('session_cleanup', at)
        await database.backgroundJobs.ensureIdle('model_sync', at)
        await database.backgroundJobs.ensureIdle('usage_poll', at)

        const all = await database.backgroundJobs.list()
        expect(all.map((record) => record.jobId)).toEqual([
          'model_sync',
          'session_cleanup',
          'usage_poll',
        ])
      })
    })
  })
}

describe.skipIf(Boolean(POSTGRES_URL))('postgres repository contract', () => {
  test.skip('requires IROHA_TEST_POSTGRES_URL to run', () => {})
})
