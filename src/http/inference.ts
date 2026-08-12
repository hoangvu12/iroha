import { randomBytes } from 'node:crypto'
import { Elysia } from 'elysia'
import type { InferenceAdapter } from '../inference/index.ts'
import type { GatewayKeyRegistry } from '../keys/index.ts'
import type { ModelCatalogService } from '../models/index.ts'
import type { ProviderConnectionRegistry } from '../providers/index.ts'

export interface InferenceRoutesOptions {
  readonly gatewayKeys: GatewayKeyRegistry
  readonly providers: ProviderConnectionRegistry
  readonly inference: InferenceAdapter
  readonly modelCatalog: ModelCatalogService
}

/**
 * The provider-scoped OpenAI surface an application reaches with its Gateway
 * Key. Every response carries the request's correlation ID; failures are
 * OpenAI-shaped with stable Iroha codes and sanitized detail, and the caller's
 * authorization never travels beyond this boundary.
 */
export function createInferenceRoutes(options: InferenceRoutesOptions) {
  const { gatewayKeys, providers, inference, modelCatalog } = options

  return new Elysia({ name: 'iroha/inference', prefix: '/providers' })
    .get(
      '/:connectionId/v1/models',
      async ({ request, params }) => {
        const correlationId = newRequestId()
        const baseHeaders = { 'content-type': 'application/json', 'x-request-id': correlationId }

        const token = bearerToken(request.headers)
        const authorization = await gatewayKeys.authorizeConnection(params.connectionId, token)
        if (!authorization.ok) {
          const refusal = authorizationRefusal(authorization)
          return error(refusal.status, baseHeaders, refusal, correlationId)
        }

        const result = await modelCatalog.listForScope(params.connectionId, authorization.models)
        if (!result.ok) {
          const refusal = resolutionRefusal(result.failure)
          return error(refusal.status, baseHeaders, refusal, correlationId)
        }

        return new Response(
          JSON.stringify({
            object: 'list',
            data: result.value.map((model) => ({ id: model.id, object: 'model', created: model.created })),
          }),
          { status: 200, headers: baseHeaders },
        )
      },
    )
    .post(
      '/:connectionId/v1/chat/completions',
      async ({ request, params }) => {
        const correlationId = newRequestId()
        const baseHeaders = { 'content-type': 'application/json', 'x-request-id': correlationId }

        const envelope = readEnvelope(await request.text())
        if (!envelope.ok) {
          return error(
            envelope.status,
            baseHeaders,
            { code: envelope.code, message: envelope.message },
            correlationId,
          )
        }

        const token = bearerToken(request.headers)
        const authorization = await gatewayKeys.authorizeInference(
          params.connectionId,
          envelope.model,
          token,
        )
        if (!authorization.ok) {
          const refusal = authorizationRefusal(authorization)
          return error(refusal.status, baseHeaders, refusal, correlationId)
        }

        // An Owner exclusion blocks a model the same way the Key Scope does,
        // and it applies to unknown and catalogued models alike.
        if (await modelCatalog.isExcluded(params.connectionId, envelope.model)) {
          return error(
            403,
            baseHeaders,
            {
              code: 'model_excluded',
              message: 'This model is excluded on this Provider Connection.',
            },
            correlationId,
          )
        }

        const target = await providers.resolveInference(params.connectionId)
        if (!target.ok) {
          const refusal = resolutionRefusal(target.failure)
          return error(refusal.status, baseHeaders, refusal, correlationId)
        }

        let upstream
        try {
          upstream = await inference.forward({
            baseUrl: target.value.baseUrl,
            allowInsecureHttp: target.value.allowInsecureHttp,
            path: '/chat/completions',
            method: 'POST',
            body: envelope.raw,
            headers: headersOf(request),
            upstreamKey: target.value.upstreamKey,
            signal: request.signal,
          })
        } catch (cause) {
          // The caller went away: propagating the abort is the honest answer,
          // and any response would reach nobody anyway.
          if (isAbort(cause)) throw cause
          return error(
            502,
            baseHeaders,
            { code: 'upstream_unreachable', message: 'The Provider could not be reached.' },
            correlationId,
          )
        }

        if (upstream.status >= 200 && upstream.status < 300) {
          return new Response(upstream.body, {
            status: upstream.status,
            headers: {
              'content-type': upstream.headers['content-type'] ?? 'application/json',
              'x-request-id': correlationId,
            },
          })
        }

        const refusal = upstreamRefusal(upstream.status, upstream.headers)
        return error(refusal.status, { ...baseHeaders, ...(refusal.retryAfter ? { 'retry-after': refusal.retryAfter } : {}) }, refusal, correlationId)
      },
    )
}

export type InferenceRoutes = ReturnType<typeof createInferenceRoutes>

/**
 * The routing-critical envelope: the exact request model. Everything else is
 * unknown by design and travels upstream byte-for-byte, so Provider extensions
 * and newer fields need no Iroha release.
 */
type Envelope =
  | { readonly ok: true; readonly model: string; readonly raw: string }
  | { readonly ok: false; readonly status: 400; readonly code: string; readonly message: string }

function readEnvelope(raw: string): Envelope {
  if (raw === '') {
    return { ok: false, status: 400, code: 'invalid_request', message: 'A request body is required.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, status: 400, code: 'invalid_request', message: 'The request body is not valid JSON.' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, code: 'invalid_request', message: 'The request body must be a JSON object.' }
  }

  const model = (parsed as Record<string, unknown>).model
  if (typeof model !== 'string' || model.trim() === '') {
    return { ok: false, status: 400, code: 'model_required', message: 'The request must name a model.' }
  }

  return { ok: true, model: model.trim(), raw }
}

type Refusal = { readonly status: number; readonly code: string; readonly message: string; readonly retryAfter?: string }

function authorizationRefusal(
  authorization: { readonly code: 'gateway_key_invalid' | 'connection_not_allowed' | 'model_not_allowed' },
): Refusal {
  switch (authorization.code) {
    case 'gateway_key_invalid':
      return { status: 401, code: 'gateway_key_invalid', message: 'This Gateway Key is not valid.' }
    case 'connection_not_allowed':
      return {
        status: 403,
        code: 'connection_not_allowed',
        message: 'This Gateway Key is not allowed to use that Provider Connection.',
      }
    case 'model_not_allowed':
      return {
        status: 403,
        code: 'model_not_allowed',
        message: 'This Gateway Key is not allowed to request that model on this connection.',
      }
  }
}

function resolutionRefusal(failure: { readonly code: string }): Refusal {
  switch (failure.code) {
    case 'connection_not_found':
      return { status: 404, code: 'connection_not_found', message: 'No such Provider Connection.' }
    case 'connection_archived':
      return {
        status: 409,
        code: 'connection_archived',
        message: 'This Provider Connection is archived and serves no inference.',
      }
    case 'connection_disabled':
      return {
        status: 409,
        code: 'connection_disabled',
        message: 'This Provider Connection is disabled and serves no inference.',
      }
    case 'no_eligible_key':
      return {
        status: 503,
        code: 'upstream_credentials_unavailable',
        message: 'No eligible Upstream Key is available for this connection.',
      }
    case 'stored_key_unreadable':
      return {
        status: 500,
        code: 'stored_key_unreadable',
        message: 'A stored Upstream Key could not be read. The installation master key may have changed.',
      }
    default:
      return {
        status: 500,
        code: 'internal_error',
        message: 'The request could not be completed.',
      }
  }
}

/**
 * Maps a safe upstream failure to a stable Iroha code. The detail is
 * structural and never echoes upstream text, which may carry a secret.
 */
function upstreamRefusal(status: number, headers: Readonly<Record<string, string>>): Refusal {
  if (status >= 300 && status < 400) {
    return { status: 502, code: 'upstream_redirect', message: 'The Provider redirected the request; redirects are not followed.' }
  }

  if (status >= 500) {
    const mirrored = status === 500 || status === 502 || status === 503 || status === 504 ? status : 502
    return { status: mirrored, code: 'upstream_unavailable', message: `The Provider failed to answer (HTTP ${status}).` }
  }

  switch (status) {
    case 400:
      return { status: 400, code: 'upstream_bad_request', message: 'The Provider rejected the request (HTTP 400).' }
    case 401:
      return { status: 401, code: 'upstream_invalid_credentials', message: 'The Provider rejected the Upstream Key (HTTP 401).' }
    case 403:
      return { status: 403, code: 'upstream_forbidden', message: 'The Provider refused the request (HTTP 403).' }
    case 404:
      return { status: 404, code: 'upstream_not_found', message: 'The Provider has no such endpoint (HTTP 404).' }
    case 429: {
      const retryAfter = safeRetryAfter(headers)
      return {
        status: 429,
        code: 'upstream_rate_limited',
        message: 'The Provider rate-limited the request (HTTP 429).',
        ...(retryAfter === undefined ? {} : { retryAfter }),
      }
    }
    default:
      return { status, code: 'upstream_error', message: `The Provider answered with HTTP ${status}.` }
  }
}

/** Only a plain numeric `Retry-After` survives; free upstream text does not. */
function safeRetryAfter(headers: Readonly<Record<string, string>>): string | undefined {
  const value = headers['retry-after']
  if (value === undefined) return undefined
  return /^\d+$/.test(value.trim()) ? value.trim() : undefined
}

/** One OpenAI-shaped error: message, type, param, stable code, and correlation. */
function error(
  status: number,
  headers: Record<string, string>,
  refusal: { code: string; message: string },
  correlationId: string,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: refusal.message,
        type: errorType(status),
        param: null,
        code: refusal.code,
        request_id: correlationId,
      },
    }),
    { status, headers },
  )
}

function errorType(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

/** Elysia exposes headers as a string record; only the bearer is read. */
function bearerToken(headers: Headers): string | null {
  const value = headers.get('authorization')
  if (value === null) return null

  const match = /^Bearer (.+)$/i.exec(value.trim())
  return match === null ? null : match[1]!.trim()
}

function headersOf(request: Request): Readonly<Record<string, string>> {
  return Object.fromEntries(request.headers.entries())
}

function newRequestId(): string {
  return `req_${randomBytes(16).toString('base64url')}`
}

function isAbort(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  return (cause as { name?: unknown }).name === 'AbortError'
}
