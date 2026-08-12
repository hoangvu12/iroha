import { Elysia, t } from 'elysia'
import type { Database } from '../persistence/index.ts'
import type { RequestHistoryService } from '../history/index.ts'
import type { OwnerIdentity } from '../identity/index.ts'
import { createOwnerGuard, type ManagementError } from './owner-guard.ts'

export interface SettingsRoutesOptions {
  readonly identity: OwnerIdentity
  readonly requestHistory: RequestHistoryService
  readonly database: Database
}

/**
 * The Owner's write surface for Iroha-wide settings. Version one covers
 * request-history retention: the Owner chooses how long inference metadata
 * is kept, or disables it entirely.
 */
export function createSettingsRoutes({ identity, requestHistory, database }: SettingsRoutesOptions) {
  const guard = createOwnerGuard(identity)

  return new Elysia({ name: 'iroha/admin-settings', prefix: '/api/v1/admin/settings' }).guard(
    { as: 'local', detail: { security: [{ OwnerSession: [] }] } },
    (app) => app
      .get(
      '/request-history',
      async ({ request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const retention = await requestHistory.readRetention()
        return status(200, toRetentionDto(retention))
      },
      {
        detail: {
          summary: 'Read request-history retention',
          description:
            'Returns the configured retention window. Zero days means history is disabled.',
        },
        response: { 200: retentionResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    .put(
      '/request-history',
      async ({ body, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const input = asObject(body)
        if (typeof input.days !== 'number' || !Number.isFinite(input.days) || input.days < 0 || !Number.isInteger(input.days)) {
          return status(400, managementError('invalid_request', 'days must be a non-negative integer.'))
        }

        const stored = await requestHistory.writeRetention({ days: input.days })
        await database.audit.record({
          action: 'settings.request_history.updated',
          outcome: 'success',
          detail: { days: stored.days },
          at: new Date(),
        })

        return status(200, toRetentionDto(stored))
      },
      {
        detail: {
          summary: 'Update request-history retention',
          description:
            'Sets how long inference metadata is kept. Zero days disables storage entirely; the next inference call writes no event or attempt rows.',
        },
        response: {
          200: retentionResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    )
    )
}

export type SettingsRoutes = ReturnType<typeof createSettingsRoutes>

const retentionResponse = t.Object({
  days: t.Number(),
  /** True when the configured days value keeps rows; false when storage is off. */
  enabled: t.Boolean(),
})

const errorResponse = t.Object({
  error: t.Object({
    code: t.String(),
    message: t.String(),
    problems: t.Optional(t.Array(t.Object({ field: t.String(), message: t.String() }))),
  }),
})

type ErrorDto = typeof errorResponse.static

function managementError(code: string, message: string): ErrorDto {
  return { error: { code, message } }
}

type RetentionDto = typeof retentionResponse.static

function toRetentionDto(retention: { days: number }): RetentionDto {
  return { days: retention.days, enabled: retention.days > 0 }
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

function toErrorDto(body: ManagementError): ErrorDto {
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