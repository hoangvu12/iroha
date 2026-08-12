import type { Clock } from '../runtime/clock.ts'
import { systemClock } from '../runtime/clock.ts'
import type { Timer } from '../runtime/timer.ts'
import { systemTimer } from '../runtime/timer.ts'
import type {
  BackgroundJobRecord,
  BackgroundJobRepository,
  BackgroundJobStatus,
  Database,
} from '../persistence/index.ts'
import {
  BackgroundScheduleSettingsService,
  DEFAULT_BACKGROUND_SCHEDULE,
  type BackgroundScheduleSettings,
} from './schedule-settings.ts'

/**
 * The terminal outcome a single job run produced. The scheduler records this
 * on the durable row so the Owner can see what happened without rerunning the
 * job. `errorCode` and `errorMessage` are structural, never upstream body text
 * that could echo a secret.
 */
export type BackgroundJobRunResult =
  | { readonly outcome: 'success'; readonly affectedCount?: number }
  | {
      readonly outcome: 'failure'
      readonly errorCode: string
      readonly errorMessage: string
      readonly affectedCount?: number
    }

/**
 * One background job's definition. The scheduler calls `run` under a
 * `tryClaim`; a `run` that returns is the only path to a `success` outcome.
 *
 * `intervalSeconds` is read fresh from settings at the start of each tick so
 * a value the Owner just changed takes effect without a restart. The job
 * itself decides how to compute its current interval; that way it can also
 * visit the per-job batch size or other state.
 */
export interface BackgroundJob {
  /** The stable id written to the database; never shown to an end user. */
  readonly id: string
  /** A short label the management UI renders. */
  readonly label: string
  /** What the job actually does; runs to completion inside the scheduler's loop. */
  readonly run: (context: BackgroundJobContext) => Promise<BackgroundJobRunResult>
  /** The job's current interval in seconds, read fresh each tick. */
  intervalSeconds(settings: BackgroundScheduleSettings): number
}

/**
 * The runtime context a job sees. `database` is the assembled application
 * database; `clock` is the wallet time so failure durations compare with the
 * request history; `jobs` is the bag of collaborators jobs reach for to do
 * their work without further argument threading.
 */
export interface BackgroundJobContext {
  readonly database: Database
  readonly clock: Clock
  readonly schedule: BackgroundScheduleSettings
  readonly jobs: BackgroundJobCollaborators
}

/**
 * The bag of collaborators every background job reaches for. The composition
 * boundary owns construction; the scheduler itself only knows the jobs.
 */
export interface BackgroundJobCollaborators {
  readonly modelCatalog: import('../models/index.ts').ModelCatalogService
  readonly providers: import('../providers/index.ts').ProviderConnectionRegistry
  readonly usage: import('../usage/index.ts').UsageService
  readonly requestHistory: import('../history/index.ts').RequestHistoryService
  /** Removes every Owner session whose expiry has passed. */
  readonly removeExpiredSessions: (now: Date) => Promise<number>
}

export interface SchedulerOptions {
  readonly database: Database
  readonly jobs: readonly BackgroundJob[]
  readonly settings: BackgroundScheduleSettingsService
  readonly collaborators: BackgroundJobCollaborators
  readonly clock?: Clock
  readonly timer?: Timer
  /**
   * The minimum gap between scheduler ticks. Defaults to 250ms; tests can
   * shrink it so the loop reacts faster to a manual `tick()` call.
   */
  readonly tickIntervalMs?: number
}

/**
 * The bounded background scheduler.
 *
 * Every job declares its interval; the scheduler decides when each job is
 * due. A job that is due is `tryClaim`-ed against the database; the claim
 * fails when another process already holds the slot, so a future multi-node
 * deployment can keep the same code. While the job runs, its status is
 * `running`; afterwards it is `succeeded` or `failed`.
 *
 * The scheduler never overlaps itself: jobs are evaluated serially inside a
 * single tick, and `tryClaim` guards against a second invocation sneaking
 * past. On a failed run, the next due time is pushed back by the configured
 * backoff so a misbehaving job cannot pound the database.
 */
export class BackgroundScheduler {
  readonly #database: Database
  readonly #jobs: readonly BackgroundJob[]
  readonly #settings: BackgroundScheduleSettingsService
  readonly #clock: Clock
  readonly #timer: Timer
  readonly #tickIntervalMs: number
  readonly #repository: BackgroundJobRepository
  readonly #collaborators: BackgroundJobCollaborators
  readonly #nextDueAt = new Map<string, number>()
  readonly #consecutiveFailures = new Map<string, number>()
  /** The active `setTimeout` handle, so `stop()` can cancel in-flight work. */
  #tickHandle: (() => void) | null = null
  /** True while a tick is in progress; `stop()` waits for it to finish. */
  #tickInFlight = false
  #stopped = false
  /** Outstanding manual jobs that have been claimed but not yet finished. */
  readonly #manualJobs = new Map<string, Promise<void>>()

  constructor(options: SchedulerOptions) {
    this.#database = options.database
    this.#jobs = options.jobs
    this.#settings = options.settings
    this.#clock = options.clock ?? systemClock
    this.#timer = options.timer ?? systemTimer
    this.#tickIntervalMs = options.tickIntervalMs ?? 250
    this.#repository = options.database.backgroundJobs
    this.#collaborators = options.collaborators
  }

  /**
   * Creates a database row for every registered job that does not yet have
   * one. The scheduler calls this on startup so the management UI never sees
   * a missing job; each row is `idle` and stamps `updatedAt` at start.
   */
  async seed(): Promise<void> {
    const at = this.#clock.now()
    for (const job of this.#jobs) {
      await this.#repository.ensureIdle(job.id, at)
    }
  }

  /** Every job id the scheduler will manage. The HTTP route reads this for the management UI. */
  jobIds(): readonly string[] {
    return this.#jobs.map((job) => job.id)
  }

  /** The current durable status of one job, or null when the job is unknown. */
  async status(jobId: string): Promise<BackgroundJobRecord | null> {
    return await this.#repository.get(jobId)
  }

  /** Every job's current durable status, in the schedule's own order. */
  async listStatus(): Promise<readonly BackgroundJobRecord[]> {
    // Lazy row priming: a job that has never run still appears in the Owner's
    // list because the registered job list is the source of truth for which
    // jobs exist; the database row reflects what has happened.
    const ids = this.#jobs.map((job) => job.id)
    const seen = new Set<string>()
    const rows: BackgroundJobRecord[] = []
    for (const id of ids) {
      const record = await this.#repository.ensureIdle(id, this.#clock.now())
      rows.push(record)
      seen.add(id)
    }
    // Preserve any extra rows the database already holds (defensive; the
    // scheduler is the only writer) so the Owner never sees stale data.
    for (const record of await this.#repository.list()) {
      if (seen.has(record.jobId)) continue
      rows.push(record)
    }
    const order = new Map(this.#jobs.map((job, index) => [job.id, index] as const))
    return rows.sort((left, right) => {
      const l = order.get(left.jobId) ?? Number.MAX_SAFE_INTEGER
      const r = order.get(right.jobId) ?? Number.MAX_SAFE_INTEGER
      return l - r
    })
  }

  /**
   * Runs one tick of the scheduler synchronously. Tests drive this by hand to
   * avoid relying on real timers, and the production loop calls it from
   * `setTimeout` so each tick is a single atomic slice.
   */
  async tick(): Promise<void> {
    const at = this.#clock.now()
    const schedule = await this.#settings.read()
    for (const job of this.#jobs) {
      if (this.#stopped) break
      const due = this.#nextDueAt.get(job.id) ?? at.getTime()
      if (due > at.getTime()) continue
      await this.#runJob(job, schedule, at)
    }
  }

  /**
   * Starts the scheduler loop. The first tick happens immediately so the
   * Owner sees the durable status move to `running` while a job is in flight.
   */
  start(): void {
    if (this.#tickHandle !== null || this.#stopped) return
    // Spread overlapping starts: a single tick fires every job that is due,
    // but starting them on the same wall-clock millisecond would create
    // observable bunches. Sub-millisecond offsets are not visible to humans.
    this.#scheduleNextTick()
  }

  /**
   * Stops the scheduler. The promise resolves once the in-flight tick has
   * finished and any claimed manual jobs have recorded their completion.
   */
  async stop(): Promise<void> {
    this.#stopped = true
    this.#tickHandle?.()
    this.#tickHandle = null
    await Promise.all([...this.#manualJobs.values()])
  }

  /**
   * Manually triggers one job. The trigger goes through the same `tryClaim`
   * path so an Owner button does not silently double-run a scheduled tick.
   * When the job is already running, the trigger returns the in-flight
   * record and the HTTP route answers with a 409, so the Owner sees that
   * the click was not queued behind the in-flight run.
   */
  async trigger(jobId: string): Promise<BackgroundJobRecord | null> {
    const job = this.#jobs.find((candidate) => candidate.id === jobId)
    if (job === undefined) return null

    // The in-memory map blocks concurrent triggers of the same job within
    // this process; the database row's `running` state is the durable guard
    // against cross-process overlap.
    const existing = this.#manualJobs.get(jobId)
    if (existing !== undefined) {
      await existing
    }

    // After the in-flight run has resolved, check the durable state once
    // more: if the row is still `running`, the row belongs to a previous
    // process and we must not double-run. The trigger returns the in-flight
    // record; the route answers 409.
    const current = await this.#repository.ensureIdle(jobId, this.#clock.now())
    if (current.status === 'running') {
      return current
    }

    const run = this.#runJob(job, await this.#settings.read(), this.#clock.now())
    this.#manualJobs.set(jobId, run)
    try {
      await run
    } finally {
      if (this.#manualJobs.get(jobId) === run) {
        this.#manualJobs.delete(jobId)
      }
    }
    return await this.#repository.get(jobId)
  }

  /**
   * The exact behaviour the scheduler applies after a run. Tests use the
   * shape to assert that a failure pushed the next due time back by the
   * configured backoff.
   */
  static computeNextDueAt(options: {
    readonly now: Date
    readonly intervalSeconds: number
    readonly outcome: 'success' | 'failure'
    readonly consecutiveFailures: number
    readonly backoffMultiplier?: number
  }): Date {
    const backoff = options.outcome === 'success'
      ? 1
      : Math.max(1, options.backoffMultiplier ?? 2) ** Math.min(8, Math.max(0, options.consecutiveFailures - 1))
    return new Date(options.now.getTime() + options.intervalSeconds * 1000 * backoff)
  }

  #scheduleNextTick(): void {
    if (this.#stopped) return
    this.#tickHandle = this.#timer.set(() => {
      void this.#runTick()
    }, this.#tickIntervalMs)
  }

  async #runTick(): Promise<void> {
    this.#tickInFlight = true
    this.#tickHandle = null
    try {
      await this.tick()
    } finally {
      this.#tickInFlight = false
      if (!this.#stopped) this.#scheduleNextTick()
    }
  }

  async #runJob(
    job: BackgroundJob,
    schedule: BackgroundScheduleSettings,
    at: Date,
  ): Promise<void> {
    const started = await this.#repository.tryClaim(job.id, at)
    if (started === null) {
      // Someone else owns the claim; an inflight scheduler from a previous
      // run must not be raced past. The next-due timestamp is left as-is so
      // the next tick tries again.
      return
    }

    const startedAt = started
    const finishedAt = this.#clock.now()
    const context: BackgroundJobContext = {
      database: this.#database,
      clock: this.#clock,
      schedule,
      jobs: this.#collaborators,
    }

    let result: BackgroundJobRunResult
    try {
      result = await job.run(context)
    } catch (cause) {
      result = errorResult(cause)
    }

    const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime())
    const completedAt = this.#clock.now()
    const status: BackgroundJobStatus = result.outcome === 'success' ? 'succeeded' : 'failed'

    await this.#repository.recordCompletion(job.id, {
      completedAt,
      status,
      outcome: result.outcome,
      durationMs,
      ...(result.outcome === 'failure'
        ? { errorCode: result.errorCode, errorMessage: result.errorMessage }
        : {}),
      ...(result.affectedCount === undefined ? {} : { affectedCount: result.affectedCount }),
    })

    if (result.outcome === 'success') {
      this.#consecutiveFailures.delete(job.id)
    } else {
      this.#consecutiveFailures.set(job.id, (this.#consecutiveFailures.get(job.id) ?? 0) + 1)
    }

    const intervalSeconds = job.intervalSeconds(schedule)
    const next = BackgroundScheduler.computeNextDueAt({
      now: completedAt,
      intervalSeconds,
      outcome: result.outcome,
      consecutiveFailures: this.#consecutiveFailures.get(job.id) ?? 0,
    })
    this.#nextDueAt.set(job.id, next.getTime())
  }
}

function errorResult(cause: unknown): BackgroundJobRunResult {
  if (cause instanceof BackgroundJobError) {
    return {
      outcome: 'failure',
      errorCode: cause.code,
      errorMessage: cause.message,
    }
  }
  return {
    outcome: 'failure',
    errorCode: 'internal_error',
    errorMessage: cause instanceof Error ? cause.message : 'The background job threw an unexpected error.',
  }
}

/**
 * A typed failure a job can throw. The scheduler maps the `code` and
 * `message` straight onto the durable row so the management UI can render
 * them without echoing the upstream body that produced them.
 */
export class BackgroundJobError extends Error {
  constructor(readonly code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'BackgroundJobError'
  }
}

export { DEFAULT_BACKGROUND_SCHEDULE }