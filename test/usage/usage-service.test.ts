import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSecretCipher } from '../../src/crypto/index.ts'
import {
  createBuiltInAdapterRegistry,
  ProviderRegistry,
} from '../../src/providers/index.ts'
import { createGenericUsageAdapter } from '../../src/usage/generic-adapter.ts'
import {
  createMockCreditUsageAdapter,
  createMockPlanUsageAdapter,
  UsageService,
  type UsageAdapter,
  type UsagePollResult,
  type UsageReading,
} from '../../src/usage/index.ts'
import { sqliteEngine } from '../persistence/engines.ts'
import { TEST_MASTER_KEY } from '../support/app.ts'
import { testClock, type TestClock } from '../support/identity.ts'

interface Fixture {
  opened: Awaited<ReturnType<typeof sqliteEngine.open>>
  clock: TestClock
  registry: ProviderRegistry
  providerId: string
  keyId: string
  accountId: string
}

async function buildFixture(
  adapter: UsageAdapter,
): Promise<{ fixture: Fixture; service: UsageService; dispose: () => Promise<void> }> {
  const opened = await sqliteEngine.open()
  const clock = testClock()
  const cipher = createSecretCipher(TEST_MASTER_KEY)
  const registry = new ProviderRegistry({
    database: opened.database,
    cipher,
    keyProbe: { async test() { return { verdict: 'usable', reason: null } } },
    adapterRegistry: createBuiltInAdapterRegistry(),
    clock,
  })
  const created = await registry.create({
    displayName: 'Usage test',
    baseUrl: 'https://api.example.com/v1',
    keys: [{ upstreamKey: 'sk-upstream-for-usage' }],
  })
  if (!created.ok) throw new Error(created.failure.code)
  const providerId = created.value.id
  const keyId = created.value.keys[0]!.id
  const account = await registry.createAccount(providerId, { displayName: 'Shared plan' })
  if (!account.ok) throw new Error(account.failure.code)
  const accountId = account.value.accounts[0]!.id
  await registry.updateKeySettings(providerId, keyId, { accountId })

  const service = new UsageService({ database: opened.database, cipher, adapter, clock })
  return {
    fixture: { opened, clock, registry, providerId, keyId, accountId },
    service,
    dispose: () => opened.dispose(),
  }
}

describe('UsageService generic reactive-only adapter', () => {
  let fixture: Fixture
  let service: UsageService
  let dispose: () => Promise<void>

  beforeEach(async () => {
    const built = await buildFixture(createGenericUsageAdapter())
    fixture = built.fixture
    service = built.service
    dispose = built.dispose
  })

  afterEach(async () => {
    await dispose()
  })

  test('exposes reactive_only visibility and an Unknown reading on first refresh', async () => {
    const view = await service.view(fixture.providerId)
    if (!view.ok) throw new Error(view.failure.code)

    expect(view.value.visibility).toBe('reactive_only')
    expect(view.value.readings).toEqual([])

    const refreshed = await service.refresh(fixture.providerId)
    if (!refreshed.ok) throw new Error(refreshed.failure.code)

    expect(refreshed.value.visibility).toBe('reactive_only')
    expect(refreshed.value.readings).toHaveLength(1)
    const reading = refreshed.value.readings[0] as NonNullable<typeof refreshed.value.readings[number]>
    expect(reading.confidence).toBe('unknown')
    expect(reading.balance).toBeNull()
    expect(reading.unit).toBe('unknown')
    expect(reading.scope.kind).toBe('unknown')
    expect(refreshed.value.lastFailureAt).toBeNull()
    expect(refreshed.value.stale).toBe(false)
    expect(refreshed.value.lastSuccessAt).not.toBeNull()
  })

  test('reactive-only evidence never reactivates a key', async () => {
    await fixture.registry.recordInferenceFailure({
      keyId: fixture.keyId,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 60,
      reason: 'quota exhausted',
    })
    await fixture.clock.advance(61)

    await service.refresh(fixture.providerId)
    const recovery = await service.recoveryEvidenceFor(fixture.providerId)
    expect(recovery).toBeNull()

    const result = await fixture.registry.reactivateFromUsage(
      fixture.providerId,
      {
        authoritative: false,
        hasCapacity: true,
        scope: { kind: 'provider' },
        at: fixture.clock.now(),
      },
    )
    expect(result.reactivated).toEqual([])

    const stored = await fixture.opened.database.providers.getKey(fixture.keyId)
    expect(stored?.health).toBe('exhausted')
  })
})

describe('UsageService authoritative credit adapter', () => {
  let fixture: Fixture
  let service: UsageService
  let dispose: () => Promise<void>
  let adapter: ReturnType<typeof createMockCreditUsageAdapter>

  beforeEach(async () => {
    adapter = createMockCreditUsageAdapter({
      initialBalances: { 'sk-upstream-for-usage': 42 },
      accountId: 'placeholder',
    })
    const built = await buildFixture(adapter)
    fixture = built.fixture
    service = built.service
    dispose = built.dispose
    adapter.respondWith((request) =>
      successReadingFor({
        balance: adapterBalanceFor(request.upstreamKey),
        accountId: fixture.accountId,
      }),
    )
  })

  afterEach(async () => {
    await dispose()
  })

  test('an authoritative credit reading persists with units, balance, and freshness', async () => {
    const view = await service.refresh(fixture.providerId)
    if (!view.ok) throw new Error(view.failure.code)

    expect(view.value.visibility).toBe('authoritative')
    expect(view.value.readings).toHaveLength(1)
    const reading = view.value.readings[0] as UsageReading
    expect(reading.unit).toBe('usd')
    expect(reading.balance).toBe(42)
    expect(reading.used).toBe(58)
    expect(reading.limit).toBe(100)
    expect(reading.confidence).toBe('confirmed')
    expect(reading.scope).toEqual({ kind: 'account', accountId: fixture.accountId })
    expect(view.value.lastSuccessAt).not.toBeNull()
    expect(view.value.lastFailureAt).toBeNull()
    expect(view.value.stale).toBe(false)
    expect(adapter.calls).toHaveLength(1)
  })

  test('a confirmed zero is reported as zero, distinct from Unknown', async () => {
    adapter.respondWith((request) =>
      successReadingFor({ balance: 0, accountId: fixture.accountId }),
    )

    const view = await service.refresh(fixture.providerId)
    if (!view.ok) throw new Error(view.failure.code)

    const reading = view.value.readings[0] as UsageReading
    expect(reading.balance).toBe(0)
    expect(reading.confidence).toBe('confirmed')
    expect(reading.used).toBe(100)
    expect(reading.balance === null).toBe(false)
  })

  test('a failing poll retains the previous successful reading and marks it stale', async () => {
    await service.refresh(fixture.providerId)
    const before = await service.view(fixture.providerId)
    if (!before.ok) throw new Error(before.failure.code)

    adapter.respondWith({
      ok: false,
      failure: { code: 'upstream_refused', status: 503, message: 'service unavailable' },
    })

    fixture.clock.advance(5)
    const after = await service.refresh(fixture.providerId)
    if (!after.ok) throw new Error(after.failure.code)

    expect(after.value.stale).toBe(true)
    expect(after.value.lastFailureAt).not.toBeNull()
    expect(after.value.lastFailureCode).toBe('upstream_refused')
    expect(after.value.lastFailureMessage).toContain('HTTP 503')
    expect(after.value.readings).toHaveLength(1)
    expect((after.value.readings[0] as UsageReading).balance).toBe(42)
  })

  test('an unparseable response is recorded with a structural code and no secret text', async () => {
    adapter.respondWith({
      ok: false,
      failure: { code: 'unparseable_response', message: 'the answer did not match the adapter shape' },
    })

    const view = await service.refresh(fixture.providerId)
    if (!view.ok) throw new Error(view.failure.code)

    expect(view.value.lastFailureCode).toBe('unparseable_response')
    expect(view.value.lastFailureMessage).toBe(
      'the answer did not match the adapter shape',
    )
    expect(view.value.lastFailureMessage).not.toContain('sk-upstream-for-usage')
  })

  test('rate-limited polls back off and remember the last successful reading', async () => {
    await service.refresh(fixture.providerId)

    adapter.respondWith({
      ok: false,
      failure: { code: 'rate_limited', retryAfterSeconds: 30 },
    })

    fixture.clock.advance(2)
    const backoff = await service.refresh(fixture.providerId)
    expect(backoff.ok).toBe(false)
    if (backoff.ok) throw new Error('rate-limited poll must surface a failure')
    expect(backoff.failure.code).toBe('rate_limited')
    if (backoff.failure.code !== 'rate_limited') throw new Error('expected rate_limited failure')
    expect(backoff.failure.retryAfterSeconds).toBe(30)

    const view = await service.view(fixture.providerId)
    if (!view.ok) throw new Error(view.failure.code)
    expect(view.value.stale).toBe(true)
    expect(view.value.lastSuccessAt).not.toBeNull()
    expect((view.value.readings[0] as UsageReading).balance).toBe(42)
    expect(view.value.nextPollAllowedAt).not.toBeNull()
  })

  test('authoritative recovery reactivates an exhausted key without an inference probe', async () => {
    await fixture.registry.recordInferenceFailure({
      keyId: fixture.keyId,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 60,
      reason: 'quota exhausted',
    })
    fixture.clock.advance(61)

    await service.refresh(fixture.providerId)

    const evidence = await service.recoveryEvidenceFor(fixture.providerId)
    if (evidence === null) throw new Error('expected recovery evidence')

    const result = await fixture.registry.reactivateFromUsage(fixture.providerId, evidence)
    expect(result.reactivated).toEqual([fixture.keyId])

    const stored = await fixture.opened.database.providers.getKey(fixture.keyId)
    expect(stored?.health).toBe('active')
    expect(stored?.healthReason).toBe('authoritative usage adapter evidence')
  })

  test('a stale authoritative reading does not reactive capacity', async () => {
    await service.refresh(fixture.providerId)

    fixture.clock.advance(60 * 60 * 24)

    const evidence = await service.recoveryEvidenceFor(fixture.providerId)
    expect(evidence).toBeNull()
  })

  test('account scope reactives every key in the account but not ungrouped ones', async () => {
    const added = await fixture.registry.addKey(fixture.providerId, {
      upstreamKey: 'sk-second-upstream',
    })
    if (!added.ok) throw new Error(added.failure.code)
    const secondKeyId = added.value.keys.find((key) => key.id !== fixture.keyId)!.id
    await fixture.registry.updateKeySettings(fixture.providerId, secondKeyId, {
      accountId: fixture.accountId,
    })
    adapter.respondWith((request) =>
      successReadingFor({
        balance: adapterBalanceFor(request.upstreamKey),
        accountId: fixture.accountId,
      }),
    )

    await fixture.registry.recordInferenceFailure({
      keyId: fixture.keyId,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 60,
      reason: 'account quota exhausted',
    })
    await fixture.registry.recordInferenceFailure({
      keyId: secondKeyId,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 60,
      reason: 'account quota exhausted',
    })
    fixture.clock.advance(61)

    const accountAdapter = createMockCreditUsageAdapter({
      initialBalances: { 'sk-upstream-for-usage': 30, 'sk-second-upstream': 25 },
      scope: 'account',
      accountId: fixture.accountId,
    })
    const accountService = new UsageService({
      database: fixture.opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      adapter: accountAdapter,
      clock: fixture.clock,
    })
    await accountService.refresh(fixture.providerId)
    const evidence = await accountService.recoveryEvidenceFor(fixture.providerId)
    if (evidence === null) throw new Error('expected account-scope evidence')

    const result = await fixture.registry.reactivateFromUsage(fixture.providerId, evidence)
    expect([...result.reactivated].sort()).toEqual([fixture.keyId, secondKeyId].sort())
    for (const id of result.reactivated) {
      const stored = await fixture.opened.database.providers.getKey(id)
      expect(stored?.health).toBe('active')
    }
  })

  test('unknown scope evidence never reactives anything', async () => {
    await fixture.registry.recordInferenceFailure({
      keyId: fixture.keyId,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 60,
      reason: 'unknown quota exhausted',
    })

    const result = await fixture.registry.reactivateFromUsage(fixture.providerId, {
      authoritative: true,
      hasCapacity: true,
      scope: { kind: 'unknown' },
      at: fixture.clock.now(),
    })
    expect(result.reactivated).toEqual([])

    const stored = await fixture.opened.database.providers.getKey(fixture.keyId)
    expect(stored?.health).toBe('exhausted')
  })
})

describe('UsageService authoritative plan adapter', () => {
  let fixture: Fixture
  let service: UsageService
  let dispose: () => Promise<void>
  let adapter: ReturnType<typeof createMockPlanUsageAdapter>

  beforeEach(async () => {
    const resetAt = new Date('2026-01-15T00:00:00.000Z')
    adapter = createMockPlanUsageAdapter({
      used: 30,
      limit: 100,
      resetAt,
      scope: 'connection_model',
      model: 'gpt-4o',
    })
    const built = await buildFixture(adapter)
    fixture = built.fixture
    service = built.service
    dispose = built.dispose
  })

  afterEach(async () => {
    await dispose()
  })

  test('a plan-window reading exposes used, limit, reset, and the model scope', async () => {
    const view = await service.refresh(fixture.providerId)
    if (!view.ok) throw new Error(view.failure.code)

    const reading = view.value.readings[0] as UsageReading
    expect(reading.unit).toBe('requests')
    expect(reading.remainingPercent).toBe(70)
    expect(reading.plan).toBe('gpt-4o')
    expect(reading.balance).toBeNull()
    expect(reading.used).toBeNull()
    expect(reading.limit).toBeNull()
    expect(reading.resetAt).toEqual(new Date('2026-01-15T00:00:00.000Z'))
    expect(reading.scope).toEqual({ kind: 'connection_model', model: 'gpt-4o' })
    expect(reading.confidence).toBe('confirmed')
  })

  test('a later plan window replaces the previous one without losing cadence state', async () => {
    await service.refresh(fixture.providerId)
    adapter.setWindow(95, 100)

    fixture.clock.advance(7)
    const view = await service.refresh(fixture.providerId)
    if (!view.ok) throw new Error(view.failure.code)

    const reading = view.value.readings[0] as UsageReading
    expect(reading.remainingPercent).toBe(5)
    expect(reading.plan).toBe('gpt-4o')
    expect(view.value.lastSuccessAt).not.toBeNull()
  })

  test('connection_model scope reactives only the keys that cooled on that model', async () => {
    const added = await fixture.registry.addKey(fixture.providerId, {
      upstreamKey: 'sk-second-upstream',
    })
    if (!added.ok) throw new Error(added.failure.code)
    const secondKeyId = added.value.keys.find((key) => key.id !== fixture.keyId)!.id

    await fixture.registry.recordInferenceFailure({
      keyId: fixture.keyId,
      model: 'gpt-4o',
      status: 503,
      retryAfterSeconds: 30,
      reason: 'model unavailable',
    })
    await fixture.registry.recordInferenceFailure({
      keyId: secondKeyId,
      model: 'gpt-4o-mini',
      status: 503,
      retryAfterSeconds: 30,
      reason: 'a different model is unavailable',
    })
    fixture.clock.advance(31)

    await service.refresh(fixture.providerId)
    const evidence = await service.recoveryEvidenceFor(fixture.providerId)
    if (evidence === null) throw new Error('expected connection_model evidence')

    const result = await fixture.registry.reactivateFromUsage(fixture.providerId, evidence)
    expect(result.reactivated).toEqual([fixture.keyId])

    const reactivated = await fixture.opened.database.providers.getKey(fixture.keyId)
    const untouched = await fixture.opened.database.providers.getKey(secondKeyId)
    expect(reactivated?.health).toBe('active')
    expect(untouched?.health).toBe('cooling_down')
  })

  test('a provider-wide scope reactives every cooling key', async () => {
    const added = await fixture.registry.addKey(fixture.providerId, {
      upstreamKey: 'sk-second-upstream',
    })
    if (!added.ok) throw new Error(added.failure.code)
    const secondKeyId = added.value.keys.find((key) => key.id !== fixture.keyId)!.id

    await fixture.registry.recordInferenceFailure({
      keyId: fixture.keyId,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 60,
      reason: 'provider quota exhausted',
    })
    await fixture.registry.recordInferenceFailure({
      keyId: secondKeyId,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 60,
      reason: 'provider quota exhausted',
    })
    fixture.clock.advance(61)

    const providerAdapter = createMockPlanUsageAdapter({
      used: 95,
      limit: 100,
      scope: 'provider',
    })
    const providerService = new UsageService({
      database: fixture.opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      adapter: providerAdapter,
      clock: fixture.clock,
    })
    await providerService.refresh(fixture.providerId)
    const evidence = await providerService.recoveryEvidenceFor(fixture.providerId)
    if (evidence === null) throw new Error('expected provider-scope evidence')

    const result = await fixture.registry.reactivateFromUsage(fixture.providerId, evidence)
    expect([...result.reactivated].sort()).toEqual([fixture.keyId, secondKeyId].sort())
  })

  test('a poll failure with no previous success still surfaces an Unknown view', async () => {
    const failingAdapter: UsageAdapter = {
      visibility: 'authoritative',
      async read() {
        const failure: UsagePollResult = {
          ok: false,
          failure: {
            code: 'upstream_unreachable',
            message: 'the provider timed out',
          },
        }
        return failure
      },
    }
    const fresh = new UsageService({
      database: fixture.opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      adapter: failingAdapter,
      clock: fixture.clock,
    })
    const view = await fresh.refresh(fixture.providerId)
    if (!view.ok) throw new Error(view.failure.code)

    expect(view.value.readings).toEqual([])
    expect(view.value.stale).toBe(false)
    expect(view.value.lastSuccessAt).toBeNull()
    expect(view.value.lastFailureAt).not.toBeNull()
    expect(view.value.lastFailureCode).toBe('upstream_unreachable')
  })
})

describe('UsageService per-Upstream-Key polling', () => {
  let fixture: Fixture
  let service: UsageService
  let dispose: () => Promise<void>
  let adapter: ReturnType<typeof createMockCreditUsageAdapter>

  beforeEach(async () => {
    adapter = createMockCreditUsageAdapter({
      initialBalances: { 'sk-upstream-for-usage': 42, 'sk-second-upstream': 25 },
      accountId: 'shared-account',
    })
    const built = await buildFixture(adapter)
    fixture = built.fixture
    service = built.service
    dispose = built.dispose
    adapter.respondWith((request) =>
      successReadingFor({
        balance: adapterBalanceFor(request.upstreamKey),
        accountId: fixture.accountId,
      }),
    )
    await fixture.registry.addKey(fixture.providerId, {
      upstreamKey: 'sk-second-upstream',
    })
  })

  afterEach(async () => {
    await dispose()
  })

  test('each eligible Upstream Key is polled and tagged with its keyId', async () => {
    const view = await service.refresh(fixture.providerId)
    if (!view.ok) throw new Error(view.failure.code)

    expect(view.value.readings).toHaveLength(2)
    const byKey = new Map(view.value.readings.map((r) => [r.keyId, r]))
    expect(byKey.get(fixture.keyId)?.balance).toBe(42)
    const secondKeyId = view.value.readings.find((r) => r.keyId !== fixture.keyId)?.keyId
    expect(secondKeyId).toBeDefined()
    expect(byKey.get(secondKeyId ?? '')?.balance).toBe(25)
    expect(adapter.calls).toHaveLength(2)
  })

  test('a partial failure keeps the successful key\'s reading and records the failure at the connection level', async () => {
    // First refresh — both keys succeed.
    await service.refresh(fixture.providerId)

    // Second refresh — first key fails, second key still works. The failure
    // is recorded at the connection level (one latest-failure across all
    // keys) and the prior reading for the failed key is preserved.
    let callCount = 0
    adapter.respondWith((request) => {
      callCount += 1
      if (request.upstreamKey === 'sk-upstream-for-usage') {
        return {
          ok: false,
          failure: { code: 'upstream_refused', status: 503, message: 'service unavailable' },
        }
      }
      return successReadingFor({
        balance: adapterBalanceFor(request.upstreamKey),
        accountId: fixture.accountId,
      })
    })

    const after = await service.refresh(fixture.providerId)
    if (!after.ok) throw new Error(after.failure.code)

    expect(after.value.lastFailureAt).not.toBeNull()
    expect(after.value.lastFailureCode).toBe('upstream_refused')
    // The failure and the success landed in the same refresh, so the
    // snapshot is not "stale" in the lastFailureAt > lastSuccessAt sense.
    expect(after.value.stale).toBe(false)

    const byKey = new Map(after.value.readings.map((r) => [r.keyId, r]))
    const secondKeyId = after.value.readings.find((r) => r.keyId !== fixture.keyId)?.keyId
    expect(secondKeyId).toBeDefined()
    // The successful key's reading was just refreshed; its balance is 25.
    expect(byKey.get(secondKeyId ?? '')?.balance).toBe(25)
    expect(callCount).toBe(2)
    // The failed key's prior reading is preserved at its old balance.
    expect(byKey.get(fixture.keyId)?.balance).toBe(42)
  })

  test('a rate-limited key surfaces 429 with the most restrictive retryAfter', async () => {
    let callCount = 0
    adapter.respondWith((request) => {
      callCount += 1
      if (request.upstreamKey === 'sk-upstream-for-usage') {
        return {
          ok: false,
          failure: { code: 'rate_limited', retryAfterSeconds: 30 },
        }
      }
      return successReadingFor({
        balance: adapterBalanceFor(request.upstreamKey),
        accountId: fixture.accountId,
      })
    })

    const result = await service.refresh(fixture.providerId)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('rate-limited refresh must fail')
    expect(result.failure.code).toBe('rate_limited')
    if (result.failure.code !== 'rate_limited') throw new Error('expected rate_limited')
    expect(result.failure.retryAfterSeconds).toBe(30)
    expect(callCount).toBe(2)
  })

  test('the snapshot\'s result is keyed by Upstream Key id after refresh', async () => {
    await service.refresh(fixture.providerId)
    const stored = await fixture.opened.database.usage.get(fixture.providerId)
    if (stored === null) throw new Error('expected a snapshot')
    if (stored.result === null || typeof stored.result !== 'object' || Array.isArray(stored.result)) {
      throw new Error('expected the per-key map shape')
    }
    const map = stored.result as Record<string, unknown>
    const keyIds = Object.keys(map)
    expect(keyIds).toContain(fixture.keyId)
    expect(keyIds.length).toBe(2)
  })
})

describe('UsageService input validation', () => {
  let fixture: Fixture
  let dispose: () => Promise<void>

  beforeEach(async () => {
    const built = await buildFixture(createGenericUsageAdapter())
    fixture = built.fixture
    dispose = built.dispose
  })

  afterEach(async () => {
    await dispose()
  })

  test('view returns provider_not_found for an unknown connection', async () => {
    const view = await new UsageService({
      database: fixture.opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      adapter: createGenericUsageAdapter(),
      clock: fixture.clock,
    }).view('pc_does_not_exist')
    expect(view.ok).toBe(false)
    if (view.ok) throw new Error('expected a failure')
    expect(view.failure.code).toBe('provider_not_found')
  })

  test('refresh returns provider_archived for an archived connection', async () => {
    await fixture.registry.archive(fixture.providerId)
    const service = new UsageService({
      database: fixture.opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      adapter: createGenericUsageAdapter(),
      clock: fixture.clock,
    })
    const view = await service.refresh(fixture.providerId)
    expect(view.ok).toBe(false)
    if (view.ok) throw new Error('expected a failure')
    expect(view.failure.code).toBe('provider_archived')
  })

  test('refresh returns provider_disabled for a disabled connection', async () => {
    await fixture.registry.update(fixture.providerId, { enabled: false })
    const service = new UsageService({
      database: fixture.opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      adapter: createGenericUsageAdapter(),
      clock: fixture.clock,
    })
    const view = await service.refresh(fixture.providerId)
    expect(view.ok).toBe(false)
    if (view.ok) throw new Error('expected a failure')
    expect(view.failure.code).toBe('provider_disabled')
  })
})

describe('UsageService snapshot JSON roundtrip', () => {
  test('recovers a Date resetAt from the persisted JSON string', async () => {
    const adapter = createMockPlanUsageAdapter({
      used: 30,
      limit: 100,
      resetAt: new Date('2026-01-15T00:00:00.000Z'),
      scope: 'connection_model',
      model: 'gpt-4o',
    })
    const built = await buildFixture(adapter)
    const service = built.service

    const refreshed = await service.refresh(built.fixture.providerId)
    if (!refreshed.ok) throw new Error(refreshed.failure.code)
    expect(refreshed.value.readings).toHaveLength(1)
    expect(refreshed.value.readings[0]?.resetAt).toBeInstanceOf(Date)

    const viewed = await service.view(built.fixture.providerId)
    if (!viewed.ok) throw new Error(viewed.failure.code)
    // The snapshot's `result` is stored via JSON.stringify and read back via
    // JSON.parse, which round-trips Date as an ISO string. Without the
    // normalizeReadings rehydration, the second view would crash toISOString
    // in the HTTP DTO with a TypeError.
    expect(viewed.value.readings).toHaveLength(1)
    expect(viewed.value.readings[0]?.resetAt).toBeInstanceOf(Date)
    expect(viewed.value.readings[0]?.resetAt?.toISOString()).toBe('2026-01-15T00:00:00.000Z')

    await built.dispose()
  })

  test('reads the legacy single-reading snapshot as a one-element list', async () => {
    const adapter = createMockCreditUsageAdapter({
      initialBalances: { 'sk-upstream-for-usage': 7 },
      accountId: 'legacy-account',
    })
    const built = await buildFixture(adapter)
    const service = built.service
    await service.refresh(built.fixture.providerId)

    // Simulate the snapshot shape that pre-dates the multi-reading contract:
    // a single UsageReading object written straight into `result`. The
    // reader must still surface it as a one-element list, with `keyId: null`
    // because the per-key attribution didn't exist when the row was written.
    const opened = built.fixture.opened
    const prior = await opened.database.usage.get(built.fixture.providerId)
    if (prior === null) throw new Error('expected a snapshot')
    const legacySingleReading = {
      unit: 'usd',
      balance: 7,
      used: 93,
      limit: 100,
      remainingPercent: 7,
      plan: null,
      resetAt: null,
      scope: { kind: 'account', accountId: 'legacy-account' },
      confidence: 'confirmed',
      diagnostics: { source: 'mock-credit-adapter' },
    }
    await opened.database.usage.put({ ...prior, result: legacySingleReading })

    const viewed = await service.view(built.fixture.providerId)
    if (!viewed.ok) throw new Error(viewed.failure.code)
    expect(viewed.value.readings).toHaveLength(1)
    expect(viewed.value.readings[0]?.balance).toBe(7)
    expect(viewed.value.readings[0]?.keyId).toBeNull()

    await built.dispose()
  })

  test('reads a legacy flat-list snapshot and re-homes it on the next refresh', async () => {
    // The flat-list shape was the contract between the multi-reading and
    // per-key contracts: an array of UsageReading objects with no per-key
    // attribution. A reader must surface them with `keyId: null`, and the
    // very next successful refresh must convert the snapshot to the
    // per-key map shape so the per-key contract becomes the durable form.
    const adapter = createMockPlanUsageAdapter({
      used: 10,
      limit: 100,
      resetAt: new Date('2026-03-01T00:00:00.000Z'),
      scope: 'connection_model',
      model: 'legacy-model',
    })
    const built = await buildFixture(adapter)
    const service = built.service

    // Hand-craft a legacy flat-list snapshot without going through refresh.
    const opened = built.fixture.opened
    const legacyReading = {
      unit: 'requests',
      balance: null,
      used: null,
      limit: null,
      remainingPercent: 90,
      plan: 'legacy-model',
      resetAt: '2026-03-01T00:00:00.000Z',
      scope: { kind: 'connection_model', model: 'legacy-model' },
      confidence: 'confirmed',
      diagnostics: { source: 'mock-plan-adapter' },
    }
    const created = await opened.database.providers.getProvider(built.fixture.providerId)
    if (created === null) throw new Error('expected a provider')
    await opened.database.usage.put({
      providerId: built.fixture.providerId,
      visibility: 'authoritative',
      syncedAt: new Date('2026-02-01T00:00:00.000Z'),
      lastSuccessAt: new Date('2026-02-01T00:00:00.000Z'),
      lastFailureAt: null,
      lastFailureCode: null,
      lastFailureMessage: null,
      result: [legacyReading],
    })

    const viewed = await service.view(built.fixture.providerId)
    if (!viewed.ok) throw new Error(viewed.failure.code)
    expect(viewed.value.readings).toHaveLength(1)
    expect(viewed.value.readings[0]?.remainingPercent).toBe(90)
    expect(viewed.value.readings[0]?.keyId).toBeNull()

    // The very next refresh rewrites the snapshot in the per-key map shape.
    const refreshed = await service.refresh(built.fixture.providerId)
    if (!refreshed.ok) throw new Error(refreshed.failure.code)
    const stored = await opened.database.usage.get(built.fixture.providerId)
    if (stored === null) throw new Error('expected a snapshot')
    if (stored.result === null || Array.isArray(stored.result) || typeof stored.result !== 'object') {
      throw new Error('expected per-key map shape after refresh')
    }
    const keyIds = Object.keys(stored.result as Record<string, unknown>)
    expect(keyIds).toEqual([built.fixture.keyId])

    await built.dispose()
  })
})

/** The default balance the mock credit adapter returns for an upstream key. */
function adapterBalanceFor(upstreamKey: string): number | null {
  if (upstreamKey === 'sk-upstream-for-usage') return 42
  if (upstreamKey === 'sk-second-upstream') return 25
  return null
}

/** Builds a successful account-scope reading with the values the tests assert. */
function successReadingFor(input: {
  balance: number | null
  accountId: string
}): UsagePollResult {
  return {
    ok: true,
    readings: [
      {
        unit: 'usd',
        balance: input.balance,
        used: input.balance === null ? null : Math.max(0, 100 - input.balance),
        limit: 100,
        remainingPercent: input.balance,
        plan: null,
        resetAt: null,
        scope: { kind: 'account', accountId: input.accountId },
        keyId: null,
        confidence: 'confirmed',
        diagnostics: { source: 'mock-credit-adapter' },
      },
    ],
  }
}
