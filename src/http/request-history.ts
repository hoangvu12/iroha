import { Elysia, t } from 'elysia'
import type { RequestHistoryService } from '../history/index.ts'
import type { OwnerIdentity } from '../identity/index.ts'
import type { RequestHistoryFilter, RequestHistoryListOptions } from '../persistence/index.ts'
import { createOwnerGuard, type ManagementError } from './owner-guard.ts'

export interface RequestHistoryRoutesOptions {
  readonly identity: OwnerIdentity
  readonly requestHistory: RequestHistoryService
}

/**
 * The Owner's read-only view of inference metadata: a filterable, paginated
 * list of recent calls plus a per-call detail with the retry trail. Nothing
 * here exposes prompts, responses, or Upstream Key material.
 */
export function createRequestHistoryRoutes({ identity, requestHistory }: RequestHistoryRoutesOptions) {
  const guard = createOwnerGuard(identity)

  return new Elysia({ name: 'iroha/admin-request-history', prefix: '/api/v1/admin/requests' }).guard(
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

        const parsed = parseListQuery(query)
        if ('response' in parsed) {
          return status(400, toErrorDto(parsed.response))
        }

        const result = await requestHistory.listEvents(parsed.value)
        return status(200, {
          events: result.events.map(toEventDto),
          total: result.total,
        })
      },
      {
        detail: {
          tags: ['Request History'],
          summary: 'List request history',
          description:
            'Lists recent inference calls with their connection, model, selected key identity, status, latency, and Provider-supplied usage. No prompts, responses, or Upstream Key material.',
        },
        response: {
          200: listResponse,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
        },
      },
    )
    .get(
      '/:id',
      async ({ request, params, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const event = await requestHistory.getEvent(params.id)
        if (event === null) {
          return status(404, managementError('request_not_found', 'No such request.'))
        }

        const attempts = await requestHistory.getAttempts(params.id)
        return status(200, {
          event: toEventDto(event),
          attempts: attempts.map(toAttemptDto),
        })
      },
      {
        detail: {
          tags: ['Request History'],
          summary: 'Inspect a request',
          description:
            'Returns one inference call with every attempt in order, showing which Upstream Key each one tried, the resulting status, and any retry decision.',
        },
        response: {
          200: detailResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    )
    )
}

export type RequestHistoryRoutes = ReturnType<typeof createRequestHistoryRoutes>

const eventDto = t.Object({
  id: t.String(),
  occurredAt: t.String(),
  providerId: t.String(),
  model: t.String(),
  gatewayKeyId: t.Union([t.Null(), t.String()]),
  keyId: t.Union([t.Null(), t.String()]),
  status: t.Number(),
  outcome: t.Union([t.Literal('success'), t.Literal('failure')]),
  latencyMs: t.Number(),
  isStreaming: t.Boolean(),
  promptTokens: t.Union([t.Null(), t.Number()]),
  completionTokens: t.Union([t.Null(), t.Number()]),
  totalTokens: t.Union([t.Null(), t.Number()]),
  errorCode: t.Union([t.Null(), t.String()]),
})

const attemptDto = t.Object({
  id: t.Number(),
  attemptNumber: t.Number(),
  keyId: t.Union([t.Null(), t.String()]),
  startedAt: t.String(),
  completedAt: t.Union([t.Null(), t.String()]),
  status: t.Union([t.Null(), t.Number()]),
  outcome: t.Union([t.Literal('success'), t.Literal('failure'), t.Literal('skipped')]),
  errorCode: t.Union([t.Null(), t.String()]),
  retryAfterSeconds: t.Union([t.Null(), t.Number()]),
})

const listResponse = t.Object({
  events: t.Array(eventDto),
  total: t.Number(),
})

const detailResponse = t.Object({
  event: eventDto,
  attempts: t.Array(attemptDto),
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

type EventDto = typeof eventDto.static
type AttemptDto = typeof attemptDto.static

function toEventDto(event: {
  id: string
  occurredAt: Date
  providerId: string
  model: string
  gatewayKeyId: string | null
  keyId: string | null
  status: number
  outcome: 'success' | 'failure'
  latencyMs: number
  isStreaming: boolean
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  errorCode: string | null
}): EventDto {
  return {
    id: event.id,
    occurredAt: event.occurredAt.toISOString(),
    providerId: event.providerId,
    model: event.model,
    gatewayKeyId: event.gatewayKeyId,
    keyId: event.keyId,
    status: event.status,
    outcome: event.outcome,
    latencyMs: event.latencyMs,
    isStreaming: event.isStreaming,
    promptTokens: event.promptTokens,
    completionTokens: event.completionTokens,
    totalTokens: event.totalTokens,
    errorCode: event.errorCode,
  }
}

function toAttemptDto(attempt: {
  id: number
  attemptNumber: number
  keyId: string | null
  startedAt: Date
  completedAt: Date | null
  status: number | null
  outcome: 'success' | 'failure' | 'skipped'
  errorCode: string | null
  retryAfterSeconds: number | null
}): AttemptDto {
  return {
    id: attempt.id,
    attemptNumber: attempt.attemptNumber,
    keyId: attempt.keyId,
    startedAt: attempt.startedAt.toISOString(),
    completedAt: attempt.completedAt === null ? null : attempt.completedAt.toISOString(),
    status: attempt.status,
    outcome: attempt.outcome,
    errorCode: attempt.errorCode,
    retryAfterSeconds: attempt.retryAfterSeconds,
  }
}

function parseListQuery(query: Record<string, unknown>):
  | { readonly value: RequestHistoryListOptions }
  | { readonly response: ManagementError } {
  const filter: {
    providerId?: string
    outcome?: 'success' | 'failure'
    model?: string
    keyId?: string
  } = {}
  if (typeof query.providerId === 'string' && query.providerId !== '') {
    filter.providerId = query.providerId
  }
  if (query.outcome === 'success' || query.outcome === 'failure') {
    filter.outcome = query.outcome
  }
  if (typeof query.model === 'string' && query.model !== '') {
    filter.model = query.model
  }
  if (typeof query.keyId === 'string' && query.keyId !== '') {
    filter.keyId = query.keyId
  }

  const readonlyFilter: RequestHistoryFilter = filter

  const limit = readInteger(query.limit, 200)
  const offset = readInteger(query.offset, Number.MAX_SAFE_INTEGER)
  if (limit === 'invalid') {
    return { response: managementError('invalid_request', 'limit must be a non-negative integer.') }
  }
  if (offset === 'invalid') {
    return { response: managementError('invalid_request', 'offset must be a non-negative integer.') }
  }

  const value: RequestHistoryListOptions = {
    ...(Object.keys(filter).length === 0 ? {} : { filter: readonlyFilter }),
    ...(limit === null ? {} : { limit }),
    ...(offset === null ? {} : { offset }),
  }

  return { value }
}

function readInteger(value: unknown, max: number): number | null | 'invalid' {
  if (value === undefined) return null
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 'invalid'
  const parsed = Number(value)
  if (parsed > max) return max
  return parsed
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