import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createSecretCipher } from '../../src/crypto/index.ts'
import {
  createBuiltInAdapterRegistry,
  ProviderRegistry,
} from '../../src/providers/index.ts'
import { sqliteEngine } from '../persistence/engines.ts'
import { fakeKeyProbe, TEST_MASTER_KEY } from '../support/app.ts'
import { testClock, type TestClock } from '../support/identity.ts'

const DEFAULT_URL = 'https://api.default.example.com/v1'
const OVERRIDE_URL = 'https://api.override.example.com/v1'
const DEFAULT_KEY = 'sk-default-upstream-key'
const OVERRIDE_KEY = 'sk-override-upstream-key'

describe('ProviderRegistry: per-Upstream-Key base URL override', () => {
  let opened: Awaited<ReturnType<typeof sqliteEngine.open>>
  let clock: TestClock
  let registry: ProviderRegistry
  let providerId: string
  let defaultKeyId: string
  let overrideKeyId: string

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
      displayName: 'Multi-endpoint Provider',
      baseUrl: DEFAULT_URL,
      keys: [{ upstreamKey: DEFAULT_KEY }, { upstreamKey: OVERRIDE_KEY, baseUrl: OVERRIDE_URL }],
    })
    if (!created.ok) throw new Error(created.failure.code)
    providerId = created.value.id
    // The storage layer orders by (createdAt, id), so two keys inserted in
    // the same transaction can come back in either order. Locate each by its
    // base URL instead of relying on position.
    const defaultKey = created.value.keys.find((key) => key.baseUrl === null)
    const overrideKey = created.value.keys.find((key) => key.baseUrl === OVERRIDE_URL)
    if (defaultKey === undefined || overrideKey === undefined) {
      throw new Error('the create did not return both the default and override keys')
    }
    defaultKeyId = defaultKey.id
    overrideKeyId = overrideKey.id
  })

  afterEach(async () => {
    await opened.dispose()
  })

  test('round-robin uses each key\'s own base URL when it wins', async () => {
    const seen: { keyId: string; baseUrl: string }[] = []
    for (let index = 0; index < 4; index += 1) {
      const resolved = await registry.resolveInference(providerId, 'gpt-4o')
      if (!resolved.ok) throw new Error(resolved.failure.code)
      seen.push({ keyId: resolved.value.keyId, baseUrl: resolved.value.baseUrl })
    }

    const defaultSelections = seen.filter((entry) => entry.keyId === defaultKeyId)
    const overrideSelections = seen.filter((entry) => entry.keyId === overrideKeyId)
    expect(defaultSelections).toHaveLength(2)
    expect(overrideSelections).toHaveLength(2)
    expect(defaultSelections.every((entry) => entry.baseUrl === DEFAULT_URL)).toBe(true)
    expect(overrideSelections.every((entry) => entry.baseUrl === OVERRIDE_URL)).toBe(true)
  })

  test('an excluded key forces the resolver onto the other key, with its own URL', async () => {
    const onOverride = await registry.resolveInference(providerId, 'gpt-4o', [defaultKeyId])
    if (!onOverride.ok) throw new Error(onOverride.failure.code)
    expect(onOverride.value.keyId).toBe(overrideKeyId)
    expect(onOverride.value.baseUrl).toBe(OVERRIDE_URL)

    const onDefault = await registry.resolveInference(providerId, 'gpt-4o', [overrideKeyId])
    if (!onDefault.ok) throw new Error(onDefault.failure.code)
    expect(onDefault.value.keyId).toBe(defaultKeyId)
    expect(onDefault.value.baseUrl).toBe(DEFAULT_URL)
  })

  test('clearing a key\'s base URL override makes it inherit the Provider default', async () => {
    const cleared = await registry.updateKeySettings(providerId, overrideKeyId, { baseUrl: null })
    if (!cleared.ok) throw new Error(cleared.failure.code)

    const resolved = await registry.resolveInference(providerId, 'gpt-4o', [defaultKeyId])
    if (!resolved.ok) throw new Error(resolved.failure.code)
    expect(resolved.value.keyId).toBe(overrideKeyId)
    expect(resolved.value.baseUrl).toBe(DEFAULT_URL)
  })
})
