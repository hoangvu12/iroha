import { Elysia, t } from 'elysia'
import type { OwnerIdentity } from '../identity/index.ts'
import type {
  CatalogView,
  ModelCatalogFailure,
  ModelCatalogService,
} from '../models/index.ts'
import { createOwnerGuard } from './owner-guard.ts'

export interface CatalogRoutesOptions {
  readonly identity: OwnerIdentity
  readonly modelCatalog: ModelCatalogService
}

/**
 * The Owner's model catalog surface for one Provider Connection: the last
 * synchronization outcome with provenance and freshness, an explicit refresh
 * action, and Owner edits that discovery must respect (additions, exclusions,
 * and capability overrides). Bodies are validated by the service rather than
 * by route schemas, matching the other admin surfaces.
 */
export function createCatalogRoutes({ identity, modelCatalog }: CatalogRoutesOptions) {
  const guard = createOwnerGuard(identity)

  return new Elysia({ name: 'iroha/catalog', prefix: '/api/v1/admin/provider-connections/:id' }).guard(
    { as: 'local', detail: { security: [{ OwnerSession: [] }] } },
    (app) => app
      .onError({ as: 'scoped' }, ({ code, status }) => {
      if (code === 'VALIDATION' || code === 'PARSE') {
        return status(400, managementError('invalid_request', 'The request body could not be read.'))
      }

      return undefined
    })
    .get(
      '/catalog',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await modelCatalog.view(params.id)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toCatalogDto(result.value))
      },
      {
        detail: {
          tags: ['Catalog'],
          summary: 'Inspect a connection model catalog',
          description:
            'Returns every catalogued model of one Provider Connection with its provenance (discovered, template, owner-added, or excluded), exclusion state, capability overrides, and the last synchronization outcome.',
        },
        response: { 200: catalogResponse, ...errorResponses },
      },
    )
    .post(
      '/catalog/refresh',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await modelCatalog.refresh(params.id)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toCatalogDto(result.value))
      },
      {
        detail: {
          tags: ['Catalog'],
          summary: 'Refresh a model catalog',
          description:
            'Re-runs the low-cost discovery GET against the connection and merges the result. A failed refresh retains the last successful catalog, records the failure, and marks the catalog stale.',
        },
        response: { 200: catalogResponse, ...errorResponses },
      },
    )
    .post(
      '/catalog/models',
      async ({ params, body, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const input = asObject(body)
        const result = await modelCatalog.addOwnerModel(params.id, input.modelId)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toCatalogDto(result.value))
      },
      {
        detail: {
          tags: ['Catalog'],
          summary: 'Add an Owner model',
          description:
            'Names a model the Owner vouches for on this connection. It is added as owner-added and survives discovery even if the Provider never reports it.',
        },
        response: { 200: catalogResponse, ...errorResponses },
      },
    )
    .patch(
      '/catalog/models/:modelId',
      async ({ params, body, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const input = asObject(body)
        const result =
          'excluded' in input
            ? await modelCatalog.setExcluded(params.id, params.modelId, input.excluded === true)
            : await modelCatalog.updateOverrides(params.id, params.modelId, input.overrides)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toCatalogDto(result.value))
      },
      {
        detail: {
          tags: ['Catalog'],
          summary: 'Exclude a model or replace its overrides',
          description:
            'Blocks a model (it stays listed but joins nothing), unblocks it, or replaces its per-model capability overrides. An unknown model edited this way becomes owner-added.',
        },
        response: { 200: catalogResponse, ...errorResponses },
      },
    )
    .delete(
      '/catalog/models/:modelId',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await modelCatalog.removeOwnerModel(params.id, params.modelId)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toCatalogDto(result.value))
      },
      {
        detail: {
          tags: ['Catalog'],
          summary: 'Remove an Owner model',
          description:
            'Removes a model the Owner added. Discovered and template models are not affected.',
        },
        response: { 200: catalogResponse, ...errorResponses },
      },
    )
    )
}

export type CatalogRoutes = ReturnType<typeof createCatalogRoutes>

const capabilityOverrides = t.Object({
  chat: t.Optional(t.Boolean()),
  streaming: t.Optional(t.Boolean()),
  tools: t.Optional(t.Boolean()),
  structuredOutput: t.Optional(t.Boolean()),
  responses: t.Optional(t.Boolean()),
})

const catalogEntryResponse = t.Object({
  modelId: t.String(),
  source: t.Union([t.Literal('discovered'), t.Literal('template'), t.Literal('owner_added'), t.Literal('excluded')]),
  excluded: t.Boolean(),
  overrides: t.Union([t.Null(), capabilityOverrides]),
  updatedAt: t.String(),
})

const catalogSyncResponse = t.Object({
  syncedAt: t.Union([t.Null(), t.String()]),
  lastSuccessAt: t.Union([t.Null(), t.String()]),
  lastFailureAt: t.Union([t.Null(), t.String()]),
  lastFailureMessage: t.Union([t.Null(), t.String()]),
  stale: t.Boolean(),
})

const catalogResponse = t.Object({
  sync: catalogSyncResponse,
  entries: t.Array(catalogEntryResponse),
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
  500: errorResponse,
}

type ErrorDto = typeof errorResponse.static
type CatalogDto = typeof catalogResponse.static

function toCatalogDto(view: CatalogView): CatalogDto {
  return {
    sync: {
      syncedAt: view.sync.syncedAt?.toISOString() ?? null,
      lastSuccessAt: view.sync.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: view.sync.lastFailureAt?.toISOString() ?? null,
      lastFailureMessage: view.sync.lastFailureMessage,
      stale: view.sync.stale,
    },
    entries: view.entries.map((entry) => ({
      modelId: entry.modelId,
      source: entry.source,
      excluded: entry.excluded,
      overrides: entry.overrides === null ? null : { ...entry.overrides },
      updatedAt: entry.updatedAt.toISOString(),
    })),
  }
}

function toFailure(failure: ModelCatalogFailure): { statusCode: 400 | 404 | 409 | 500; body: ErrorDto } {
  switch (failure.code) {
    case 'provider_not_found':
      return { statusCode: 404, body: managementError('provider_not_found', 'No such Provider.') }
    case 'provider_archived':
      return {
        statusCode: 409,
        body: managementError(
          'provider_archived',
          'This Provider is archived. Duplicate it to manage its catalog.',
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
          'No Upstream Key on this Provider is usable for model discovery.',
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
    case 'validation_failed':
      return {
        statusCode: 400,
        body: {
          error: {
            code: 'validation_failed',
            message: 'The submitted values are not acceptable.',
            problems: failure.problems.map((problem) => ({ field: problem.field, message: problem.message })),
          },
        },
      }
    default:
      return {
        statusCode: 500,
        body: managementError('internal_error', 'The operation could not be completed.'),
      }
  }
}

function managementError(code: string, message: string): ErrorDto {
  return { error: { code, message } }
}

/** Copies the management envelope into the route's own typed error shape. */
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

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}
