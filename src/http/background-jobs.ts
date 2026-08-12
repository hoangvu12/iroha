import { Elysia, t } from 'elysia'
import type { OwnerIdentity } from '../identity/index.ts'
import type { Database } from '../persistence/index.ts'
import type { BackgroundScheduler } from '../jobs/scheduler.ts'
import {
  BackgroundScheduleSettingsService,
  SettingsValidationError,
  type BackgroundScheduleSettings,
} from '../jobs/schedule-settings.ts'
import { type SchedulerSurface } from './background-scheduler-surface.ts'
import { createOwnerGuard } from './owner-guard.ts'

export interface BackgroundRoutesOptions {
  readonly identity: OwnerIdentity
  readonly database: Database
  readonly scheduler: BackgroundScheduler | SchedulerSurface
  readonly settings: BackgroundScheduleSettingsService
}

/**
 * The Owner's background-jobs surface: every job's current and last outcome,
 * a manual trigger that runs the same path the scheduler uses, and the
 * schedule settings that govern intervals and batch sizes.
 *
 * The HTTP contract only reads or triggers; the scheduler owns the
 * overlap-prevention claim so a manual click can never race a scheduled tick.
 */
export function createBackgroundRoutes({
  identity,
  database,
  scheduler,
  settings,
}: BackgroundRoutesOptions) {
  const guard = createOwnerGuard(identity)

  return new Elysia({ name: 'iroha/admin-background', prefix: '/api/v1/admin/background-jobs' }).guard(
    { as: 'local', detail: { security: [{ OwnerSession: [] }] } },
    (app) => app
      .onError({ as: 'scoped' }, ({ code, status }) => {
      if (code === 'VALIDATION' || code === 'PARSE') {
        return status(400, managementError('invalid_request', 'The request body could not be read.'))
      }

      return undefined
    })
    .get(
      '/',
      async ({ request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const records = await scheduler.listStatus()
        return status(200, { jobs: records.map(toJobDto) })
      },
      {
        detail: {
          summary: 'List background jobs',
          description:
            'Returns every scheduled background job, its current status, and the last completed run with timing, outcome, and structural error context.',
        },
        response: { 200: jobListResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    .get(
      '/:id',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const jobId = params.id
        if (!scheduler.jobIds().includes(jobId)) {
          return status(404, managementError('job_not_found', 'No such background job.'))
        }
        const record = await scheduler.status(jobId)
        if (record === null) {
          return status(200, emptyJob(jobId))
        }
        return status(200, toJobDto(record))
      },
      {
        detail: {
          summary: 'Inspect a background job',
          description:
            'Returns the current status and last completed run of one background job. The Owner can see whether the job is running, when it last ran, and what its last outcome was.',
        },
        response: { 200: jobResponse, 401: errorResponse, 403: errorResponse, 404: errorResponse },
      },
    )
    .post(
      '/:id/run',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const jobId = params.id
        if (!scheduler.jobIds().includes(jobId)) {
          return status(404, managementError('job_not_found', 'No such background job.'))
        }
        const record = await scheduler.trigger(jobId)
        if (record === null) {
          return status(409, managementError('job_in_flight', 'This job is already running.'))
        }
        return status(200, toJobDto(record))
      },
      {
        detail: {
          summary: 'Run a background job on demand',
          description:
            'Triggers one job through the same tryClaim path the scheduler uses; a running job cannot be triggered again until it has finished. The route blocks until the run completes so the response carries the terminal status.',
        },
        response: { 200: jobResponse, 401: errorResponse, 403: errorResponse, 404: errorResponse, 409: errorResponse },
      },
    )
    .get(
      '/settings',
      async ({ request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const current = await settings.read()
        return status(200, toScheduleDto(current))
      },
      {
        detail: {
          summary: 'Read background schedule settings',
          description:
            'Returns the per-job interval and batch sizes the scheduler will use on its next tick. Toggles take effect on the next tick without a restart.',
        },
        response: { 200: settingsResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    .put(
      '/settings',
      async ({ body, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        try {
          const stored = await settings.write(asObject(body))
          await database.audit.record({
            action: 'background.schedule.updated',
            outcome: 'success',
            detail: { schedule: stored },
            at: new Date(),
          })
          return status(200, toScheduleDto(stored))
        } catch (error) {
          if (error instanceof SettingsValidationError) {
            return status(400, {
              error: {
                code: 'validation_failed',
                message: 'The submitted schedule values are not acceptable.',
                problems: error.problems.map((problem) => ({
                  field: problem.field,
                  message: problem.message,
                })),
              },
            })
          }
          throw error
        }
      },
      {
        detail: {
          summary: 'Update background schedule settings',
          description:
            'Replaces the per-job interval and batch sizes. The scheduler reads the stored values at the start of every tick, so a successful write takes effect on the next tick.',
        },
        response: {
          200: settingsResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    )
    )
}

export type BackgroundRoutes = ReturnType<typeof createBackgroundRoutes>

const jobStatus = t.Union([
  t.Literal('idle'),
  t.Literal('running'),
  t.Literal('succeeded'),
  t.Literal('failed'),
])

const jobResponse = t.Object({
  jobId: t.String(),
  label: t.String(),
  status: jobStatus,
  lastStartedAt: t.Union([t.Null(), t.String()]),
  lastCompletedAt: t.Union([t.Null(), t.String()]),
  lastOutcome: t.Union([t.Null(), t.Union([t.Literal('success'), t.Literal('failure')])]),
  lastErrorCode: t.Union([t.Null(), t.String()]),
  lastErrorMessage: t.Union([t.Null(), t.String()]),
  lastDurationMs: t.Union([t.Null(), t.Number()]),
  lastAffectedCount: t.Union([t.Null(), t.Number()]),
  updatedAt: t.String(),
})

const jobListResponse = t.Object({ jobs: t.Array(jobResponse) })

const settingsResponse = t.Object({
  modelSync: t.Object({ intervalSeconds: t.Number() }),
  usage: t.Object({ intervalSeconds: t.Number() }),
  cooldownRecovery: t.Object({ intervalSeconds: t.Number() }),
  retentionCleanup: t.Object({
    intervalSeconds: t.Number(),
    requestBatchSize: t.Number(),
  }),
  sessionCleanup: t.Object({
    intervalSeconds: t.Number(),
    batchSize: t.Number(),
  }),
})

const errorResponse = t.Object({
  error: t.Object({
    code: t.String(),
    message: t.String(),
    problems: t.Optional(t.Array(t.Object({ field: t.String(), message: t.String() }))),
  }),
})

type ErrorDto = typeof errorResponse.static
type JobDto = typeof jobResponse.static
type SettingsDto = typeof settingsResponse.static

function toJobDto(record: {
  readonly jobId: string
  readonly lastStartedAt: Date | null
  readonly lastCompletedAt: Date | null
  readonly status: 'idle' | 'running' | 'succeeded' | 'failed'
  readonly lastOutcome: 'success' | 'failure' | null
  readonly lastErrorCode: string | null
  readonly lastErrorMessage: string | null
  readonly lastDurationMs: number | null
  readonly lastAffectedCount: number | null
  readonly updatedAt: Date
}): JobDto {
  return {
    jobId: record.jobId,
    label: labelFor(record.jobId),
    status: record.status,
    lastStartedAt: record.lastStartedAt?.toISOString() ?? null,
    lastCompletedAt: record.lastCompletedAt?.toISOString() ?? null,
    lastOutcome: record.lastOutcome,
    lastErrorCode: record.lastErrorCode,
    lastErrorMessage: record.lastErrorMessage,
    lastDurationMs: record.lastDurationMs,
    lastAffectedCount: record.lastAffectedCount,
    updatedAt: record.updatedAt.toISOString(),
  }
}

function toScheduleDto(settings: BackgroundScheduleSettings): SettingsDto {
  return {
    modelSync: { intervalSeconds: settings.modelSync.intervalSeconds },
    usage: { intervalSeconds: settings.usage.intervalSeconds },
    cooldownRecovery: { intervalSeconds: settings.cooldownRecovery.intervalSeconds },
    retentionCleanup: {
      intervalSeconds: settings.retentionCleanup.intervalSeconds,
      requestBatchSize: settings.retentionCleanup.requestBatchSize,
    },
    sessionCleanup: {
      intervalSeconds: settings.sessionCleanup.intervalSeconds,
      batchSize: settings.sessionCleanup.batchSize,
    },
  }
}

function labelFor(jobId: string): string {
  switch (jobId) {
    case 'model_sync':
      return 'Model catalog synchronization'
    case 'usage_poll':
      return 'Usage Adapter polling'
    case 'cooldown_recovery':
      return 'Cooldown recovery'
    case 'retention_cleanup':
      return 'Request-history retention'
    case 'session_cleanup':
      return 'Expired session cleanup'
    default:
      return jobId
  }
}

function toErrorDto(body: ManagementErrorLike): ErrorDto {
  const problems = body.error.problems
  return problems === undefined
    ? { error: { code: body.error.code, message: body.error.message } }
    : {
        error: {
          code: body.error.code,
          message: body.error.message,
          problems: problems.map((problem) => ({ field: problem.field, message: problem.message })),
        },
      }
}

function managementError(code: string, message: string): ErrorDto {
  return { error: { code, message } }
}

interface ManagementErrorLike {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly problems?: readonly { readonly field: string; readonly message: string } []
  }
}

function emptyJob(jobId: string): JobDto {
  return {
    jobId,
    label: labelFor(jobId),
    status: 'idle',
    lastStartedAt: null,
    lastCompletedAt: null,
    lastOutcome: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    lastDurationMs: null,
    lastAffectedCount: null,
    updatedAt: new Date(0).toISOString(),
  }
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}
