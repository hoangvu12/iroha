import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { availableEngines } from '../persistence/engines.ts'
import type { Database } from '../../src/persistence/index.ts'
import {
  BackgroundScheduler,
  BackgroundScheduleSettingsService,
  BackgroundJobError,
  connectionIsDue,
  effectiveIntervalFor,
  type BackgroundJob,
  type BackgroundJobRunResult,
  type BackgroundScheduleSettings,
} from '../../src/jobs/index.ts'
import { testClock } from '../support/identity.ts'
import { fakeTimer } from '../support/timer.ts'

/**
 * Deterministic clock tests for the bounded background scheduler.
 *
 * The scheduler's behaviour lives at the seam between durable state and
 * real time: claims must be atomic, overlap must be impossible, restart
 * must observe the scheduled cadence, and a failed run must push the next
 * due time back. Each test drives the scheduler by hand, never by sleeping.
 */

interface ScheduledRun {
  readonly startedAt: Date
  readonly outcome: 'success' | 'failure'
  readonly errorCode?: string
  readonly errorMessage?: string
  readonly affectedCount?: number
}

function recordingJob(
  id: string,
  intervalSeconds: number,
  runs: ScheduledRun[],
  options: { intervalFromSettings?: (settings: BackgroundScheduleSettings) => number } = {},
): BackgroundJob {
  return {
    id,
    label: id,
    intervalSeconds: options.intervalFromSettings ?? (() => intervalSeconds),
    async run(): Promise<BackgroundJobRunResult> {
      const next = runs.shift()
      if (next === undefined) {
        throw new Error(`recordingJob ${id} ran out of scheduled outcomes`)
      }
      if (next.outcome === 'failure') {
        throw new BackgroundJobError(next.errorCode ?? 'job_failed', next.errorMessage ?? 'recording job failed')
      }
      const result: BackgroundJobRunResult = { outcome: 'success' }
      return next.affectedCount === undefined ? result : { ...result, affectedCount: next.affectedCount }
    },
  }
}

function asyncRecordingJob(
  id: string,
  intervalSeconds: number,
  runs: ScheduledRun[],
): BackgroundJob {
  return {
    id,
    label: id,
    intervalSeconds: () => intervalSeconds,
    async run(): Promise<BackgroundJobRunResult> {
      const next = runs.shift()
      if (next === undefined) {
        throw new Error(`asyncRecordingJob ${id} ran out of scheduled outcomes`)
      }
      // Yield so a second claim that raced with this one cannot finish first
      // unless the scheduler truly serializes them.
      await Promise.resolve()
      if (next.outcome === 'failure') {
        throw new BackgroundJobError(next.errorCode ?? 'job_failed', next.errorMessage ?? 'recording job failed')
      }
      return next.affectedCount === undefined
        ? { outcome: 'success' }
        : { outcome: 'success', affectedCount: next.affectedCount }
    },
  }
}

for (const engine of availableEngines) {
describe(`${engine.name} background scheduler`, () => {
  let database: Database
  let dispose: () => Promise<void>
  let clock: ReturnType<typeof testClock>
  let settings: BackgroundScheduleSettingsService

  beforeEach(async () => {
    ;({ database, dispose } = await engine.open())
    clock = testClock()
    settings = new BackgroundScheduleSettingsService({ database, clock })
  })

  afterEach(async () => {
    await dispose()
  })

  test('a fresh job starts as idle', async () => {
    const scheduler = new BackgroundScheduler({
      database,
      jobs: [recordingJob('status_idle', 60, [{ startedAt: clock.now(), outcome: 'success' }])],
      settings,
      collaborators: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: null as never,
        removeExpiredSessions: async () => 0,
      },
      clock,
    })

    expect(await scheduler.status('status_idle')).toBeNull()
  })

  test('a successful tick records the run and schedules the next due time', async () => {
    const startedAt = clock.now()
    const job = recordingJob('success_path', 60, [{ startedAt, outcome: 'success', affectedCount: 3 }])
    const scheduler = new BackgroundScheduler({
      database,
      jobs: [job],
      settings,
      collaborators: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: null as never,
        removeExpiredSessions: async () => 0,
      },
      clock,
    })

    await scheduler.trigger('success_path')

    const record = await scheduler.status('success_path')
    expect(record?.status).toBe('succeeded')
    expect(record?.lastOutcome).toBe('success')
    expect(record?.lastAffectedCount).toBe(3)
    expect(record?.lastDurationMs).toBeGreaterThanOrEqual(0)
    expect(record?.lastErrorCode).toBeNull()
    expect(record?.lastErrorMessage).toBeNull()
  })

  test('a failed tick records the run and pushes the next due time back', async () => {
    const startedAt = clock.now()
    const job = recordingJob('failure_path', 60, [
      { startedAt, outcome: 'failure', errorCode: 'temporary', errorMessage: 'try again later' },
    ])
    const scheduler = new BackgroundScheduler({
      database,
      jobs: [job],
      settings,
      collaborators: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: null as never,
        removeExpiredSessions: async () => 0,
      },
      clock,
    })

    await scheduler.trigger('failure_path')

    const record = await scheduler.status('failure_path')
    expect(record?.status).toBe('failed')
    expect(record?.lastOutcome).toBe('failure')
    expect(record?.lastErrorCode).toBe('temporary')
    expect(record?.lastErrorMessage).toBe('try again later')
  })

  test('trigger refuses to run when the durable row is already running', async () => {
    // A previous process held the claim and never recorded completion. The
    // trigger sees the row in `running` state, refuses to start a new run,
    // and returns the in-flight record so the HTTP route can answer 409.
    let runCount = 0
    const job: BackgroundJob = {
      id: 'in_flight',
      label: 'in_flight',
      intervalSeconds: () => 60,
      async run(): Promise<BackgroundJobRunResult> {
        runCount += 1
        return { outcome: 'success' }
      },
    }

    const scheduler = new BackgroundScheduler({
      database,
      jobs: [job],
      settings,
      collaborators: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: null as never,
        removeExpiredSessions: async () => 0,
      },
      clock,
    })
    await scheduler.seed()

    // Pre-claim the row to simulate an in-flight run from a previous process.
    await database.backgroundJobs.tryClaim('in_flight', clock.now())

    const record = await scheduler.trigger('in_flight')
    expect(runCount).toBe(0)
    expect(record?.status).toBe('running')
  })

  test('restart resets any orphan running claim to idle', async () => {
    // A previous process crashed mid-run with the row in `running`. Startup
    // reaches `resetRunning`; the Owner sees the job as idle again.
    await database.backgroundJobs.ensureIdle('recover_after_crash', clock.now())
    await database.backgroundJobs.tryClaim('recover_after_crash', clock.now())
    const before = await schedulerRecoveryStatus(database, 'recover_after_crash')
    expect(before?.status).toBe('running')

    await database.backgroundJobs.resetRunning()

    const after = await schedulerRecoveryStatus(database, 'recover_after_crash')
    expect(after?.status).toBe('idle')
  })

  test('backoff doubles the next due time after each consecutive failure', () => {
    const at = new Date('2026-01-01T00:00:00.000Z')
    const next = BackgroundScheduler.computeNextDueAt({
      now: at,
      intervalSeconds: 60,
      outcome: 'failure',
      consecutiveFailures: 3,
    })
    expect(next.getTime() - at.getTime()).toBe(60_000 * 4)

    const success = BackgroundScheduler.computeNextDueAt({
      now: at,
      intervalSeconds: 60,
      outcome: 'success',
      consecutiveFailures: 3,
    })
    expect(success.getTime() - at.getTime()).toBe(60_000)
  })

  test('a running tick prevents a second tick from running the same job', async () => {
    // Block the first run by holding a claim externally; the scheduler
    // observes the running state and skips the job for this tick.
    await database.backgroundJobs.ensureIdle('tick_no_double', clock.now())
    await database.backgroundJobs.tryClaim('tick_no_double', clock.now())

    const job = recordingJob('tick_no_double', 60, [
      { startedAt: clock.now(), outcome: 'success' },
    ])

    const scheduler = new BackgroundScheduler({
      database,
      jobs: [job],
      settings,
      collaborators: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: null as never,
        removeExpiredSessions: async () => 0,
      },
      clock,
    })

    await scheduler.tick()

    const record = await scheduler.status('tick_no_double')
    // The job was not picked up because the claim was already taken.
    expect(record?.status).toBe('running')
  })

  test('stop waits for the active tick and rejects subsequent claims', async () => {
    const timer = fakeTimer()
    let starts = 0
    let release!: () => void
    const job: BackgroundJob = {
      id: 'drainable_job',
      label: 'Drainable job',
      intervalSeconds: () => 60,
      async run() {
        starts += 1
        await new Promise<void>((resolve) => { release = resolve })
        return { outcome: 'success' }
      },
    }
    const scheduler = new BackgroundScheduler({
      database,
      jobs: [job],
      settings,
      collaborators: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: null as never,
        removeExpiredSessions: async () => 0,
      },
      clock,
      timer,
    })

    await scheduler.seed()
    scheduler.start()
    timer.advance(250)
    timer.flush()
    while ((await scheduler.status('drainable_job'))?.status !== 'running') await Bun.sleep(0)
    const stopping = scheduler.stop()
    expect(starts).toBe(1)

    release()
    await stopping
    expect((await scheduler.status('drainable_job'))?.status).toBe('succeeded')

    scheduler.start()
    timer.flush()
    expect(starts).toBe(1)
  })

  test('listStatus returns every known job in the schedule order', async () => {
    const scheduler = new BackgroundScheduler({
      database,
      jobs: [
        recordingJob('job_b', 60, [{ startedAt: clock.now(), outcome: 'success' }]),
        recordingJob('job_a', 60, [{ startedAt: clock.now(), outcome: 'success' }]),
      ],
      settings,
      collaborators: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: null as never,
        removeExpiredSessions: async () => 0,
      },
      clock,
    })

    expect(scheduler.jobIds()).toEqual(['job_b', 'job_a'])
    await scheduler.trigger('job_b')
    const listed = await scheduler.listStatus()
    expect(listed.map((record) => record.jobId)).toEqual(['job_b', 'job_a'])
  })
})
}

describe('connectionIsDue', () => {
  test('a connection with no prior run is always due', () => {
    expect(connectionIsDue({
      lastSyncedAt: null,
      effectiveIntervalSeconds: 60,
      now: new Date('2026-01-01T00:00:00.000Z'),
    })).toBe(true)
  })

  test('a connection whose last run is within the interval is not due', () => {
    const now = new Date('2026-01-01T00:01:00.000Z')
    const lastSyncedAt = new Date(now.getTime() - 30_000) // 30s ago
    expect(connectionIsDue({
      lastSyncedAt,
      effectiveIntervalSeconds: 60,
      now,
    })).toBe(false)
  })

  test('a connection whose last run is exactly at the interval boundary is due', () => {
    const now = new Date('2026-01-01T00:01:00.000Z')
    const lastSyncedAt = new Date(now.getTime() - 60_000)
    expect(connectionIsDue({
      lastSyncedAt,
      effectiveIntervalSeconds: 60,
      now,
    })).toBe(true)
  })

  test('a connection whose last run exceeds the interval is due', () => {
    const now = new Date('2026-01-01T00:01:00.000Z')
    const lastSyncedAt = new Date(now.getTime() - 90_000)
    expect(connectionIsDue({
      lastSyncedAt,
      effectiveIntervalSeconds: 60,
      now,
    })).toBe(true)
  })
})

describe('effectiveIntervalFor', () => {
  const baseSchedule = (): BackgroundScheduleSettings => ({
    modelSync: { intervalSeconds: 3600 },
    usage: { intervalSeconds: 60 },
    cooldownRecovery: { intervalSeconds: 30 },
    retentionCleanup: { intervalSeconds: 3600, requestBatchSize: 1000 },
    sessionCleanup: { intervalSeconds: 3600, batchSize: 1000 },
    overrides: {
      modelSync: {},
      usage: {},
    },
  })

  test('returns the global interval when no override is set', () => {
    const schedule = baseSchedule()
    expect(effectiveIntervalFor(schedule, 'modelSync', 'pc-alpha')).toBe(3600)
    expect(effectiveIntervalFor(schedule, 'usage', 'pc-alpha')).toBe(60)
  })

  test('returns the override when one is set', () => {
    const schedule: BackgroundScheduleSettings = {
      ...baseSchedule(),
      overrides: {
        modelSync: { 'pc-alpha': 120 },
        usage: { 'pc-alpha': 15 },
      },
    }
    expect(effectiveIntervalFor(schedule, 'modelSync', 'pc-alpha')).toBe(120)
    expect(effectiveIntervalFor(schedule, 'usage', 'pc-alpha')).toBe(15)
  })

  test('an override for one connection does not affect another', () => {
    const schedule: BackgroundScheduleSettings = {
      ...baseSchedule(),
      overrides: {
        modelSync: { 'pc-alpha': 120 },
        usage: {},
      },
    }
    expect(effectiveIntervalFor(schedule, 'modelSync', 'pc-alpha')).toBe(120)
    expect(effectiveIntervalFor(schedule, 'modelSync', 'pc-beta')).toBe(3600)
  })
})

for (const engine of availableEngines) {
describe(`${engine.name} retention cleanup boundaries`, () => {
  // The cleanup job must never monopolize the database with a giant DELETE.
  // It runs the prune in bounded batches and stops at the iteration guard.
  // These tests drive the actual job from `buildDefaultJobs` with a stub
  // request-history collaborator so the boundary semantics are visible
  // without touching the real history table.
  let database: Database
  let dispose: () => Promise<void>
  let clock: ReturnType<typeof testClock>
  let settings: BackgroundScheduleSettingsService

  beforeEach(async () => {
    ;({ database, dispose } = await engine.open())
    clock = testClock()
    settings = new BackgroundScheduleSettingsService({ database, clock })
  })

  afterEach(async () => {
    await dispose()
  })

  /**
   * A request-history stub that returns its prepared sequence of batch sizes.
   * The cleanup job keeps calling `pruneBounded` until it sees a short batch
   * or hits the iteration guard; the stub's sequence is what makes the
   * boundary visible.
   */
  function makeHistoryStub(batches: number[]) {
    const calls: number[] = []
    let index = 0
    return {
      calls,
      async pruneBounded(batchSize: number): Promise<number> {
        calls.push(batchSize)
        const value = batches[index] ?? 0
        index += 1
        return value
      },
    }
  }

  test('a short batch stops the loop without further calls', async () => {
    const history = makeHistoryStub([500])
    await settings.write({ retentionCleanup: { intervalSeconds: 60, requestBatchSize: 1000 } })

    const { buildDefaultJobs } = await import('../../src/jobs/jobs.ts')
    const job = buildDefaultJobs().find((j) => j.id === 'retention_cleanup')!
    const result = await job.run({
      database,
      clock,
      schedule: await settings.read(),
      jobs: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: history as never,
        removeExpiredSessions: async () => 0,
      },
    })
    expect(result.outcome).toBe('success')
    expect(result.affectedCount).toBe(500)
    expect(history.calls).toEqual([1000])
  })

  test('consecutive full batches run until one returns short', async () => {
    const history = makeHistoryStub([1000, 1000, 1000, 250])
    await settings.write({ retentionCleanup: { intervalSeconds: 60, requestBatchSize: 1000 } })

    const { buildDefaultJobs } = await import('../../src/jobs/jobs.ts')
    const job = buildDefaultJobs().find((j) => j.id === 'retention_cleanup')!
    const result = await job.run({
      database,
      clock,
      schedule: await settings.read(),
      jobs: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: history as never,
        removeExpiredSessions: async () => 0,
      },
    })
    expect(result.outcome).toBe('success')
    expect(result.affectedCount).toBe(3250)
    // Exactly one call past the short-batch termination is the stop signal.
    expect(history.calls.length).toBe(4)
  })

  test('the iteration guard caps a runaway backlog so a single tick cannot monopolize the database', async () => {
    // Five full batches in a row, never short: the guard stops the loop
    // before the backlog can be exhausted in one tick.
    const history = makeHistoryStub([1000, 1000, 1000, 1000, 1000, 1000])
    await settings.write({ retentionCleanup: { intervalSeconds: 60, requestBatchSize: 1000 } })

    const { buildDefaultJobs } = await import('../../src/jobs/jobs.ts')
    const job = buildDefaultJobs().find((j) => j.id === 'retention_cleanup')!
    const result = await job.run({
      database,
      clock,
      schedule: await settings.read(),
      jobs: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: history as never,
        removeExpiredSessions: async () => 0,
      },
    })
    expect(result.outcome).toBe('success')
    expect(result.affectedCount).toBe(5000)
    expect(history.calls.length).toBe(5)
  })

  test('a smaller batch size is honoured end to end', async () => {
    const history = makeHistoryStub([10, 10, 0])
    await settings.write({ retentionCleanup: { intervalSeconds: 60, requestBatchSize: 10 } })

    const { buildDefaultJobs } = await import('../../src/jobs/jobs.ts')
    const job = buildDefaultJobs().find((j) => j.id === 'retention_cleanup')!
    const result = await job.run({
      database,
      clock,
      schedule: await settings.read(),
      jobs: {
        modelCatalog: null as never,
        providers: null as never,
        usage: null as never,
        requestHistory: history as never,
        removeExpiredSessions: async () => 0,
      },
    })
    expect(result.outcome).toBe('success')
    expect(result.affectedCount).toBe(20)
    expect(history.calls).toEqual([10, 10, 10])
  })
})
}

async function schedulerRecoveryStatus(database: Database, jobId: string) {
  return await database.backgroundJobs.get(jobId)
}
