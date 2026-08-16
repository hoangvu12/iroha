import { Elysia, t } from 'elysia'
import type { OwnerIdentity } from '../identity/index.ts'
import {
  type KeyView,
  type ProviderFailure,
  type ProviderRegistry,
  type ProviderTemplate,
  type ProviderView,
  type UpstreamAccountView,
} from '../providers/index.ts'
import type { AdapterRegistry } from '../providers/adapter-registry.ts'
import type {
  CreatedGatewayKey,
  GatewayKeyFailure,
  GatewayKeyRegistry,
  GatewayKeyView,
} from '../keys/index.ts'
import { createOwnerGuard, managementError, type ManagementError } from './owner-guard.ts'

export interface AdminRoutesOptions {
  readonly identity: OwnerIdentity
  readonly providers: ProviderRegistry
  readonly gatewayKeys: GatewayKeyRegistry
  /**
   * The Adapter Registry that supplies the Provider Templates the Owner
   * may seed a new Provider from. Required: the picker and the template
   * validation are two sides of the same registry, and skipping it would
   * leave the picker empty without the Owner noticing.
   */
  readonly adapterRegistry: AdapterRegistry
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
export function createAdminRoutes({
  identity,
  providers,
  gatewayKeys,
  adapterRegistry,
}: AdminRoutesOptions) {
  const guard = createOwnerGuard(identity)

  return new Elysia({ name: 'iroha/admin', prefix: '/api/v1/admin' }).guard(
    { as: 'local', detail: { security: [{ OwnerSession: [] }] } },
    (app) => app
      .onError({ as: 'scoped' }, ({ code, status }) => {
      if (code === 'VALIDATION' || code === 'PARSE') {
        return status(400, managementError('invalid_request', 'The request body could not be read.'))
      }

      return undefined
    })
    .get(
      '/providers',
      async ({ request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        return status(200, { providers: (await providers.listProviders()).map(toProviderDto) })
      },
      {
        detail: {
          tags: ['Providers'],
          summary: 'List Providers',
          description:
            'Lists every Provider, archived ones included. Upstream Key material is never listed; each key appears as its identity, health, and last test outcome.',
        },
        response: { 200: providerListResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    .get(
      '/provider-templates',
      async ({ request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        return status(200, { templates: adapterRegistry.listProviderTemplates().map(toTemplateDto) })
      },
      {
        detail: {
          tags: ['Provider Templates'],
          summary: 'List built-in Provider Templates',
          description:
            'Lists the Provider Templates Iroha ships with. Each one carries safe defaults the Owner may override; the template never contains an account, secret, or per-tenant URL.',
        },
        response: { 200: templateListResponse, 401: errorResponse, 403: errorResponse },
      },
    )
    .post(
      '/providers',
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
          keys: input.keys,
          ...('templateId' in input ? { templateId: input.templateId } : {}),
          allowInsecureHttp: input.allowInsecureHttp,
          ...('authHeader' in input ? { authHeader: input.authHeader } : {}),
          ...('authPrefix' in input ? { authPrefix: input.authPrefix } : {}),
          ...('staticHeaders' in input ? { staticHeaders: input.staticHeaders } : {}),
          ...('redirectAllowSameOrigin' in input
            ? { redirectAllowSameOrigin: input.redirectAllowSameOrigin }
            : {}),
          ...('connectionTimeoutMs' in input
            ? { connectionTimeoutMs: input.connectionTimeoutMs }
            : {}),
          ...('firstByteTimeoutMs' in input ? { firstByteTimeoutMs: input.firstByteTimeoutMs } : {}),
          ...('nonStreamingTotalTimeoutMs' in input
            ? { nonStreamingTotalTimeoutMs: input.nonStreamingTotalTimeoutMs }
            : {}),
          ...('streamingIdleTimeoutMs' in input
            ? { streamingIdleTimeoutMs: input.streamingIdleTimeoutMs }
            : {}),
          ...('totalRetryTimeoutMs' in input ? { totalRetryTimeoutMs: input.totalRetryTimeoutMs } : {}),
          ...('idempotencyHeader' in input ? { idempotencyHeader: input.idempotencyHeader } : {}),
        })

        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(201, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Providers'],
          summary: 'Create a Provider',
          description:
            "Creates one OpenAI-compatible Provider with an immutable ID and one or more Upstream Keys. Each key is encrypted with the installation master key, saved as Unverified, and tested once with a low-cost probe; a usable test activates it, any other outcome keeps the key with the reason. Each key may carry an optional `baseUrl` override; when omitted the key inherits the Provider's default. Supplying a templateId prefills safe defaults; omitting it seeds the Generic OpenAI-compatible default; the Owner may override every field.",
        },
        response: { 201: providerResponse, ...errorResponses },
      },
    )
    .get(
      '/providers/:id',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const view = await providers.getProvider(params.id)
        if (view === null) {
          return status(404, adminError('provider_not_found', 'No such Provider.'))
        }

        return status(200, toProviderDto(view))
      },
      {
        detail: {
          tags: ['Providers'],
          summary: 'Inspect a Provider',
          description:
            'Returns one Provider with its Upstream Keys as identities, health, and last test outcomes. Key material is never returned.',
        },
        response: {
          200: providerResponse,
          401: errorResponse,
          403: errorResponse,
          404: errorResponse,
        },
      },
    )
    .patch(
      '/providers/:id',
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
          ...('retryMaxAttempts' in input ? { retryMaxAttempts: input.retryMaxAttempts } : {}),
          ...('retryAmbiguousNetwork' in input
            ? { retryAmbiguousNetwork: input.retryAmbiguousNetwork }
            : {}),
          ...('authHeader' in input ? { authHeader: input.authHeader } : {}),
          ...('authPrefix' in input ? { authPrefix: input.authPrefix } : {}),
          ...('staticHeaders' in input ? { staticHeaders: input.staticHeaders } : {}),
          ...('redirectAllowSameOrigin' in input
            ? { redirectAllowSameOrigin: input.redirectAllowSameOrigin }
            : {}),
          ...('connectionTimeoutMs' in input
            ? { connectionTimeoutMs: input.connectionTimeoutMs }
            : {}),
          ...('firstByteTimeoutMs' in input ? { firstByteTimeoutMs: input.firstByteTimeoutMs } : {}),
          ...('nonStreamingTotalTimeoutMs' in input
            ? { nonStreamingTotalTimeoutMs: input.nonStreamingTotalTimeoutMs }
            : {}),
          ...('streamingIdleTimeoutMs' in input
            ? { streamingIdleTimeoutMs: input.streamingIdleTimeoutMs }
            : {}),
          ...('totalRetryTimeoutMs' in input ? { totalRetryTimeoutMs: input.totalRetryTimeoutMs } : {}),
          ...('idempotencyHeader' in input ? { idempotencyHeader: input.idempotencyHeader } : {}),
        })

        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Providers'],
          summary: 'Edit a Provider',
          description:
            'Changes the display name, base URL, insecure-HTTP exception, or enabled state of a live Provider. The ID never changes, so client URLs stay valid.',
        },
        response: {
          200: providerResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/providers/:id/archive',
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
        return status(200, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Providers'],
          summary: 'Archive a Provider',
          description:
            'Takes a Provider out of active use while preserving its identity and history. Archived Providers can still be duplicated or purged, and nothing else.',
        },
        response: {
          200: providerResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/providers/:id/duplicate',
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
        return status(201, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Providers'],
          summary: 'Duplicate a Provider',
          description:
            'Copies a Provider under a new immutable ID without touching the original. Copied keys start Unverified again and are tested once.',
        },
        response: { 201: providerResponse, ...errorResponses },
      },
    )
    .post(
      '/providers/:id/purge',
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
          tags: ['Providers'],
          summary: 'Purge a Provider',
          description:
            'Permanently deletes an archived Provider and its Upstream Keys. Deletion is archive-first: a live Provider must be archived before it can be purged, and there is no restore.',
        },
        response: {
          204: t.Void(),
          ...errorResponses,
        },
      },
    )
    .post(
      '/providers/:id/keys/:keyId/test',
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
        return status(200, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Upstream Keys'],
          summary: 'Test an Upstream Key',
          description:
            'Runs the low-cost key test on demand and records the outcome. A usable test activates an Unverified key; a Disabled key keeps its state.',
        },
        response: {
          200: providerResponse,
          ...errorResponses,
        },
      },
    )
    .get(
      '/providers/:id/keys/:keyId/value',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: false })
        if ('response' in guardResult) {
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await providers.revealKey(params.id, params.keyId)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, result.value)
      },
      {
        detail: {
          tags: ['Upstream Keys'],
          summary: 'Reveal an Upstream Key value',
          description:
            'Decrypts and returns the plaintext of one Upstream Key so the Owner can copy it. The DB at rest stays encrypted; every reveal is recorded in the audit log.',
        },
        response: {
          200: keyValueResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/providers/:id/keys/:keyId/activate',
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
        return status(200, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Upstream Keys'],
          summary: 'Activate an Upstream Key',
          description:
            'Explicitly activates an Unverified or Disabled key, for when the test endpoint is unavailable but the Owner knows the key works.',
        },
        response: {
          200: providerResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/providers/:id/keys/:keyId/disable',
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
        return status(200, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Upstream Keys'],
          summary: 'Disable an Upstream Key',
          description: 'Takes a key out of use until the Owner activates it again.',
        },
        response: {
          200: providerResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/providers/:id/keys',
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
        const result = await providers.addKey(params.id, {
          upstreamKey: input.upstreamKey,
          ...('baseUrl' in input ? { baseUrl: input.baseUrl } : {}),
          ...('accountId' in input ? { accountId: input.accountId } : {}),
          ...('allowedModels' in input ? { allowedModels: input.allowedModels } : {}),
          ...('deniedModels' in input ? { deniedModels: input.deniedModels } : {}),
        })
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(201, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Upstream Keys'],
          summary: 'Add an Upstream Key',
          description:
            'Adds another Upstream Key to a Provider. It is encrypted, saved Unverified, and tested once with the low-cost probe like the first key. Existing keys are untouched. A blank baseUrl inherits the Provider default; a non-empty value overrides it for this key only. accountId, allowedModels and deniedModels follow the same shape as PATCH /providers/:id/keys/:keyId so the Owner can scope a new key in one round trip.',
        },
        response: { 201: providerResponse, ...errorResponses },
      },
    )
    .post(
      '/providers/:id/keys/bulk',
      async ({ params, body, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        // The body is validated by hand rather than by an Elysia schema: a
        // schema validation error would echo the offending value back to the
        // client, and that value can be an Upstream Key. Manually translating
        // the bad shape into the `validation_failed` envelope keeps the value
        // out of the error report (see the route-level doc on lines 33-40).
        const parsed = validateBulkKeysBody(body)
        if (!parsed.ok) {
          return status(400, validationFailureBody(parsed.problems))
        }

        const result = await providers.bulkAddKeys(params.id, { keys: parsed.value.keys })
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, {
          added: result.value.added.map((entry) => ({
            index: entry.index,
            keyId: entry.keyId,
          })),
          failed: result.value.failed.map((entry) => ({
            index: entry.index,
            problems: entry.problems.map((problem) => ({
              field: problem.field,
              message: problem.message,
            })),
          })),
        })
      },
      {
        detail: {
          tags: ['Upstream Keys'],
          summary: 'Bulk add Upstream Keys',
          description:
            'Imports many Upstream Keys in one call with partial-success semantics: each entry is validated and inserted independently, and the response records which entries were added and which failed. The batch is capped at 200 entries; entries past the cap are refused before any work begins. Per-key `allowedModels`, `deniedModels`, and `accountId` are not honored — the Owner configures them later via PATCH /providers/:id/keys/:keyId. The response carries the per-entry verdict, not the full Provider view; the UI refetches the Provider separately.',
        },
        response: { 200: bulkKeysResponse, ...errorResponses },
      },
    )
    .patch(
      '/providers/:id/keys/:keyId',
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
        const result = await providers.updateKeySettings(params.id, params.keyId, {
          ...('accountId' in input ? { accountId: input.accountId } : {}),
          ...('allowedModels' in input ? { allowedModels: input.allowedModels } : {}),
          ...('deniedModels' in input ? { deniedModels: input.deniedModels } : {}),
          ...('baseUrl' in input ? { baseUrl: input.baseUrl } : {}),
        })
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Upstream Keys'],
          summary: 'Configure an Upstream Key',
          description:
            'Changes which Upstream Account the key shares billing or capacity with, which exact models it may or may not serve, and the per-key base URL override. Null model lists mean no restriction; a blank baseUrl restores the inheritance; a non-empty value overrides the Provider default for this key only.',
        },
        response: {
          200: providerResponse,
          ...errorResponses,
        },
      },
    )
    .delete(
      '/providers/:id/keys/:keyId',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await providers.removeKey(params.id, params.keyId)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Upstream Keys'],
          summary: 'Remove an Upstream Key',
          description:
            'Removes one key permanently. The other keys and any Upstream Accounts on the Provider are untouched.',
        },
        response: {
          200: providerResponse,
          ...errorResponses,
        },
      },
    )
    .post(
      '/providers/:id/accounts',
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
        const result = await providers.createAccount(params.id, { displayName: input.displayName })
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(201, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Upstream Accounts'],
          summary: 'Create an Upstream Account',
          description:
            'Creates a group of Upstream Keys that share Provider billing or capacity. Assign keys to the account to group them; keys outside an account stay independent.',
        },
        response: { 201: providerResponse, ...errorResponses },
      },
    )
    .patch(
      '/providers/:id/accounts/:accountId',
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
        const result = await providers.updateAccount(params.id, params.accountId, {
          ...('displayName' in input ? { displayName: input.displayName } : {}),
        })
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Upstream Accounts'],
          summary: 'Rename an Upstream Account',
          description:
            'Renames an account. Its identity stays put, so keys already assigned to it keep their grouping.',
        },
        response: {
          200: providerResponse,
          ...errorResponses,
        },
      },
    )
    .delete(
      '/providers/:id/accounts/:accountId',
      async ({ params, request, cookie, status }) => {
        const guardResult = await guard.requireOwner({ request, cookie }, { csrf: true })
        if ('response' in guardResult) {
          // The status is split into its literals: a unioned code would type the
          // response against two declared schemas at once and match neither.
          return guardResult.response.status === 403
            ? status(403, toErrorDto(guardResult.response.body))
            : status(401, toErrorDto(guardResult.response.body))
        }

        const result = await providers.deleteAccount(params.id, params.accountId)
        if (!result.ok) {
          const failure = toFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(200, toProviderDto(result.value))
      },
      {
        detail: {
          tags: ['Upstream Accounts'],
          summary: 'Delete an Upstream Account',
          description:
            'Removes an account and its grouping. Its keys become independent again; nothing else is deleted.',
        },
        response: {
          200: providerResponse,
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
          tags: ['Gateway Keys'],
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
          ...('corsOrigins' in input ? { corsOrigins: input.corsOrigins } : {}),
        })

        if (!result.ok) {
          const failure = toGatewayKeyFailure(result.failure)
          return status(failure.statusCode, failure.body)
        }
        return status(201, toCreatedGatewayKeyDto(result.value))
      },
      {
        detail: {
          tags: ['Gateway Keys'],
          summary: 'Create a Gateway Key',
          description:
            'Issues a named application credential restricted to the requested Providers and exact model IDs. The usable secret is returned exactly once; only its hash is stored.',
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
          tags: ['Gateway Keys'],
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
          tags: ['Gateway Keys'],
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
    )
}

export type AdminRoutes = ReturnType<typeof createAdminRoutes>

const probeVerdict = t.Union([t.Literal('authenticated'), t.Literal('rejected'), t.Literal('inconclusive')])
const keyHealth = t.Union([
  t.Literal('unverified'),
  t.Literal('active'),
  t.Literal('cooling_down'),
  t.Literal('invalid_authentication'),
  t.Literal('exhausted'),
  t.Literal('disabled'),
])
const modelList = t.Union([t.Null(), t.Array(t.String())])

const keyResponse = t.Object({
  id: t.String(),
  health: keyHealth,
  /** The Key's own base URL override; null means inherit the Provider's. */
  baseUrl: t.Union([t.Null(), t.String()]),
  /** The base URL one upstream call should hit. The Key's override wins when set. */
  effectiveBaseUrl: t.String(),
  lastProbe: t.Union([
    t.Null(),
    t.Object({
      at: t.String(),
      verdict: probeVerdict,
      reason: t.Union([t.Null(), t.String()]),
    }),
  ]),
  healthReason: t.Union([t.Null(), t.String()]),
  healthChangedAt: t.String(),
  retryAfterAt: t.Union([t.Null(), t.String()]),
  healthScope: t.Union([
    t.Literal('key'),
    t.Literal('account'),
    t.Literal('connection_model'),
    t.Literal('provider'),
    t.Literal('unknown'),
  ]),
  healthScopeId: t.Union([t.Null(), t.String()]),
  healthModel: t.Union([t.Null(), t.String()]),
  accountId: t.Union([t.Null(), t.String()]),
  allowedModels: modelList,
  deniedModels: modelList,
  createdAt: t.String(),
  updatedAt: t.String(),
})

const accountResponse = t.Object({
  id: t.String(),
  displayName: t.String(),
  createdAt: t.String(),
  updatedAt: t.String(),
})

const staticHeaderNameResponse = t.Object({
  name: t.String(),
})

const providerResponse = t.Object({
  id: t.String(),
  displayName: t.String(),
  baseUrl: t.String(),
  allowInsecureHttp: t.Boolean(),
  enabled: t.Boolean(),
  retryMaxAttempts: t.Number(),
  retryAmbiguousNetwork: t.Boolean(),
  archived: t.Boolean(),
  templateId: t.Union([t.Null(), t.String()]),
  authHeader: t.String(),
  authPrefix: t.String(),
  staticHeaders: t.Array(staticHeaderNameResponse),
  redirectAllowSameOrigin: t.Boolean(),
  connectionTimeoutMs: t.Number(),
  firstByteTimeoutMs: t.Number(),
  nonStreamingTotalTimeoutMs: t.Number(),
  streamingIdleTimeoutMs: t.Number(),
  totalRetryTimeoutMs: t.Number(),
  idempotencyHeader: t.String(),
  warnings: t.Array(t.String()),
  createdAt: t.String(),
  updatedAt: t.String(),
  keys: t.Array(keyResponse),
  accounts: t.Array(accountResponse),
})

const providerListResponse = t.Object({ providers: t.Array(providerResponse) })

const keyValueResponse = t.Object({
  value: t.String(),
})

const templateCapabilitiesResponse = t.Object({
  chat: t.Boolean(),
  streaming: t.Boolean(),
  tools: t.Boolean(),
  structuredOutput: t.Boolean(),
  responses: t.Boolean(),
})

const templateBrandDto = t.Union([
  t.Null(),
  t.Object({
    domain: t.String(),
    accentColor: t.String(),
  }),
])

const templateDto = t.Object({
  id: t.String(),
  displayName: t.String(),
  description: t.String(),
  baseUrl: t.String(),
  authHeader: t.String(),
  authPrefix: t.String(),
  capabilities: templateCapabilitiesResponse,
  knownModels: t.Array(t.String()),
  inferenceAdapterId: t.String(),
  usageAdapterId: t.Union([t.Null(), t.String()]),
  brand: templateBrandDto,
})

const templateListResponse = t.Object({ templates: t.Array(templateDto) })

const gatewayKeyScopeResponse = t.Object({
  providerId: t.String(),
  models: t.Union([t.Null(), t.Array(t.String())]),
})

const gatewayKeyResponse = t.Object({
  id: t.String(),
  name: t.String(),
  scope: t.Array(gatewayKeyScopeResponse),
  corsOrigins: t.Array(t.String()),
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

/**
 * The bulk-import response shape: per-entry verdicts so the Owner UI can
 * surface partial-success inline.
 */
const bulkKeysResponse = t.Object({
  added: t.Array(
    t.Object({
      index: t.Number(),
      keyId: t.String(),
    }),
  ),
  failed: t.Array(
    t.Object({
      index: t.Number(),
      problems: t.Array(t.Object({ field: t.String(), message: t.String() })),
    }),
  ),
})

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

type ProviderDto = typeof providerResponse.static
type KeyDto = typeof keyResponse.static
type AccountDto = typeof accountResponse.static
type ErrorDto = typeof errorResponse.static
type GatewayKeyDto = typeof gatewayKeyResponse.static

function toProviderDto(view: ProviderView): ProviderDto {
  return {
    id: view.id,
    displayName: view.displayName,
    baseUrl: view.baseUrl,
    allowInsecureHttp: view.allowInsecureHttp,
    enabled: view.enabled,
    retryMaxAttempts: view.retryMaxAttempts,
    retryAmbiguousNetwork: view.retryAmbiguousNetwork,
    archived: view.archived,
    templateId: view.templateId,
    authHeader: view.authHeader,
    authPrefix: view.authPrefix,
    staticHeaders: view.staticHeaders.map((header) => ({ name: header.name })),
    redirectAllowSameOrigin: view.redirectAllowSameOrigin,
    connectionTimeoutMs: view.connectionTimeoutMs,
    firstByteTimeoutMs: view.firstByteTimeoutMs,
    nonStreamingTotalTimeoutMs: view.nonStreamingTotalTimeoutMs,
    streamingIdleTimeoutMs: view.streamingIdleTimeoutMs,
    totalRetryTimeoutMs: view.totalRetryTimeoutMs,
    idempotencyHeader: view.idempotencyHeader,
    warnings: [...view.warnings],
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    keys: view.keys.map(toKeyDto),
    accounts: view.accounts.map(toAccountDto),
  }
}

function toTemplateDto(template: ProviderTemplate): typeof templateDto.static {
  return {
    id: template.id,
    displayName: template.displayName,
    description: template.description,
    baseUrl: template.baseUrl,
    authHeader: template.authHeader,
    authPrefix: template.authPrefix,
    capabilities: { ...template.capabilities },
    knownModels: [...template.knownModels],
    inferenceAdapterId: template.inferenceAdapterId,
    usageAdapterId: template.usageAdapterId,
    brand: template.brand === null ? null : { ...template.brand },
  }
}

function toKeyDto(key: KeyView): KeyDto {
  return {
    id: key.id,
    health: key.health,
    baseUrl: key.baseUrl,
    effectiveBaseUrl: key.effectiveBaseUrl,
    lastProbe:
      key.lastProbe === null
        ? null
        : {
            at: key.lastProbe.at.toISOString(),
            verdict: key.lastProbe.verdict,
            reason: key.lastProbe.reason,
          },
    healthReason: key.healthReason,
    healthChangedAt: key.healthChangedAt.toISOString(),
    retryAfterAt: key.retryAfterAt?.toISOString() ?? null,
    healthScope: key.healthScope,
    healthScopeId: key.healthScopeId,
    healthModel: key.healthModel,
    accountId: key.accountId,
    allowedModels: key.allowedModels === null ? null : [...key.allowedModels],
    deniedModels: key.deniedModels === null ? null : [...key.deniedModels],
    createdAt: key.createdAt.toISOString(),
    updatedAt: key.updatedAt.toISOString(),
  }
}

function toAccountDto(account: UpstreamAccountView): AccountDto {
  return {
    id: account.id,
    displayName: account.displayName,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  }
}

function toGatewayKeyDto(key: GatewayKeyView): GatewayKeyDto {
  return {
    id: key.id,
    name: key.name,
    scope: key.scope.map((entry) => ({
      providerId: entry.providerId,
      models: entry.models === null ? null : [...entry.models],
    })),
    corsOrigins: [...key.corsOrigins],
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
    case 'provider_not_found':
      return { statusCode: 404, body: adminError('provider_not_found', 'No such Provider.') }
    case 'key_not_found':
      return {
        statusCode: 404,
        body: adminError('key_not_found', 'No such Upstream Key on this Provider.'),
      }
    case 'account_not_found':
      return {
        statusCode: 404,
        body: adminError('account_not_found', 'No such Upstream Account on this Provider.'),
      }
    case 'provider_archived':
      return {
        statusCode: 409,
        body: adminError(
          'provider_archived',
          'This Provider is archived. Duplicate it to bring it back into use, or purge it.',
        ),
      }
    case 'not_archived':
      return {
        statusCode: 409,
        body: adminError(
          'not_archived',
          'Archive this Provider first; purge only removes what is already out of active use.',
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

/**
 * Whole-batch validation for the bulk-add endpoint. Each entry's contents
 * (bad upstreamKey, bad baseUrl) are caught by the registry's per-entry
 * rules and surface in the `failed[]` array; this function only refuses the
 * whole batch for shape problems that prevent any per-entry work.
 */
function validateBulkKeysBody(body: unknown):
  | { ok: true; value: { keys: { readonly upstreamKey: string; readonly baseUrl?: string }[] } }
  | { ok: false; problems: readonly { readonly field: string; readonly message: string }[] } {
  const problems: { field: string; message: string }[] = []

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, problems: [{ field: 'body', message: 'A JSON object is required.' }] }
  }

  const obj = body as Record<string, unknown>
  const keysValue = obj.keys

  if (keysValue === undefined) {
    return { ok: false, problems: [{ field: 'keys', message: 'A `keys` array is required.' }] }
  }

  if (!Array.isArray(keysValue)) {
    return { ok: false, problems: [{ field: 'keys', message: '`keys` must be an array.' }] }
  }

  if (keysValue.length < 1) {
    problems.push({ field: 'keys', message: 'At least one entry is required.' })
  } else if (keysValue.length > 200) {
    problems.push({ field: 'keys', message: 'At most 200 entries are allowed.' })
  } else {
    const keys: { upstreamKey: string; baseUrl?: string }[] = []
    for (let i = 0; i < keysValue.length; i++) {
      const entry = keysValue[i]
      const entryPath = `keys[${i}]`
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        problems.push({ field: entryPath, message: 'Each entry must be an object.' })
        continue
      }
      const e = entry as Record<string, unknown>
      if (typeof e.upstreamKey !== 'string') {
        problems.push({ field: `${entryPath}.upstreamKey`, message: '`upstreamKey` must be a string.' })
        continue
      }
      if (e.baseUrl !== undefined && e.baseUrl !== null && typeof e.baseUrl !== 'string') {
        problems.push({ field: `${entryPath}.baseUrl`, message: '`baseUrl` must be a string when present.' })
        continue
      }
      const key: { upstreamKey: string; baseUrl?: string } = { upstreamKey: e.upstreamKey }
      if (typeof e.baseUrl === 'string') key.baseUrl = e.baseUrl
      keys.push(key)
    }
    if (problems.length === 0) {
      return { ok: true, value: { keys } }
    }
  }

  return { ok: false, problems }
}

function asObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}
