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
})
