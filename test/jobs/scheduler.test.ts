import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { sqliteEngine } from '../persistence/engines.ts'
import type { Database } from '../../src/persistence/index.ts'
import {
  BackgroundScheduler,
  BackgroundScheduleSettingsService,
  BackgroundJobError,
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

describe('background scheduler', () => {
  let database: Database
  let dispose: () => Promise<void>
  let clock: ReturnType<typeof testClock>
  let settings: BackgroundScheduleSettingsService

  beforeEach(async () => {
    ;({ database, dispose } = await sqliteEngine.open())
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

async function schedulerRecoveryStatus(database: Database, jobId: string) {
  return await database.backgroundJobs.get(jobId)
}
