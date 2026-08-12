import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { sqliteEngine } from '../persistence/engines.ts'
import type { Database } from '../../src/persistence/index.ts'
import {
  BackgroundScheduleSettingsService,
  DEFAULT_BACKGROUND_SCHEDULE,
  SettingsValidationError,
} from '../../src/jobs/index.ts'
import { testClock, type TestClock } from '../support/identity.ts'

describe('background schedule settings', () => {
  let database: Database
  let dispose: () => Promise<void>
  let clock: TestClock
  let settings: BackgroundScheduleSettingsService

  beforeEach(async () => {
    ;({ database, dispose } = await sqliteEngine.open())
    clock = testClock()
    settings = new BackgroundScheduleSettingsService({ database, clock })
  })

  afterEach(async () => {
    await dispose()
  })

  test('a fresh installation reports the defaults', async () => {
    expect(await settings.read()).toEqual(DEFAULT_BACKGROUND_SCHEDULE)
  })

  test('a write replaces just the supplied fields and returns the stored values', async () => {
    const stored = await settings.write({
      modelSync: { intervalSeconds: 120 },
      sessionCleanup: { batchSize: 250 },
    })
    expect(stored.modelSync.intervalSeconds).toBe(120)
    expect(stored.usage.intervalSeconds).toBe(DEFAULT_BACKGROUND_SCHEDULE.usage.intervalSeconds)
    expect(stored.sessionCleanup.batchSize).toBe(250)
    expect(stored.sessionCleanup.intervalSeconds).toBe(
      DEFAULT_BACKGROUND_SCHEDULE.sessionCleanup.intervalSeconds,
    )
  })

  test('values are clamped to safe bounds', async () => {
    const stored = await settings.write({
      modelSync: { intervalSeconds: 0 },
      retentionCleanup: { intervalSeconds: 10_000_000, requestBatchSize: 10_000_000 },
    })
    expect(stored.modelSync.intervalSeconds).toBe(1)
    expect(stored.retentionCleanup.intervalSeconds).toBeLessThanOrEqual(86_400 * 7)
    expect(stored.retentionCleanup.requestBatchSize).toBeLessThanOrEqual(100_000)
  })

  test('non-integers are rejected; out-of-range integers are clamped', async () => {
    // Non-integers are structural errors; the Owner must use a real number.
    await expect(
      settings.write({ modelSync: { intervalSeconds: 1.5 } }),
    ).rejects.toBeInstanceOf(SettingsValidationError)

    // Out-of-range integers are clamped to the safe bounds so a typo
    // cannot make the scheduler fire every millisecond.
    const stored = await settings.write({ modelSync: { intervalSeconds: -1 } })
    expect(stored.modelSync.intervalSeconds).toBe(1)
  })

  test('an invalid shape rejects the whole write', async () => {
    await expect(settings.write({ modelSync: 'not-an-object' })).rejects.toBeInstanceOf(
      SettingsValidationError,
    )
    // The original defaults are still in place.
    expect(await settings.read()).toEqual(DEFAULT_BACKGROUND_SCHEDULE)
  })

  test('the cache survives a re-read', async () => {
    await settings.write({ modelSync: { intervalSeconds: 600 } })
    const first = await settings.read()
    const second = await settings.read()
    expect(first).toEqual(second)
    expect(first.modelSync.intervalSeconds).toBe(600)
  })

  test('invalidate forces the next read to come from the database', async () => {
    await settings.write({ modelSync: { intervalSeconds: 600 } })
    settings.invalidate()
    const reloaded = await settings.read()
    expect(reloaded.modelSync.intervalSeconds).toBe(600)
  })

  test('a fresh installation has empty per-connection overrides', async () => {
    const current = await settings.read()
    expect(current.overrides.modelSync).toEqual({})
    expect(current.overrides.usage).toEqual({})
  })

  test('a write accepts overrides and returns the sanitized values', async () => {
    const stored = await settings.write({
      overrides: {
        modelSync: { 'pc-alpha': 120 },
        usage: { 'pc-alpha': 30, 'pc-beta': 90 },
      },
    })
    expect(stored.overrides.modelSync).toEqual({ 'pc-alpha': 120 })
    expect(stored.overrides.usage).toEqual({ 'pc-alpha': 30, 'pc-beta': 90 })
    // Global intervals are untouched when only overrides are supplied.
    expect(stored.modelSync.intervalSeconds).toBe(DEFAULT_BACKGROUND_SCHEDULE.modelSync.intervalSeconds)
    expect(stored.usage.intervalSeconds).toBe(DEFAULT_BACKGROUND_SCHEDULE.usage.intervalSeconds)
  })

  test('override values are clamped to the same bounds as the global intervals', async () => {
    const stored = await settings.write({
      overrides: {
        modelSync: { 'pc-small': 0, 'pc-large': 10_000_000 },
        usage: { 'pc-neg': -5 },
      },
    })
    expect(stored.overrides.modelSync['pc-small']).toBe(1)
    expect(stored.overrides.modelSync['pc-large']).toBeLessThanOrEqual(86_400 * 7)
    expect(stored.overrides.usage['pc-neg']).toBe(1)
  })

  test('non-integer override values reject the whole write', async () => {
    await expect(
      settings.write({
        overrides: {
          modelSync: { 'pc-alpha': 60.5 },
        },
      }),
    ).rejects.toBeInstanceOf(SettingsValidationError)
    // Defaults are still in place after a rejected write.
    expect((await settings.read()).overrides.modelSync).toEqual({})
  })

  test('a non-object inner override map rejects the whole write', async () => {
    await expect(
      settings.write({
        overrides: {
          modelSync: 'not-an-object' as unknown as Record<string, number>,
        },
      }),
    ).rejects.toBeInstanceOf(SettingsValidationError)

    await expect(
      settings.write({
        overrides: {
          usage: ['not', 'an', 'object'] as unknown as Record<string, number>,
        },
      }),
    ).rejects.toBeInstanceOf(SettingsValidationError)
  })

  test('an overrides object that is not an object rejects the whole write', async () => {
    await expect(
      settings.write({
        overrides: 'not-an-object' as unknown as Record<string, Record<string, number>>,
      }),
    ).rejects.toBeInstanceOf(SettingsValidationError)
  })

  test('overrides survive a cache invalidation', async () => {
    await settings.write({
      overrides: { modelSync: { 'pc-alpha': 300 } },
    })
    settings.invalidate()
    const reloaded = await settings.read()
    expect(reloaded.overrides.modelSync).toEqual({ 'pc-alpha': 300 })
  })

  test('a stale stored record with missing overrides is sanitized to empty maps', async () => {
    // Simulate a record written before overrides existed: the legacy shape
    // should still load, with empty override maps so callers can rely on the
    // field always being present.
    await database.settings.put('background.schedule', {
      modelSync: { intervalSeconds: 120 },
      usage: { intervalSeconds: 60 },
      cooldownRecovery: { intervalSeconds: 30 },
      retentionCleanup: { intervalSeconds: 3600, requestBatchSize: 1000 },
      sessionCleanup: { intervalSeconds: 3600, batchSize: 1000 },
    })
    settings.invalidate()
    const reloaded = await settings.read()
    expect(reloaded.overrides.modelSync).toEqual({})
    expect(reloaded.overrides.usage).toEqual({})
    expect(reloaded.modelSync.intervalSeconds).toBe(120)
  })
})
