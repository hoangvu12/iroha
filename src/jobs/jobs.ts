import type { ModelCatalogService } from '../models/index.ts'
import type { ProviderConnectionRegistry } from '../providers/index.ts'
import type { RequestHistoryService } from '../history/index.ts'
import type { UsageService } from '../usage/index.ts'
import {
  BackgroundJobError,
  type BackgroundJob,
  type BackgroundJobContext,
  type BackgroundJobCollaborators,
  type BackgroundJobRunResult,
} from './scheduler.ts'

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
export function buildDefaultJobs(factories: BackgroundJobCollaborators): BackgroundJob[] {
  return [
    {
      id: JOB_IDS.modelSync,
      label: 'Model catalog synchronization',
      intervalSeconds: (settings) => settings.modelSync.intervalSeconds,
      async run({ jobs, database }: BackgroundJobContext): Promise<BackgroundJobRunResult> {
        const connections = await database.providers.listConnections()
        const targets = connections.filter((connection) => connection.archivedAt === null && connection.enabled)
        let succeeded = 0
        let affected = 0
        for (const connection of targets) {
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
        return succeeded === 0 && targets.length === 0
          ? { outcome: 'success', affectedCount: 0 }
          : { outcome: 'success', affectedCount: affected }
      },
    },
    {
      id: JOB_IDS.usage,
      label: 'Usage Adapter polling',
      intervalSeconds: (settings) => settings.usage.intervalSeconds,
      async run({ jobs, database }: BackgroundJobContext): Promise<BackgroundJobRunResult> {
        const connections = await database.providers.listConnections()
        const targets = connections.filter((connection) => connection.archivedAt === null && connection.enabled)
        let succeeded = 0
        for (const connection of targets) {
          const result = await jobs.usage.refresh(connection.id)
          if (result.ok || result.failure.code === 'rate_limited') {
            succeeded += 1
          } else if (result.failure.code === 'connection_archived') {
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
        const connections = await database.providers.listConnections()
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
  connectionId: string,
): never {
  throw new BackgroundJobError(
    'model_sync_failed',
    failure.code === 'no_eligible_key'
      ? `No Upstream Key is eligible to sync the model catalog for ${connectionId}.`
      : `Could not refresh the model catalog for ${connectionId}: ${failure.code}.`,
  )
}

function failureFromUsageFailure(
  failure: { code: string; message?: string },
  connectionId: string,
): never {
  throw new BackgroundJobError(
    'usage_poll_failed',
    `Could not poll usage for ${connectionId}: ${failure.code}.`,
  )
}
