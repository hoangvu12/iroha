import { Elysia, t } from 'elysia'
import type { Database } from '../persistence/index.ts'
import type { OwnerIdentity } from '../identity/index.ts'
import { createOwnerGuard, type ManagementError } from './owner-guard.ts'

export interface AuditRoutesOptions {
  readonly identity: OwnerIdentity
  readonly database: Database
}

/**
 * The Owner's audit feed: every administrative change lives here until the
 * Owner explicitly clears it. The list supports pagination and the same kind
 * of filtering the request history exposes; the clear action wipes the feed
 * entirely and records the act of wiping.
 */
export function createAuditRoutes({ identity, database }: AuditRoutesOptions) {
  const guard = createOwnerGuard(identity)

  return new Elysia({ name: 'iroha/admin-audit', prefix: '/api/v1/admin/audit' }).guard(
    { as: 'local', detail: { security: [{ OwnerSession: [] }] } },
    (app) => app
      .get(
      '/',
      async ({ request, query, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const parsed = parseAuditQuery(query)
        if ('response' in parsed) {
          return status(400, toErrorDto(parsed.response))
        }

        const result = await database.requestHistory.listAudit(
          parsed.value.filter === undefined
            ? {}
            : { filter: parsed.value.filter, ...(parsed.value.limit === undefined ? {} : { limit: parsed.value.limit }), ...(parsed.value.offset === undefined ? {} : { offset: parsed.value.offset }) },
        )

        return status(200, {
          events: result.events.map(toAuditDto),
          total: result.total,
        })
      },
      {
        detail: {
          tags: ['Audit'],
          summary: 'List audit events',
          description:
            'Lists every recorded administrative event with the action, outcome, structured detail, and timestamp. Entries remain until the Owner explicitly clears the feed.',
        },
        response: { 200: auditListResponse, 400: errorResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    .delete(
      '/',
      async ({ request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const removed = await database.requestHistory.clearAudit()
        await database.audit.record({
          action: 'audit.cleared',
          outcome: 'success',
          detail: { removed },
          at: new Date(),
        })

        return status(200, { removed })
      },
      {
        detail: {
          tags: ['Audit'],
          summary: 'Clear the audit feed',
          description:
            'Removes every recorded audit event and records the act of clearing. Request history is unaffected.',
        },
        response: { 200: clearResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    )
}

export type AuditRoutes = ReturnType<typeof createAuditRoutes>

const auditEntry = t.Object({
  id: t.Number(),
  occurredAt: t.String(),
  action: t.String(),
  outcome: t.Union([t.Literal('success'), t.Literal('failure')]),
  detail: t.Union([t.Null(), t.Unknown()]),
})

const auditListResponse = t.Object({
  events: t.Array(auditEntry),
  total: t.Number(),
})

const clearResponse = t.Object({ removed: t.Number() })

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

type AuditEntryDto = typeof auditEntry.static

function toAuditDto(event: { id: number; occurredAt: Date; action: string; outcome: 'success' | 'failure'; detail: unknown }): AuditEntryDto {
  return {
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    action: event.action,
    outcome: event.outcome,
    detail: event.detail === undefined ? null : event.detail,
  }
}

function parseAuditQuery(query: Record<string, unknown>):
  | { readonly value: { readonly filter: { readonly actionPrefix?: string; readonly outcome?: 'success' | 'failure' }; readonly limit?: number; readonly offset?: number } }
  | { readonly response: ManagementError } {
  const filter: { actionPrefix?: string; outcome?: 'success' | 'failure' } = {}
  if (typeof query.actionPrefix === 'string' && query.actionPrefix !== '') {
    filter.actionPrefix = query.actionPrefix
  }
  if (query.outcome === 'success' || query.outcome === 'failure') {
    filter.outcome = query.outcome
  }

  const limit = readInteger(query.limit)
  const offset = readInteger(query.offset)
  if (limit === 'invalid' || offset === 'invalid') {
    return {
      response: managementError('invalid_request', 'limit and offset must be non-negative integers.'),
    }
  }

  const value: { filter: typeof filter; limit?: number; offset?: number } = { filter }
  if (limit !== null) value.limit = limit
  if (offset !== null) value.offset = offset

  return { value }
}

function readInteger(value: unknown): number | null | 'invalid' {
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 'invalid'
  return Number(value)
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