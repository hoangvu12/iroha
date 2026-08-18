import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSecretCipher } from '../../src/crypto/index.ts'
import {
  createBuiltInAdapterRegistry,
  ProviderRegistry,
} from '../../src/providers/index.ts'
import { sqliteEngine } from '../persistence/engines.ts'
import { fakeKeyProbe, TEST_MASTER_KEY } from '../support/app.ts'
import { testClock, type TestClock } from '../support/identity.ts'

describe('durable scoped Key Health', () => {
  let opened: Awaited<ReturnType<typeof sqliteEngine.open>>
  let clock: TestClock
  let registry: ProviderRegistry
  let providerId: string
  let keyIds: string[]

  beforeEach(async () => {
    opened = await sqliteEngine.open()
    clock = testClock()
    registry = new ProviderRegistry({
      database: opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      keyProbe: fakeKeyProbe(),
      adapterRegistry: createBuiltInAdapterRegistry(),
      clock,
    })
    const created = await registry.create({
      displayName: 'Health test',
      handle: 'health-test',
      baseUrl: 'https://api.example.com/v1',
      keys: [{ upstreamKey: 'sk-first-health-key' }],
    })
    if (!created.ok) throw new Error(created.failure.code)
    providerId = created.value.id
    const withSecond = await registry.addKey(providerId, { upstreamKey: 'sk-second-health-key' })
    if (!withSecond.ok) throw new Error(withSecond.failure.code)
    keyIds = withSecond.value.keys.map((key) => key.id)
  })

  afterEach(async () => {
    await opened.dispose()
  })

  test('authentication failure persists and removes only the failed credential', async () => {
    await registry.recordInferenceFailure({
      keyId: keyIds[0]!,
      model: 'gpt-4o',
      status: 401,
      reason: 'upstream HTTP 401',
    })

    const stored = await opened.database.providers.getKey(keyIds[0]!)
    expect(stored).toMatchObject({
      health: 'invalid_authentication',
      healthScope: 'key',
      healthScopeId: keyIds[0],
      retryAfterAt: null,
    })
    expect((await registry.resolveInference(providerId, 'gpt-4o')).ok).toBe(true)
  })

  test('a shared-account exhaustion applies to every key in that account', async () => {
    const account = await registry.createAccount(providerId, { displayName: 'Shared plan' })
    if (!account.ok) throw new Error(account.failure.code)
    const accountId = account.value.accounts[0]!.id
    for (const keyId of keyIds) {
      await registry.updateKeySettings(providerId, keyId, { accountId })
    }

    await registry.recordInferenceFailure({
      keyId: keyIds[0]!,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 60,
      reason: 'account quota exhausted',
    })

    const keys = await opened.database.providers.listKeys(providerId)
    expect(keys.map((key) => key.health)).toEqual(['exhausted', 'exhausted'])
    expect(keys.every((key) => key.healthScope === 'account' && key.healthScopeId === accountId)).toBe(
      true,
    )
  })

  test('a connection-and-model cooldown blocks only that exact model', async () => {
    await registry.recordInferenceFailure({
      keyId: keyIds[0]!,
      model: 'gpt-4o',
      status: 503,
      retryAfterSeconds: 30,
      reason: 'model unavailable',
    })

    expect((await registry.resolveInference(providerId, 'gpt-4o')).ok).toBe(false)
    expect((await registry.resolveInference(providerId, 'gpt-4o-mini')).ok).toBe(true)
  })

  test('durable health survives registry restart', async () => {
    await registry.recordInferenceFailure({
      keyId: keyIds[0]!,
      model: 'gpt-4o',
      status: 401,
      reason: 'upstream HTTP 401',
    })
    const restarted = new ProviderRegistry({
      database: opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      keyProbe: fakeKeyProbe(),
      adapterRegistry: createBuiltInAdapterRegistry(),
      clock,
    })

    expect((await restarted.getProvider(providerId))?.keys[0]?.health).toBe('invalid_authentication')
    const target = await restarted.resolveInference(providerId, 'gpt-4o')
    if (!target.ok) throw new Error(target.failure.code)
    expect(target.value.keyId).toBe(keyIds[1]!)
  })

  test('cooldown expiry allows one concurrent controlled trial', async () => {
    await registry.disableKey(providerId, keyIds[1]!)
    await registry.recordInferenceFailure({
      keyId: keyIds[0]!,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 30,
      reason: 'unknown rate limit',
    })
    clock.advance(31)

    const [first, second] = await Promise.all([
      registry.resolveInference(providerId, 'gpt-4o'),
      registry.resolveInference(providerId, 'gpt-4o'),
    ])

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1)
    const trial = first.ok ? first : second
    if (!trial.ok) throw new Error('controlled trial was not claimed')
    await registry.recordInferenceSuccess(trial.value.keyId)
    expect((await opened.database.providers.getKey(trial.value.keyId))?.health).toBe('active')
  })

  describe('a Provider that named a billing condition', () => {
    // DashScope answers an overdue account with 400 Arrearage, Z.ai with 1113,
    // MiniMax with 402. Each is durable: the key will not serve again until
    // the Owner settles the account, so leaving it `active` feeds a dead
    // credential its full share of traffic until someone notices by hand.
    const paymentRequired = (keyId: string, observedAt: Date) => ({
      kind: 'payment_required' as const,
      capacityScope: 'key' as const,
      retryAction: 'try_alternate' as const,
      retryAfterSeconds: null,
      capacityEvidence: {
        availability: 'exhausted' as const,
        authority: 'provisional' as const,
        scope: { kind: 'key' as const, keyId },
        reason: 'credit_exhausted' as const,
        observedAt,
        freshUntil: observedAt,
        recheckAt: null,
        facts: {},
        diagnostics: {},
      },
    })

    test('parks the key and leaves the rest of the Provider serving', async () => {
      await registry.recordInferenceFailure({
        keyId: keyIds[0]!,
        model: 'gpt-4o',
        classification: paymentRequired(keyIds[0]!, clock.now()),
        reason: 'upstream HTTP 400',
      })

      const stored = await opened.database.providers.getKey(keyIds[0]!)
      expect(stored).toMatchObject({ health: 'exhausted', healthScope: 'key', healthScopeId: keyIds[0] })
      const target = await registry.resolveInference(providerId, 'gpt-4o')
      if (!target.ok) throw new Error(target.failure.code)
      expect(target.value.keyId).toBe(keyIds[1]!)
    })

    test('offers the parked key one controlled trial once the cooldown expires', async () => {
      await registry.disableKey(providerId, keyIds[1]!)
      await registry.recordInferenceFailure({
        keyId: keyIds[0]!,
        model: 'gpt-4o',
        classification: paymentRequired(keyIds[0]!, clock.now()),
        reason: 'upstream HTTP 400',
      })

      // Billing does not clear on a timer, so the wait is Iroha's own.
      expect((await registry.resolveInference(providerId, 'gpt-4o')).ok).toBe(false)
      clock.advance(901)
      expect((await registry.resolveInference(providerId, 'gpt-4o')).ok).toBe(true)
    })

    test('changes nothing when no adapter read it from the Provider', async () => {
      // A bare status-derived reading is a guess about one response, not
      // knowledge about the credential.
      await registry.recordInferenceFailure({
        keyId: keyIds[0]!,
        model: 'gpt-4o',
        status: 402,
        reason: 'upstream HTTP 402',
      })

      expect((await opened.database.providers.getKey(keyIds[0]!))?.health).toBe('active')
    })
  })

  test('manual authentication never clears authoritative exhaustion', async () => {
    await registry.recordInferenceFailure({
      keyId: keyIds[0]!,
      model: 'gpt-4o',
      status: 429,
      retryAfterSeconds: 60,
      reason: 'quota exhausted',
    })

    await registry.testKey(providerId, keyIds[0]!)

    const stored = await opened.database.providers.getKey(keyIds[0]!)
    expect(stored?.health).toBe('exhausted')
    expect(stored?.lastProbeVerdict).toBe('authenticated')
  })

  test('manual test probes a key with a base URL override against its own URL', async () => {
    const probe = fakeKeyProbe()
    const local = new ProviderRegistry({
      database: opened.database,
      cipher: createSecretCipher(TEST_MASTER_KEY),
      keyProbe: probe,
      adapterRegistry: createBuiltInAdapterRegistry(),
      clock,
    })
    const created = await local.create({
      displayName: 'Override probe',
      handle: 'override-probe',
      baseUrl: 'https://api.example.com/v1',
      keys: [{ upstreamKey: 'sk-override-key', baseUrl: 'https://override.example.com/v1' }],
    })
    if (!created.ok) throw new Error(created.failure.code)
    const overrideKeyId = created.value.keys[0]!.id

    await local.testKey(created.value.id, overrideKeyId)

    // create() already probed the key once; the manual test is the last call.
    expect(probe.calls).toHaveLength(2)
    expect(probe.calls[1]?.baseUrl).toBe('https://override.example.com/v1')
  })
})
