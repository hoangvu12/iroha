import { Elysia, t } from 'elysia'
import type { OwnerIdentity } from '../identity/index.ts'
import type { UsageCapacityScope, UsageRecoveryEvidence } from '../usage/adapter.ts'
import {
  type UsageService,
  type UsageServiceFailure,
  type UsageView,
} from '../usage/index.ts'
import { createOwnerGuard } from './owner-guard.ts'

export interface UsageRoutesOptions {
  readonly identity: OwnerIdentity
  readonly usage: UsageService
}

/**
 * The Owner's Usage Adapter surface for one Provider: the last successful
 * normalized reading, freshness, the latest polling failure, and a manual
 * refresh action that drives the adapter once on demand. The route never
 * echoes secret material or free upstream text: failure messages are the
 * structural descriptions the service recorded.
 */
export function createUsageRoutes({ identity, usage }: UsageRoutesOptions) {
  const guard = createOwnerGuard(identity)

  return new Elysia({ name: 'iroha/usage', prefix: '/api/v1/admin/providers/:id' }).guard(
    { as: 'local', detail: { security: [{ OwnerSession: [] }] } },
    (app) => app
      .onError({ as: 'scoped' }, ({ code, status }) => {
      if (code === 'VALIDATION' || code === 'PARSE') {
        return status(400, managementError('invalid_request', 'The request body could not be read.'))
      }
      return undefined
    })
    .get(
      '/usage',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await usage.view(params.id)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }

        const recovery = await usage.recoveryEvidenceFor(params.id)
        return status(200, toUsageDto(result.value, recovery))
      },
      {
        detail: {
          tags: ['Usage'],
          summary: 'Inspect a Provider usage reading',
          description:
            'Returns the last successful Usage Adapter reading for one Provider, with freshness and the latest polling failure when one happened. The Owner sees Unknown honestly when the configured adapter is reactive-only.',
        },
        response: { 200: usageResponse, ...errorResponses },
      },
    )
    .post(
      '/usage/refresh',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await usage.refresh(params.id)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        const recovery = await usage.recoveryEvidenceFor(params.id)
        return status(200, toUsageDto(result.value, recovery))
      },
      {
        detail: {
          tags: ['Usage'],
          summary: 'Refresh a Provider usage reading',
          description:
            'Polls the configured Usage Adapter once and records the outcome. A failed poll retains the previous successful reading and only marks it stale.',
        },
        response: { 200: usageResponse, ...errorResponses },
      },
    )
    )
}

export type UsageRoutes = ReturnType<typeof createUsageRoutes>

const usageScope = t.Object({
  kind: t.Union([
    t.Literal('key'),
    t.Literal('account'),
    t.Literal('connection_model'),
    t.Literal('provider'),
    t.Literal('unknown'),
  ]),
  keyId: t.Optional(t.String()),
  accountId: t.Optional(t.String()),
  model: t.Optional(t.String()),
})

const usageReading = t.Object({
  unit: t.String(),
  balance: t.Union([t.Null(), t.Number()]),
  used: t.Union([t.Null(), t.Number()]),
  limit: t.Union([t.Null(), t.Number()]),
  resetAt: t.Union([t.Null(), t.String()]),
  scope: usageScope,
  confidence: t.Union([t.Literal('confirmed'), t.Literal('unknown')]),
  diagnostics: t.Object({}, { additionalProperties: true }),
})

const usageResponse = t.Object({
  visibility: t.Union([t.Literal('reactive_only'), t.Literal('authoritative')]),
  reading: t.Union([t.Null(), usageReading]),
  syncedAt: t.Union([t.Null(), t.String()]),
  lastSuccessAt: t.Union([t.Null(), t.String()]),
  lastFailureAt: t.Union([t.Null(), t.String()]),
  lastFailureCode: t.Union([t.Null(), t.String()]),
  lastFailureMessage: t.Union([t.Null(), t.String()]),
  stale: t.Boolean(),
  nextPollAllowedAt: t.Union([t.Null(), t.String()]),
  recovery: t.Union([
    t.Null(),
    t.Object({
      authoritative: t.Boolean(),
      hasCapacity: t.Boolean(),
      scope: usageScope,
      takenAt: t.String(),
    }),
  ]),
})

const errorResponse = t.Object({
  error: t.Object({
    code: t.String(),
    message: t.String(),
    problems: t.Optional(t.Array(t.Object({ field: t.String(), message: t.String() }))),
  }),
})

const errorResponses = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  429: errorResponse,
  500: errorResponse,
}

type ErrorDto = typeof errorResponse.static
type UsageDto = typeof usageResponse.static

function toUsageDto(view: UsageView, recovery: UsageRecoveryEvidence | null): UsageDto {
  return {
    visibility: view.visibility,
    reading: view.reading === null
      ? null
      : {
          unit: view.reading.unit,
          balance: view.reading.balance,
          used: view.reading.used,
          limit: view.reading.limit,
          resetAt: view.reading.resetAt?.toISOString() ?? null,
          scope: toScopeDto(view.reading.scope),
          confidence: view.reading.confidence,
          diagnostics: { ...view.reading.diagnostics },
        },
    syncedAt: view.syncedAt?.toISOString() ?? null,
    lastSuccessAt: view.lastSuccessAt?.toISOString() ?? null,
    lastFailureAt: view.lastFailureAt?.toISOString() ?? null,
    lastFailureCode: view.lastFailureCode,
    lastFailureMessage: view.lastFailureMessage,
    stale: view.stale,
    nextPollAllowedAt: view.nextPollAllowedAt?.toISOString() ?? null,
    recovery: recovery === null ? null : toRecoveryDto(recovery),
  }
}

function toRecoveryDto(recovery: UsageRecoveryEvidence): {
  authoritative: boolean
  hasCapacity: boolean
  scope: ReturnType<typeof toScopeDto>
  takenAt: string
} {
  return {
    authoritative: recovery.authoritative,
    hasCapacity: recovery.hasCapacity,
    scope: toScopeDto(recovery.scope),
    takenAt: recovery.at.toISOString(),
  }
}

function toScopeDto(scope: UsageCapacityScope): {
  kind: 'key' | 'account' | 'connection_model' | 'provider' | 'unknown'
  keyId?: string
  accountId?: string
  model?: string
} {
  const dto: {
    kind: 'key' | 'account' | 'connection_model' | 'provider' | 'unknown'
    keyId?: string
    accountId?: string
    model?: string
  } = { kind: scope.kind }
  if (scope.kind === 'key') dto.keyId = scope.keyId
  if (scope.kind === 'account') dto.accountId = scope.accountId
  if (scope.kind === 'connection_model') dto.model = scope.model
  return dto
}

function toFailure(failure: UsageServiceFailure): { statusCode: 400 | 404 | 409 | 429 | 500; body: ErrorDto } {
  switch (failure.code) {
    case 'provider_not_found':
      return {
        statusCode: 404,
        body: managementError('provider_not_found', 'No such Provider.'),
      }
    case 'provider_archived':
      return {
        statusCode: 409,
        body: managementError(
          'provider_archived',
          'This Provider is archived. Duplicate it to manage its usage.',
        ),
      }
    case 'provider_disabled':
      return {
        statusCode: 409,
        body: managementError('provider_disabled', 'This Provider is disabled.'),
      }
    case 'no_eligible_key':
      return {
        statusCode: 409,
        body: managementError(
          'no_eligible_key',
          'No Upstream Key on this Provider is usable for entitlement polling.',
        ),
      }
    case 'stored_key_unreadable':
      return {
        statusCode: 500,
        body: managementError(
          'stored_key_unreadable',
          'A stored Upstream Key could not be read. The installation master key may have changed.',
        ),
      }
    case 'rate_limited':
      return {
        statusCode: 429,
        body: managementError(
          'rate_limited',
          'The Provider rate-limited the entitlement poll.',
        ),
      }
  }
}

function managementError(code: string, message: string): ErrorDto {
  return { error: { code, message } }
}

function toErrorDto(body: { error: { code: string; message: string; problems?: readonly { field: string; message: string }[] } }): ErrorDto {
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
