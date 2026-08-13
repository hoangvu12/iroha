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
    upstreamKey: 'sk-upstream-for-usage',
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
    expect(view.value.reading).toBeNull()

    const refreshed = await service.refresh(fixture.providerId)
    if (!refreshed.ok) throw new Error(refreshed.failure.code)

    expect(refreshed.value.visibility).toBe('reactive_only')
    expect(refreshed.value.reading?.confidence).toBe('unknown')
    expect(refreshed.value.reading?.balance).toBeNull()
    expect(refreshed.value.reading?.unit).toBe('unknown')
    expect(refreshed.value.reading?.scope.kind).toBe('unknown')
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
    expect(view.value.reading).not.toBeNull()
    const reading = view.value.reading as UsageReading
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

    const reading = view.value.reading as UsageReading
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
    expect(after.value.reading).not.toBeNull()
    expect((after.value.reading as UsageReading).balance).toBe(42)
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
    expect((view.value.reading as UsageReading).balance).toBe(42)
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

    const reading = view.value.reading as UsageReading
    expect(reading.unit).toBe('requests')
    expect(reading.used).toBe(30)
    expect(reading.limit).toBe(100)
    expect(reading.balance).toBe(70)
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

    const reading = view.value.reading as UsageReading
    expect(reading.used).toBe(95)
    expect(reading.balance).toBe(5)
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

    expect(view.value.reading).toBeNull()
    expect(view.value.stale).toBe(false)
    expect(view.value.lastSuccessAt).toBeNull()
    expect(view.value.lastFailureAt).not.toBeNull()
    expect(view.value.lastFailureCode).toBe('upstream_unreachable')
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
    reading: {
      unit: 'usd',
      balance: input.balance,
      used: input.balance === null ? null : Math.max(0, 100 - input.balance),
      limit: 100,
      resetAt: null,
      scope: { kind: 'account', accountId: input.accountId },
      confidence: 'confirmed',
      diagnostics: { source: 'mock-credit-adapter' },
    },
  }
}
