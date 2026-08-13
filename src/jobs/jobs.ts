import {
  BackgroundJobError,
  type BackgroundJob,
  type BackgroundJobContext,
  type BackgroundJobRunResult,
} from './scheduler.ts'

/**
 * The two background jobs that visit every Provider Connection and therefore
 * accept a per-connection interval override. Cleanup and cooldown-recovery
 * jobs operate process-wide and have no override.
 */
export type ConnectionVisitingJob = 'modelSync' | 'usage'

/**
 * Resolves the effective interval for one connection and one connection-visiting
 * job. The override takes precedence over the global interval when the Owner
 * has set one; otherwise the global cadence applies.
 *
 * Centralising the lookup keeps the per-job logic honest: a job that reads
 * `schedule.overrides.modelSync[id]` and `schedule.modelSync.intervalSeconds`
 * separately can drift from this rule across refactors; this function is the
 * one place the precedence lives.
 */
export function effectiveIntervalFor(
  schedule: import('./schedule-settings.ts').BackgroundScheduleSettings,
  job: ConnectionVisitingJob,
  providerId: string,
): number {
  const override = schedule.overrides[job][providerId]
  if (override !== undefined) return override
  return schedule[job].intervalSeconds
}

/**
 * Whether a per-connection background job should process `providerId` on
 * `now`. A connection that has never been processed is always due. Otherwise
 * the elapsed time since the last processed timestamp must meet or exceed the
 * effective interval. The boundary is inclusive: at exactly the interval the
 * connection is considered due, so a job that fires on the wall-clock minute
 * will pick up connections synced exactly one interval ago.
 */
export function connectionIsDue(input: {
  readonly lastSyncedAt: Date | null
  readonly effectiveIntervalSeconds: number
  readonly now: Date
}): boolean {
  if (input.lastSyncedAt === null) return true
  return input.now.getTime() - input.lastSyncedAt.getTime() >= input.effectiveIntervalSeconds * 1000
}

/**
 * The id of every background job the scheduler knows. The HTTP route reads
 * this set so the management UI can render button labels and the audit
 * lookup can join without a hard-coded list.
 */
export const JOB_IDS = {
  modelSync: 'model_sync',
  usage: 'usage_poll',
  cooldownRecovery: 'cooldown_recovery',
  retentionCleanup: 'retention_cleanup',
  sessionCleanup: 'session_cleanup',
} as const

export type JobId = (typeof JOB_IDS)[keyof typeof JOB_IDS]

export type { BackgroundJobCollaborators } from './scheduler.ts'

/**
 * Builds the five jobs the scheduler runs in production. Each job visits
 * every non-archived connection that has not been disabled, and reports a
 * distinct `affectedCount` so the Owner can see whether something happened.
 *
 * The cleanup jobs are bounded: a single run reads at most the configured
 * batch size and stops, so a long backlog cannot monopolize the database.
 * The repo boundary already enforces per-event FKs; the bounded batch is the
 * second wall against a single DELETE taking the lock for too long.
 */
export function buildDefaultJobs(): BackgroundJob[] {
  return [
    {
      id: JOB_IDS.modelSync,
      label: 'Model catalog synchronization',
      intervalSeconds: (settings) => settings.modelSync.intervalSeconds,
      async run({ jobs, database, schedule, clock }: BackgroundJobContext): Promise<BackgroundJobRunResult> {
        const connections = await database.providers.listProviders()
        const targets = connections.filter((connection) => connection.archivedAt === null && connection.enabled)
        let succeeded = 0
        let affected = 0
        for (const connection of targets) {
          const effective = effectiveIntervalFor(schedule, 'modelSync', connection.id)
          const prior = await database.modelCatalog.getSync(connection.id)
          if (!connectionIsDue({
            lastSyncedAt: prior?.syncedAt ?? null,
            effectiveIntervalSeconds: effective,
            // The decision is evaluated against the wall-clock at the moment
            // the connection is about to be processed, not the tick start.
            // A long-running fleet loop could otherwise compare later
            // connections against a stale `now` and either starve or
            // stampede a connection whose own clock has moved on.
            now: clock.now(),
          })) {
            continue
          }
          try {
            const result = await jobs.modelCatalog.refresh(connection.id)
            if (result.ok) {
              succeeded += 1
              affected += result.value.entries.length
            } else {
              throw failureFromModelCatalogFailure(result.failure, connection.id)
            }
          } catch (cause) {
            throw new BackgroundJobError(
              'model_sync_failed',
              `Synchronizing the model catalog for ${connection.id} failed.`,
              { cause },
            )
          }
        }
        // A tick that visits no eligible connection still completes cleanly;
        // the Owner sees `affectedCount` reflect the work the scheduler did
        // actually do, not the size of the configured fleet.
        return succeeded === 0 && targets.length === 0
          ? { outcome: 'success', affectedCount: 0 }
          : { outcome: 'success', affectedCount: affected }
      },
    },
    {
      id: JOB_IDS.usage,
      label: 'Usage Adapter polling',
      intervalSeconds: (settings) => settings.usage.intervalSeconds,
      async run({ jobs, database, schedule, clock }: BackgroundJobContext): Promise<BackgroundJobRunResult> {
        const connections = await database.providers.listProviders()
        const targets = connections.filter((connection) => connection.archivedAt === null && connection.enabled)
        let succeeded = 0
        for (const connection of targets) {
          const effective = effectiveIntervalFor(schedule, 'usage', connection.id)
          const prior = await database.usage.get(connection.id)
          if (!connectionIsDue({
            lastSyncedAt: prior?.syncedAt ?? null,
            effectiveIntervalSeconds: effective,
            now: clock.now(),
          })) {
            continue
          }
          const result = await jobs.usage.refresh(connection.id)
          if (result.ok || result.failure.code === 'rate_limited') {
            succeeded += 1
          } else if (result.failure.code === 'provider_archived') {
            // The connection was archived between the list and the refresh;
            // the next tick will skip it.
            continue
          } else {
            throw failureFromUsageFailure(result.failure, connection.id)
          }
        }
        return { outcome: 'success', affectedCount: succeeded }
      },
    },
    {
      id: JOB_IDS.cooldownRecovery,
      label: 'Cooldown recovery',
      intervalSeconds: (settings) => settings.cooldownRecovery.intervalSeconds,
      async run({ jobs, database }: BackgroundJobContext): Promise<BackgroundJobRunResult> {
        // Cooldown recovery is authoritative-only: it never makes a paid
        // inference probe. A reactive-only adapter cannot prove capacity, so
        // a connection whose adapter is reactive_only gets nothing.
        const connections = await database.providers.listProviders()
        const targets = connections.filter((connection) => connection.archivedAt === null && connection.enabled)
        let reactivated = 0
        for (const connection of targets) {
          const evidence = await jobs.usage.recoveryEvidenceFor(connection.id)
          if (evidence === null) continue
          if (!evidence.authoritative || !evidence.hasCapacity) continue
          const result = await jobs.providers.reactivateFromUsage(connection.id, evidence)
          reactivated += result.reactivated.length
        }
        return { outcome: 'success', affectedCount: reactivated }
      },
    },
    {
      id: JOB_IDS.retentionCleanup,
      label: 'Request-history retention',
      intervalSeconds: (settings) => settings.retentionCleanup.intervalSeconds,
      async run({ jobs, schedule }: BackgroundJobContext): Promise<BackgroundJobRunResult> {
        const batchSize = schedule.retentionCleanup.requestBatchSize
        let removed = 0
        for (let guard = 0; guard < MAX_CLEANUP_ITERATIONS; guard += 1) {
          const deleted = await jobs.requestHistory.pruneBounded(batchSize)
          removed += deleted
          if (deleted < batchSize) break
        }
        return { outcome: 'success', affectedCount: removed }
      },
    },
    {
      id: JOB_IDS.sessionCleanup,
      label: 'Expired session cleanup',
      intervalSeconds: (settings) => settings.sessionCleanup.intervalSeconds,
      async run({ clock, jobs }: BackgroundJobContext): Promise<BackgroundJobRunResult> {
        const removed = await jobs.removeExpiredSessions(clock.now())
        return { outcome: 'success', affectedCount: removed }
      },
    },
  ]
}

/**
 * The retention cleanup is bounded by an iteration guard as well as the
 * batch size, so a single scheduled tick cannot run forever even if the
 * batch size is very large and the backlog is enormous. Five iterations at
 * the default 1000-row batch is 5000 rows per tick; the Owner's UI message
 * for a long backlog is "next tick will catch up more".
 */
const MAX_CLEANUP_ITERATIONS = 5

function failureFromModelCatalogFailure(
  failure: { code: string; message?: string },
  providerId: string,
): never {
  throw new BackgroundJobError(
    'model_sync_failed',
    failure.code === 'no_eligible_key'
      ? `No Upstream Key is eligible to sync the model catalog for ${providerId}.`
      : `Could not refresh the model catalog for ${providerId}: ${failure.code}.`,
  )
}

function failureFromUsageFailure(
  failure: { code: string; message?: string },
  providerId: string,
): never {
  throw new BackgroundJobError(
    'usage_poll_failed',
    `Could not poll usage for ${providerId}: ${failure.code}.`,
  )
}
