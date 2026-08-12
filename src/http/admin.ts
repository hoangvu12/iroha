import { Elysia, t } from 'elysia'
import type { OwnerIdentity } from '../identity/index.ts'
import {
  type ConnectionView,
  type KeyView,
  type ProviderConnectionRegistry,
  type ProviderFailure,
} from '../providers/index.ts'
import type {
  CreatedGatewayKey,
  GatewayKeyFailure,
  GatewayKeyRegistry,
  GatewayKeyView,
} from '../keys/index.ts'
import { createOwnerGuard, managementError, type ManagementError } from './owner-guard.ts'

export interface AdminRoutesOptions {
  readonly identity: OwnerIdentity
  readonly providers: ProviderConnectionRegistry
  readonly gatewayKeys: GatewayKeyRegistry
}

/**
 * The Owner's administration surface.
 *
 * Every route demands the Owner's session; every mutation also carries the
 * session's CSRF token. Request bodies are validated by the registry rather
 * than by route schemas: Elysia's validation report quotes the offending
 * value, and on these routes that value can be an Upstream Key. Responses are
 * typed and appear in the generated OpenAPI document.
 */
export function createAdminRoutes({ identity, providers, gatewayKeys }: AdminRoutesOptions) {
  const guard = createOwnerGuard(identity)

  return new Elysia({ name: 'iroha/admin', prefix: '/api/v1/admin' })
    .onError({ as: 'scoped' }, ({ code, status }) => {
      if (code === 'VALIDATION' || code === 'PARSE') {
        return status(400, managementError('invalid_request', 'The request body could not be read.'))
      }

      return undefined
    })
    .get(
      '/provider-connections',
      async ({ request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        return status(200, { connections: (await providers.list()).map(toConnectionDto) })
      },
      {
        detail: {
          summary: 'List Provider Connections',
          description:
            'Lists every Provider Connection, archived ones included. Upstream Key material is never listed; each key appears as its identity, health, and last test outcome.',
        },
        response: { 200: connectionListResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    .post(
      '/provider-connections',
      async ({ body, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const input = asObject(body)
        const result = await providers.create({
          displayName: input.displayName,
          baseUrl: input.baseUrl,
          upstreamKey: input.upstreamKey,
          allowInsecureHttp: input.allowInsecureHttp,
        })

        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(201, toConnectionDto(result.value))
      },
      {
        detail: {
          summary: 'Create a Provider Connection',
          description:
            'Creates one OpenAI-compatible Provider Connection with an immutable ID and one Upstream Key. The key is encrypted with the installation master key, saved as Unverified, and tested once with a low-cost probe; a usable test activates it, any other outcome keeps it with the reason.',
        },
        response: { 201: connectionResponse, ...errorResponses },
      },
    )
    .get(
      '/provider-connections/:id',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const view = await providers.get(params.id)
        if (view === null) {
          return status(404, adminError('connection_not_found', 'No such Provider Connection.'))
        }

        return status(200, toConnectionDto(view))
      },
      {
        detail: {
          summary: 'Inspect a Provider Connection',
          description:
            'Returns one Provider Connection with its Upstream Keys as identities, health, and last test outcomes. Key material is never returned.',
        },
        response: {
          200: connectionResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    )
    .patch(
      '/provider-connections/:id',
      async ({ params, body, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const input = asObject(body)
        const result = await providers.update(params.id, {
          ...('displayName' in input ? { displayName: input.displayName } : {}),
          ...('baseUrl' in input ? { baseUrl: input.baseUrl } : {}),
          ...('allowInsecureHttp' in input ? { allowInsecureHttp: input.allowInsecureHttp } : {}),
          ...('enabled' in input ? { enabled: input.enabled } : {}),
        })

        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toConnectionDto(result.value))
      },
      {
        detail: {
          summary: 'Edit a Provider Connection',
          description:
            'Changes the display name, base URL, insecure-HTTP exception, or enabled state of a live connection. The ID never changes, so client URLs stay valid.',
        },
        response: {
          200: connectionResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/provider-connections/:id/archive',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await providers.archive(params.id)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toConnectionDto(result.value))
      },
      {
        detail: {
          summary: 'Archive a Provider Connection',
          description:
            'Takes a connection out of active use while preserving its identity and history. Archived connections can still be duplicated or purged, and nothing else.',
        },
        response: {
          200: connectionResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/provider-connections/:id/duplicate',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await providers.duplicate(params.id)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(201, toConnectionDto(result.value))
      },
      {
        detail: {
          summary: 'Duplicate a Provider Connection',
          description:
            'Copies a connection under a new immutable ID without touching the original. Copied keys start Unverified again and are tested once.',
        },
        response: { 201: connectionResponse, ...errorResponses },
      },
    )
    .post(
      '/provider-connections/:id/purge',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await providers.purge(params.id)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(204, undefined)
      },
      {
        detail: {
          summary: 'Purge a Provider Connection',
          description:
            'Permanently deletes an archived connection and its Upstream Keys. Deletion is archive-first: a live connection must be archived before it can be purged, and there is no restore.',
        },
        response: {
          204: t.Void(),
          ...errorResponses,
        },
      },
    )
    .post(
      '/provider-connections/:id/keys/:keyId/test',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await providers.testKey(params.id, params.keyId)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toConnectionDto(result.value))
      },
      {
        detail: {
          summary: 'Test an Upstream Key',
          description:
            'Runs the low-cost key test on demand and records the outcome. A usable test activates an Unverified key; a Disabled key keeps its state.',
        },
        response: {
          200: connectionResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/provider-connections/:id/keys/:keyId/activate',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await providers.activateKey(params.id, params.keyId)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toConnectionDto(result.value))
      },
      {
        detail: {
          summary: 'Activate an Upstream Key',
          description:
            'Explicitly activates an Unverified or Disabled key, for when the test endpoint is unavailable but the Owner knows the key works.',
        },
        response: {
          200: connectionResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/provider-connections/:id/keys/:keyId/disable',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await providers.disableKey(params.id, params.keyId)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toConnectionDto(result.value))
      },
      {
        detail: {
          summary: 'Disable an Upstream Key',
          description: 'Takes a key out of use until the Owner activates it again.',
        },
        response: {
          200: connectionResponse,
          ...errorResponses,
        },
      },
    )
    .get(
      '/gateway-keys',
      async ({ request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        return status(200, { keys: (await gatewayKeys.list()).map(toGatewayKeyDto) })
      },
      {
        detail: {
          summary: 'List Gateway Keys',
          description:
            'Lists every Gateway Key with its name, creation and last-used times, scope, and revocation state. Secrets are never listed or stored in plaintext.',
        },
        response: { 200: gatewayKeyListResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    .post(
      '/gateway-keys',
      async ({ body, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const input = asObject(body)
        const result = await gatewayKeys.create({
          name: input.name,
          scope: input.scope,
        })

        if (!result.ok) {
          const failure = toGatewayKeyFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(201, toCreatedGatewayKeyDto(result.value))
      },
      {
        detail: {
          summary: 'Create a Gateway Key',
          description:
            'Issues a named application credential restricted to the requested Provider Connections and exact model IDs. The usable secret is returned exactly once; only its hash is stored.',
        },
        response: { 201: gatewayKeyCreatedResponse, ...errorResponses },
      },
    )
    .get(
      '/gateway-keys/:id',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const key = await gatewayKeys.get(params.id)
        if (key === null) {
          return status(404, adminError('gateway_key_not_found', 'No such Gateway Key.'))
        }

        return status(200, toGatewayKeyDto(key))
      },
      {
        detail: {
          summary: 'Inspect a Gateway Key',
          description:
            'Returns one Gateway Key with its metadata and scope. The usable secret was shown once at creation and is never returned again.',
        },
        response: {
          200: gatewayKeyResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    )
    .post(
      '/gateway-keys/:id/revoke',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await gatewayKeys.revoke(params.id)
        if (!result.ok) {
          const failure = toGatewayKeyFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toGatewayKeyDto(result.value))
      },
      {
        detail: {
          summary: 'Revoke a Gateway Key',
          description:
            'Ends an application credential permanently. The key stays listed with its metadata so the Owner can see what was revoked.',
        },
        response: {
          200: gatewayKeyResponse,
          ...errorResponses,
        },
      },
    )
}

export type AdminRoutes = ReturnType<typeof createAdminRoutes>

const probeVerdict = t.Union([t.Literal('usable'), t.Literal('rejected'), t.Literal('inconclusive')])
const keyHealth = t.Union([t.Literal('unverified'), t.Literal('active'), t.Literal('disabled')])

const keyResponse = t.Object({
  id: t.String(),
  health: keyHealth,
  lastProbe: t.Union([
    t.Null(),
    t.Object({
      at: t.String(),
      verdict: probeVerdict,
      reason: t.Union([t.Null(), t.String()]),
    }),
  ]),
  createdAt: t.String(),
  updatedAt: t.String(),
})

const connectionResponse = t.Object({
  id: t.String(),
  displayName: t.String(),
  baseUrl: t.String(),
  allowInsecureHttp: t.Boolean(),
  enabled: t.Boolean(),
  archived: t.Boolean(),
  createdAt: t.String(),
  updatedAt: t.String(),
  keys: t.Array(keyResponse),
})

const connectionListResponse = t.Object({ connections: t.Array(connectionResponse) })

const gatewayKeyScopeResponse = t.Object({
  connectionId: t.String(),
  models: t.Union([t.Null(), t.Array(t.String())]),
})

const gatewayKeyResponse = t.Object({
  id: t.String(),
  name: t.String(),
  scope: t.Array(gatewayKeyScopeResponse),
  createdAt: t.String(),
  lastUsedAt: t.Union([t.Null(), t.String()]),
  revoked: t.Boolean(),
})

/** The one response that carries the usable secret. Every later one omits it. */
const gatewayKeyCreatedResponse = t.Object({
  ...gatewayKeyResponse.properties,
  secret: t.String(),
})

const gatewayKeyListResponse = t.Object({ keys: t.Array(gatewayKeyResponse) })

const errorResponse = t.Object({
  error: t.Object({
    code: t.String(),
    message: t.String(),
    problems: t.Optional(t.Array(t.Object({ field: t.String(), message: t.String() }))),
  }),
})

/**
 * Every mutation can be refused by the session guard (401/403) and can surface
 * any registry failure (400/404/409/500). Declaring them once keeps the typed
 * responses honest and the OpenAPI document complete.
 */
const errorResponses = {
  400: errorResponse,
  401: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
  500: errorResponse,
}

type ConnectionDto = typeof connectionResponse.static
type KeyDto = typeof keyResponse.static
type ErrorDto = typeof errorResponse.static
type GatewayKeyDto = typeof gatewayKeyResponse.static

function toConnectionDto(view: ConnectionView): ConnectionDto {
  return {
    id: view.id,
    displayName: view.displayName,
    baseUrl: view.baseUrl,
    allowInsecureHttp: view.allowInsecureHttp,
    enabled: view.enabled,
    archived: view.archived,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    keys: view.keys.map(toKeyDto),
  }
}

function toKeyDto(key: KeyView): KeyDto {
  return {
    id: key.id,
    health: key.health,
    lastProbe:
      key.lastProbe === null
        ? null
        : {
            at: key.lastProbe.at.toISOString(),
            verdict: key.lastProbe.verdict,
            reason: key.lastProbe.reason,
          },
    createdAt: key.createdAt.toISOString(),
    updatedAt: key.updatedAt.toISOString(),
  }
}

function toGatewayKeyDto(key: GatewayKeyView): GatewayKeyDto {
  return {
    id: key.id,
    name: key.name,
    scope: key.scope.map((entry) => ({
      connectionId: entry.connectionId,
      models: entry.models === null ? null : [...entry.models],
    })),
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt === null ? null : key.lastUsedAt.toISOString(),
    revoked: key.revokedAt !== null,
  }
}

function toCreatedGatewayKeyDto(created: CreatedGatewayKey): typeof gatewayKeyCreatedResponse.static {
  return { ...toGatewayKeyDto(created.key), secret: created.secret }
}

function adminError(code: string, message: string): ErrorDto {
  return { error: { code, message } }
}

/** Copies the management envelope into the route's own typed error shape. */
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

function toFailure(failure: ProviderFailure): { statusCode: 400 | 404 | 409 | 500; body: ErrorDto } {
  switch (failure.code) {
    case 'connection_not_found':
      return { statusCode: 404, body: adminError('connection_not_found', 'No such Provider Connection.') }
    case 'key_not_found':
      return {
        statusCode: 404,
        body: adminError('key_not_found', 'No such Upstream Key on this connection.'),
      }
    case 'connection_archived':
      return {
        statusCode: 409,
        body: adminError(
          'connection_archived',
          'This connection is archived. Duplicate it to bring it back into use, or purge it.',
        ),
      }
    case 'not_archived':
      return {
        statusCode: 409,
        body: adminError(
          'not_archived',
          'Archive this connection first; purge only removes what is already out of active use.',
        ),
      }
    case 'stored_key_unreadable':
      return {
        statusCode: 500,
        body: adminError(
          'stored_key_unreadable',
          'A stored Upstream Key could not be read. The installation master key may have changed.',
        ),
      }
    case 'validation_failed':
      return { statusCode: 400, body: validationFailureBody(failure.problems) }
    // Registry failures that administrative routes cannot reach (for example
    // inference-only key resolution) stay stable rather than throwing.
    default:
      return {
        statusCode: 500,
        body: adminError('internal_error', 'The operation could not be completed.'),
      }
  }
}

function toGatewayKeyFailure(failure: GatewayKeyFailure): { statusCode: 400 | 404; body: ErrorDto } {
  switch (failure.code) {
    case 'gateway_key_not_found':
      return {
        statusCode: 404,
        body: adminError('gateway_key_not_found', 'No such Gateway Key.'),
      }
    case 'validation_failed':
      return { statusCode: 400, body: validationFailureBody(failure.problems) }
  }
}

/** The shared validation envelope, carrying field rules but never the values. */
function validationFailureBody(
  problems: readonly { readonly field: string; readonly message: string }[],
): ErrorDto {
  return {
    error: {
      code: 'validation_failed',
      message: 'The submitted values are not acceptable.',
      problems: problems.map((problem) => ({ field: problem.field, message: problem.message })),
    },
  }
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}
