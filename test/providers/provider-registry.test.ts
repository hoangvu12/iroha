import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
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
      handle: 'multi-endpoint-provider',
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

describe('ProviderRegistry: bulkAddKeys', () => {
  let opened: Awaited<ReturnType<typeof sqliteEngine.open>>
  let clock: TestClock
  let registry: ProviderRegistry
  let providerId: string

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
      displayName: 'Bulk Import Provider',
      handle: 'bulk-import-provider',
      baseUrl: DEFAULT_URL,
      keys: [{ upstreamKey: 'sk-initial-upstream-key' }],
    })
    if (!created.ok) throw new Error(created.failure.code)
    providerId = created.value.id
  })

  afterEach(async () => {
    await opened.dispose()
  })

  test('empty list returns added: [] and failed: []', async () => {
    const result = await registry.bulkAddKeys(providerId, { keys: [] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.added).toEqual([])
    expect(result.value.failed).toEqual([])

    const keys = await opened.database.providers.listKeys(providerId)
    expect(keys).toHaveLength(1)
  })

  test('all-valid batch inserts every key and audits each', async () => {
    const result = await registry.bulkAddKeys(providerId, {
      keys: [
        { upstreamKey: 'sk-bulk-1' },
        { upstreamKey: 'sk-bulk-2', baseUrl: OVERRIDE_URL },
        { upstreamKey: 'sk-bulk-3' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.added).toHaveLength(3)
    expect(result.value.failed).toEqual([])
    expect(result.value.added.map((entry) => entry.index)).toEqual([0, 1, 2])
    for (const entry of result.value.added) {
      expect(entry.keyId).toMatch(/^uk_/)
    }

    const stored = await opened.database.providers.listKeys(providerId)
    expect(stored).toHaveLength(4)
    // The two keys without a per-key baseUrl inherit the Provider default;
    // the middle one carries its own override. Bulk-imported keys carry no
    // account / model restrictions and start unverified until the probe runs.
    const overrideKey = stored.find((key) => key.baseUrl === OVERRIDE_URL)
    expect(overrideKey).toBeDefined()
    for (const key of stored) {
      expect(key.accountId).toBeNull()
      expect(key.allowedModels).toBeNull()
      expect(key.deniedModels).toBeNull()
    }

    const events = await opened.database.audit.list({ limit: 50 })
    const created = events.filter((event) => event.action === 'key.created')
    // The initial key plus three bulk-inserted keys.
    expect(created).toHaveLength(4)
    const overrideAudit = created.find(
      (event) => (event.detail as { keyId?: unknown }).keyId === overrideKey?.id,
    )
    expect(overrideAudit).toBeDefined()
    expect(overrideAudit?.detail).toMatchObject({ baseUrlInherited: false })
    const inheritedAudits = created.filter(
      (event) => (event.detail as { keyId?: unknown }).keyId !== overrideKey?.id,
    )
    for (const audit of inheritedAudits) {
      expect(audit.detail).not.toHaveProperty('baseUrlInherited')
    }
  })

  test('mixed valid/invalid batch records failures and keeps going', async () => {
    const result = await registry.bulkAddKeys(providerId, {
      keys: [
        { upstreamKey: 'sk-bulk-1' },
        { upstreamKey: '' },
        { upstreamKey: 'sk-bulk-3' },
        { upstreamKey: 'sk-bulk-4', baseUrl: 'not-a-url' },
        { upstreamKey: 'sk-bulk-5' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.added.map((entry) => entry.index)).toEqual([0, 2, 4])
    expect(result.value.failed.map((entry) => entry.index)).toEqual([1, 3])
    for (const failure of result.value.failed) {
      expect(failure.problems.length).toBeGreaterThan(0)
    }

    const stored = await opened.database.providers.listKeys(providerId)
    // The initial key plus the three valid bulk entries; the two bad lines
    // never reach storage, proving the loop continued past them.
    expect(stored).toHaveLength(4)
  })

  test('archived provider short-circuits with provider_archived', async () => {
    const archived = await registry.archive(providerId)
    if (!archived.ok) throw new Error(archived.failure.code)
    const eventsBefore = await opened.database.audit.list({ limit: 50 })

    const result = await registry.bulkAddKeys(providerId, {
      keys: [{ upstreamKey: 'sk-should-not-be-added' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('provider_archived')

    const eventsAfter = await opened.database.audit.list({ limit: 50 })
    expect(eventsAfter).toHaveLength(eventsBefore.length)
    expect(eventsAfter.some((event) => event.action === 'key.created')).toBe(true) // initial key
    const newEvents = eventsAfter.slice(eventsBefore.length)
    expect(newEvents.some((event) => event.action === 'key.created')).toBe(false)
  })

  test('missing provider short-circuits with provider_not_found', async () => {
    const result = await registry.bulkAddKeys('pr_does_not_exist', {
      keys: [{ upstreamKey: 'sk-should-not-be-added' }],
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failure.code).toBe('provider_not_found')
  })

  test('five-key batch probes the connection exactly once', async () => {
    // `#probeConnectionKeys` is private; the only path that reaches
    // `listKeys(providerId)` from inside `bulkAddKeys` is the single probe
    // pass at the end, so a spy on that call counts probe invocations.
    const listKeysSpy = spyOn(opened.database.providers, 'listKeys')

    const result = await registry.bulkAddKeys(providerId, {
      keys: [
        { upstreamKey: 'sk-bulk-1' },
        { upstreamKey: 'sk-bulk-2' },
        { upstreamKey: 'sk-bulk-3' },
        { upstreamKey: 'sk-bulk-4' },
        { upstreamKey: 'sk-bulk-5' },
      ],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.added).toHaveLength(5)
    expect(listKeysSpy).toHaveBeenCalledTimes(1)
  })
})
