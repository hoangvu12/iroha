import { randomBytes } from 'node:crypto'
import { Elysia, t } from 'elysia'
import type { RequestHistoryService } from '../history/index.ts'
import type { AttemptOutcome } from '../persistence/index.ts'
import { adapterBlockedHeaders } from '../inference/blocked-headers.ts'
import {
  callerSuppliedIdempotency,
  generateIdempotencyValue,
  type InferenceAdapter,
  type InferenceAdapterCapabilities,
  type InferenceFailureKind,
  type InferenceFailureClassification,
  type InferenceForwardRequest,
  type InferenceForwardResult,
} from '../inference/index.ts'
import type { GatewayKeyRegistry, InferenceAuthorization } from '../keys/index.ts'
import type { ModelCatalogService } from '../models/index.ts'
import type { Database } from '../persistence/index.ts'
import { ANTHROPIC_INFERENCE_ADAPTER_ID } from '../providers/templates.ts'
import type { AdapterRegistry } from '../providers/adapter-registry.ts'
import type { InferenceTarget, ProviderRegistry } from '../providers/index.ts'
import type { MetricsCollector } from '../metrics/metrics.ts'
import type { InferenceActivity, ShutdownController } from '../runtime/shutdown.ts'
import { systemTimer, type Timer } from '../runtime/timer.ts'
import type { UsageService } from '../usage/index.ts'
import type { CapacityEvidence } from '../providers/provider-evidence.ts'
import { authorizeQualifiedModel } from './qualified-model.ts'
import { bearerToken } from './bearer-token.ts'

/** The terminal shape of one attempt's outcome, what the recorder writes. */
interface AttemptTerminal {
  readonly status: number | null
  readonly outcome: AttemptOutcome
  readonly errorCode: string | null
  readonly retryAfterSeconds: number | null
  readonly diagnostics?: unknown
  readonly at: Date
}

/**
 * Pulls the Provider's `usage` block out of a buffered response body without
 * keeping any prompt or response text. Returns nulls when the body is not
 * JSON, is missing `usage`, or any field is not a non-negative integer; the
 * history row records only what the Provider claimed, never what Iroha
 * inferred.
 */
function parseUsage(body: string): {
  readonly promptTokens: number | null
  readonly completionTokens: number | null
  readonly totalTokens: number | null
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { promptTokens: null, completionTokens: null, totalTokens: null }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { promptTokens: null, completionTokens: null, totalTokens: null }
  }
  const usage = (parsed as { usage?: unknown }).usage
  if (typeof usage !== 'object' || usage === null) {
    return { promptTokens: null, completionTokens: null, totalTokens: null }
  }
  const record = usage as Record<string, unknown>
  const prompt = readTokenCount(record.prompt_tokens)
  const completion = readTokenCount(record.completion_tokens)
  const total = readTokenCount(record.total_tokens)
  return { promptTokens: prompt, completionTokens: completion, totalTokens: total }
}

function readTokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

/** The streaming deadlines, deliberately separate knobs from any buffered total timeout. */
export interface StreamingTimeouts {
  /** Wait this long for the first upstream byte before aborting the stream. */
  readonly streamingHeaderMs: number
  /** Maximum silence between upstream bytes before aborting the stream. */
  readonly streamingIdleMs: number
}

/**
 * The default inference transport timeouts. Each may be overridden by a
 * matching global setting; per-connection overrides win over both.
 */
export interface TransportDefaults {
  readonly connectionTimeoutMs: number
  readonly firstByteTimeoutMs: number
  readonly nonStreamingTotalTimeoutMs: number
  readonly streamingIdleTimeoutMs: number
  readonly totalRetryTimeoutMs: number
  /** Browser origins allowed to call inference cross-origin. */
  readonly corsAllowedOrigins: readonly string[]
}

export interface InferenceRoutesOptions {
  readonly gatewayKeys: GatewayKeyRegistry
  readonly providers: ProviderRegistry
  readonly inference: InferenceAdapter
  readonly modelCatalog: ModelCatalogService
  /**
   * The Adapter Registry the route consults to pick the Inference Adapter
   * for each Provider Connection. When omitted, every request uses the
   * `inference` option above, preserving the single-adapter behaviour
   * older callers relied on.
   */
  readonly adapterRegistry?: AdapterRegistry
  /** Streaming deadlines; tests inject a fake timer to drive them. */
  readonly timer?: Timer
  readonly shutdown?: ShutdownController
  readonly metrics?: MetricsCollector
  readonly timeouts?: StreamingTimeouts
  /** Per-connection transport overrides and the global fallback defaults. */
  readonly transportDefaults?: TransportDefaults
  readonly database?: Database
  /** Writes request-history rows; tests can inject a no-op. */
  readonly requestHistory?: RequestHistoryService
  /** Refreshes the usage snapshot after a successful request for Providers that have a Usage Adapter. */
  readonly usageService?: UsageService
  readonly retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const MAX_INFERENCE_ATTEMPTS = 3

/** Reasonable defaults applied when no global setting has been written yet. */
export const DEFAULT_TRANSPORT: TransportDefaults = {
  connectionTimeoutMs: 10_000,
  firstByteTimeoutMs: 20_000,
  nonStreamingTotalTimeoutMs: 120_000,
  streamingIdleTimeoutMs: 30_000,
  totalRetryTimeoutMs: 30_000,
  corsAllowedOrigins: [],
}

/**
 * The provider-scoped OpenAI surface an application reaches with its Gateway
 * Key. Every response carries the request's correlation ID; failures are
 * OpenAI-shaped with stable Iroha codes and sanitized detail, and the caller's
 * authorization never travels beyond this boundary.
 */
export function createInferenceRoutes(options: InferenceRoutesOptions) {
  const { gatewayKeys, providers, inference, modelCatalog, shutdown, metrics } = options
  const timer = options.timer ?? systemTimer
  const retrySleep = options.retrySleep ?? sleepWithTimer(timer)
  const transport = options.transportDefaults ?? DEFAULT_TRANSPORT
  const requestHistory = options.requestHistory

  return new Elysia({ name: 'iroha/inference', prefix: '/providers' })
    .options(
      '/:providerHandle/*',
      async ({ params, request }) => {
        const resolved = await providers.resolveHandle(params.providerHandle)
        if (!resolved.ok) return providerHandleError(resolved.code)
        return handleCors({
          providerId: resolved.providerId,
          gatewayKeys,
          database: options.database ?? null,
          transport,
          request,
        })
      },
      {
        detail: {
          hide: true,
          summary: 'CORS preflight',
          description:
            'Replies to a browser OPTIONS preflight with the allow-listed origin (if any) and the methods/headers inference is allowed to use. Same-origin requests get no CORS machinery.',
        },
      },
    )
    .get(
      '/:providerHandle/v1/models',
      async ({ request, params }) => {
        const activity = shutdown === undefined ? undefined : shutdown.beginInference(request.signal)
        if (activity === null) return shuttingDownError()
        try {
        const correlationId = newRequestId()
        const baseHeaders = { 'content-type': 'application/json', 'x-request-id': correlationId }

        const resolved = await providers.resolveHandle(params.providerHandle)
        if (!resolved.ok) return providerHandleError(resolved.code, correlationId)

        const cors = await buildCorsHeaders({
          providerId: resolved.providerId,
          gatewayKeys,
          database: options.database ?? null,
          transport,
          request,
        })
        const responseHeaders = { ...baseHeaders, ...cors }

        const token = bearerToken(request.headers)
        const authorization = await gatewayKeys.authorizeProvider(resolved.providerId, token)
        if (!authorization.ok) {
          const refusal = authorizationRefusal(authorization)
          return error(refusal.status, responseHeaders, refusal, correlationId)
        }

        const result = await modelCatalog.listForScope(resolved.providerId, authorization.models)
        if (!result.ok) {
          const refusal = resolutionRefusal(result.failure)
          return error(refusal.status, responseHeaders, refusal, correlationId)
        }

        return new Response(
          JSON.stringify({
            object: 'list',
            data: result.value.map((model) => ({ id: model.id, object: 'model', created: model.created })),
          }),
          { status: 200, headers: responseHeaders },
        )
        } finally {
          activity?.finish()
        }
      },
      {
        detail: {
          hide: true,
          summary: 'List Provider Models',
          description: 'The OpenAI-compatible provider-scoped Models surface is covered by the capability matrix and intentionally omitted from the custom API document.',
        },
        response: { 200: t.Object({ object: t.Literal('list'), data: t.Array(t.Object({ id: t.String(), object: t.Literal('model'), created: t.Number() })) }) },
      },
    )
    .post(
      '/:providerHandle/v1/chat/completions',
      async ({ request, params }) => {
        const activity = shutdown === undefined ? undefined : shutdown.beginInference(request.signal)
        if (activity === null) return shuttingDownError()
        const resolved = await providers.resolveHandle(params.providerHandle)
        if (!resolved.ok) {
          activity?.finish()
          return providerHandleError(resolved.code)
        }
        return await forwardGeneration({
          request,
          providerId: resolved.providerId,
          upstreamPath: '/chat/completions',
          gatewayKeys,
          providers,
          inference,
          modelCatalog,
          timer,
          ...(metrics === undefined ? {} : { metrics }),
          timeouts: options.timeouts,
          retrySleep,
          transport,
          adapterRegistry: options.adapterRegistry ?? null,
          database: options.database ?? null,
          requestHistory,
          ...(options.usageService === undefined ? {} : { usageService: options.usageService }),
          ...(activity === undefined ? {} : { requestActivity: activity }),
        })
      },
      {
        detail: {
          hide: true,
          summary: 'Create Chat Completions',
          description: 'The OpenAI-compatible provider-scoped Chat Completions surface is covered by the capability matrix and intentionally omitted from the custom API document.',
        },
        response: { 200: t.Unknown() },
      },
    )
    .post(
      '/:providerHandle/v1/responses',
      async ({ request, params }) => {
        const activity = shutdown === undefined ? undefined : shutdown.beginInference(request.signal)
        if (activity === null) return shuttingDownError()
        const resolved = await providers.resolveHandle(params.providerHandle)
        if (!resolved.ok) {
          activity?.finish()
          return providerHandleError(resolved.code)
        }
        return await forwardGeneration({
          request,
          providerId: resolved.providerId,
          upstreamPath: '/responses',
          gatewayKeys,
          providers,
          inference,
          modelCatalog,
          timer,
          ...(metrics === undefined ? {} : { metrics }),
          timeouts: options.timeouts,
          retrySleep,
          transport,
          adapterRegistry: options.adapterRegistry ?? null,
          database: options.database ?? null,
          requestHistory,
          ...(options.usageService === undefined ? {} : { usageService: options.usageService }),
          ...(activity === undefined ? {} : { requestActivity: activity }),
        })
      },
      {
        detail: {
          hide: true,
          summary: 'Create Responses',
          description: 'The OpenAI-compatible provider-scoped Responses surface is covered by the capability matrix and intentionally omitted from the custom API document.',
        },
        response: { 200: t.Unknown() },
      },
    )
    .post(
      '/:providerHandle/v1/messages',
      async ({ request, params }) => {
        const activity = shutdown === undefined ? undefined : shutdown.beginInference(request.signal)
        if (activity === null) return shuttingDownError()
        const resolved = await providers.resolveHandle(params.providerHandle)
        if (!resolved.ok) {
          activity?.finish()
          return providerHandleError(resolved.code)
        }
        return await forwardAnthropicMessages({
          request,
          providerId: resolved.providerId,
          gatewayKeys,
          providers,
          modelCatalog,
          timer,
          ...(metrics === undefined ? {} : { metrics }),
          timeouts: options.timeouts,
          retrySleep,
          transport,
          adapterRegistry: options.adapterRegistry ?? null,
          database: options.database ?? null,
          requestHistory,
          ...(options.usageService === undefined ? {} : { usageService: options.usageService }),
          ...(activity === undefined ? {} : { requestActivity: activity }),
        })
      },
      {
        detail: {
          hide: true,
          summary: 'Create Messages (Anthropic-compatible)',
          description:
            'The Anthropic-compatible provider-scoped Messages surface. When the Provider Connection is an Anthropic Provider the body is forwarded verbatim to upstream /v1/messages; when the Provider Connection is an OpenAI-compatible Provider the adapter translates the Anthropic-shape body to OpenAI-shape and the response back to Anthropic-shape.',
        },
        response: { 200: t.Unknown() },
      },
    )
}

export type InferenceRoutes = ReturnType<typeof createInferenceRoutes>

/** Global Chat Completions delegates to the provider-scoped pipeline after deterministic qualification. */
export function createGlobalInferenceRoutes(options: InferenceRoutesOptions) {
  const timer = options.timer ?? systemTimer
  const retrySleep = options.retrySleep ?? sleepWithTimer(timer)
  const transport = options.transportDefaults ?? DEFAULT_TRANSPORT

  const admit = async (
    request: Request,
    errors: {
      readonly internal: () => Response
      readonly malformed: () => Response
      readonly unauthorized: (code: 'gateway_key_invalid' | 'invalid_model_id' | 'provider_not_allowed' | 'model_not_allowed') => Response
    },
  ) => {
    const database = options.database
    if (database === undefined) return { ok: false as const, response: errors.internal() }
    let input: Record<string, unknown>
    try {
      const parsed = await request.clone().json()
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('invalid body')
      input = parsed as Record<string, unknown>
    } catch {
      return { ok: false as const, response: errors.malformed() }
    }

    const authorization = await authorizeQualifiedModel({
      input: input.model,
      token: bearerToken(request.headers),
      gatewayKeys: options.gatewayKeys,
      database,
    })
    if (!authorization.ok) return { ok: false as const, response: errors.unauthorized(authorization.code) }

    const activity = options.shutdown?.beginInference(request.signal)
    if (activity === null) return { ok: false as const, response: shuttingDownError() }
    return {
      ok: true as const,
      requestedModel: input.model as string,
      authorization,
      database,
      activity,
      upstreamRequest: new Request(request, {
        body: JSON.stringify({ ...input, model: authorization.modelId }),
        signal: activity?.signal ?? request.signal,
      }),
    }
  }

  const forwardingOptions = (admission: Extract<Awaited<ReturnType<typeof admit>>, { readonly ok: true }>) => ({
    request: admission.upstreamRequest,
    providerId: admission.authorization.providerId,
    gatewayKeys: options.gatewayKeys,
    providers: options.providers,
    modelCatalog: options.modelCatalog,
    timer,
    retrySleep,
    transport,
    adapterRegistry: options.adapterRegistry ?? null,
    database: admission.database,
    requestHistory: options.requestHistory,
    authorization: {
      ok: true as const,
      keyId: admission.authorization.gatewayKeyId,
      keyName: admission.authorization.gatewayKeyName,
    },
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    ...(options.timeouts === undefined ? {} : { timeouts: options.timeouts }),
    ...(options.usageService === undefined ? {} : { usageService: options.usageService }),
    ...(admission.activity === undefined ? {} : { requestActivity: admission.activity }),
  })

  const forward = async (request: Request, upstreamPath: '/chat/completions' | '/responses'): Promise<Response> => {
    const admission = await admit(request, {
      internal: () => globalError(500, 'internal_error', 'The request could not be completed.'),
      malformed: () => globalError(400, 'invalid_model_id', 'A Qualified Model ID is required.'),
      unauthorized: qualifiedAuthorizationError,
    })
    if (!admission.ok) return admission.response
    const response = await forwardGeneration({
      ...forwardingOptions(admission),
      upstreamPath,
      inference: options.inference,
    })
    if (!response.ok) return response
    return await qualifyGlobalResponse(
      response,
      admission.authorization.providerId,
      admission.requestedModel,
      upstreamPath === '/responses' ? 'responses' : 'chat',
    )
  }

  const forwardMessages = async (request: Request): Promise<Response> => {
    const correlationId = newRequestId()
    const headers = { 'content-type': 'application/json', 'x-request-id': correlationId }
    const admission = await admit(request, {
      internal: () => anthropicMessagesErrorResponse(500, 'internal_error', 'The request could not be completed.', headers, correlationId),
      malformed: () => anthropicMessagesErrorResponse(400, 'invalid_model_id', 'A Qualified Model ID is required.', headers, correlationId),
      unauthorized: (code) => qualifiedAnthropicAuthorizationError(code, headers, correlationId),
    })
    if (!admission.ok) return admission.response
    const response = await forwardAnthropicMessages({
      ...forwardingOptions(admission),
    })
    if (!response.ok) return response
    return await qualifyGlobalResponse(response, admission.authorization.providerId, admission.requestedModel, 'messages')
  }

  return new Elysia({ name: 'iroha/global-inference' })
    .post('/v1/chat/completions', ({ request }) => forward(request, '/chat/completions'), {
      detail: { hide: true, summary: 'Create global Chat Completions' }, response: { 200: t.Unknown() },
    })
    .post('/v1/responses', ({ request }) => forward(request, '/responses'), {
      detail: { hide: true, summary: 'Create global Responses' }, response: { 200: t.Unknown() },
    })
    .post('/v1/messages', ({ request }) => forwardMessages(request), {
      detail: { hide: true, summary: 'Create global Anthropic Messages' }, response: { 200: t.Unknown() },
    })
}

function qualifiedAuthorizationError(code: 'gateway_key_invalid' | 'invalid_model_id' | 'provider_not_allowed' | 'model_not_allowed'): Response {
  switch (code) {
    case 'gateway_key_invalid': return globalError(401, code, 'This Gateway Key is not valid.')
    case 'invalid_model_id': return globalError(400, code, 'A Qualified Model ID must be <provider_id>/<model_id>.')
    case 'provider_not_allowed': return globalError(403, code, 'This Gateway Key is not allowed to use that Provider.')
    case 'model_not_allowed': return globalError(403, code, 'This Gateway Key is not allowed to request that model.')
  }
}

function globalError(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status })
}

function qualifiedAnthropicAuthorizationError(
  code: 'gateway_key_invalid' | 'invalid_model_id' | 'provider_not_allowed' | 'model_not_allowed',
  headers: Record<string, string>,
  correlationId: string,
): Response {
  switch (code) {
    case 'gateway_key_invalid': return anthropicMessagesErrorResponse(401, code, 'This Gateway Key is not valid.', headers, correlationId)
    case 'invalid_model_id': return anthropicMessagesErrorResponse(400, code, 'A Qualified Model ID must be <provider_id>/<model_id>.', headers, correlationId)
    case 'provider_not_allowed': return anthropicMessagesErrorResponse(403, code, 'This Gateway Key is not allowed to use that Provider.', headers, correlationId)
    case 'model_not_allowed': return anthropicMessagesErrorResponse(403, code, 'This Gateway Key is not allowed to request that model.', headers, correlationId)
  }
}

async function qualifyGlobalResponse(response: Response, providerId: string, requestedModel: string, surface: 'chat' | 'responses' | 'messages'): Promise<Response> {
  const headers = new Headers(response.headers)
  if (headers.get('content-type')?.includes('text/event-stream') && response.body !== null) {
    return new Response(response.body.pipeThrough(qualifySseModels(providerId, requestedModel, surface)), { status: response.status, headers })
  }
  return new Response(qualifyJsonModel(await response.text(), providerId, requestedModel, surface), { status: response.status, headers })
}

function qualifySseModels(providerId: string, requestedModel: string, surface: 'chat' | 'responses' | 'messages'): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) controller.enqueue(encoder.encode(`${qualifySseLine(line, providerId, requestedModel, surface)}\n`))
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending !== '') controller.enqueue(encoder.encode(qualifySseLine(pending, providerId, requestedModel, surface)))
    },
  })
}

function qualifySseLine(line: string, providerId: string, requestedModel: string, surface: 'chat' | 'responses' | 'messages'): string {
  if (!line.startsWith('data:')) return line
  const data = line.slice(5).trimStart()
  if (data === '[DONE]') return line
  return `data: ${qualifyJsonModel(data, providerId, requestedModel, surface)}`
}

function qualifyJsonModel(body: string, providerId: string, requestedModel: string, surface: 'chat' | 'responses' | 'messages'): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    if (surface === 'responses' && typeof parsed.response === 'object' && parsed.response !== null) {
      const nested = parsed.response as Record<string, unknown>
      return JSON.stringify({ ...parsed, response: { ...nested, model: qualifiedModel(providerId, nested.model, requestedModel) } })
    }
    if (surface === 'responses' && !('model' in parsed) && typeof parsed.type === 'string') return body
    if (surface === 'messages' && typeof parsed.message === 'object' && parsed.message !== null) {
      const message = parsed.message as Record<string, unknown>
      return JSON.stringify({ ...parsed, message: { ...message, model: qualifiedModel(providerId, message.model, requestedModel) } })
    }
    if (surface === 'messages' && !('model' in parsed)) return body
    return JSON.stringify({ ...parsed, model: qualifiedModel(providerId, parsed.model, requestedModel) })
  } catch {
    return body
  }
}

function qualifiedModel(providerId: string, upstream: unknown, requestedModel: string): string {
  const upstreamModel = typeof upstream === 'string' && upstream !== '' ? upstream : requestedModel.slice(requestedModel.indexOf('/') + 1)
  return `${providerId}/${upstreamModel}`
}

async function forwardGeneration(options: {
  request: Request
  providerId: string
  upstreamPath: '/chat/completions' | '/responses'
  database?: Database | null
  gatewayKeys: GatewayKeyRegistry
  providers: ProviderRegistry
  inference: InferenceAdapter
  modelCatalog: ModelCatalogService
  timer: Timer
  /** Test override applied when no per-connection streaming timeout is set. */
  timeouts?: StreamingTimeouts | undefined
  retrySleep: (ms: number, signal: AbortSignal) => Promise<void>
  transport: TransportDefaults
  /** The Adapter Registry the route consults to pick the per-Provider Adapter. */
  adapterRegistry?: AdapterRegistry | null
  requestHistory?: RequestHistoryService | undefined
  requestActivity?: InferenceActivity
  metrics?: MetricsCollector
  usageService?: UsageService | undefined
  /** Authorization already captured by a global Qualified Model admission decision. */
  authorization?: Extract<InferenceAuthorization, { readonly ok: true }>
}): Promise<Response> {
  const {
    request,
    providerId,
    upstreamPath,
    gatewayKeys,
    providers,
    inference,
    modelCatalog,
    timer,
    retrySleep,
    transport,
    adapterRegistry,
    timeouts,
    requestHistory,
    requestActivity,
    metrics,
    usageService,
  } = options
  const correlationId = newRequestId()
  const requestSignal = requestActivity?.signal ?? request.signal
  let streamingResponse = false
  try {
  const baseHeaders = { 'content-type': 'application/json', 'x-request-id': correlationId }
  const cors = await buildCorsHeaders({
    providerId,
    gatewayKeys,
    database: options.database ?? null,
    transport,
    request,
  })
  const responseHeaders = { ...baseHeaders, ...cors }

  const corsPreflight = await maybeCorsDeny({
    request,
    providerId,
    gatewayKeys,
    database: options.database ?? null,
    transport,
    correlationId,
    headers: responseHeaders,
  })
  if (corsPreflight !== null) return corsPreflight

  const envelope = readEnvelope(await request.text())

  if (!envelope.ok) {
    return error(
      envelope.status,
      responseHeaders,
      { code: envelope.code, message: envelope.message },
      correlationId,
    )
  }

  const token = bearerToken(request.headers)
  const authorization = options.authorization ?? await gatewayKeys.authorizeInference(providerId, envelope.model, token)
  if (!authorization.ok) {
    const refusal = authorizationRefusal(authorization)
    return error(refusal.status, responseHeaders, refusal, correlationId)
  }

  if (await modelCatalog.isExcluded(providerId, envelope.model)) {
    return error(
      403,
      responseHeaders,
      { code: 'model_excluded', message: 'This model is excluded on this Provider Connection.' },
      correlationId,
    )
  }

  const attemptedKeys: string[] = []
  const startedAt = timer.now()
  const retryPolicy = await providers.getProvider(providerId)
  const maxAttempts = retryPolicy?.retryMaxAttempts ?? MAX_INFERENCE_ATTEMPTS
  const retryAmbiguousNetwork = retryPolicy?.retryAmbiguousNetwork ?? false
  const totalRetryBudgetMs = retryPolicy?.totalRetryTimeoutMs ?? transport.totalRetryTimeoutMs
  // The route picks one Inference Adapter per Provider Connection. The
  // dispatch falls back to the single inference the route was assembled with
  // when no Adapter Registry is supplied (older callers and tests that build
  // a registry manually still get the same behaviour), and to the generic
  // adapter when the Provider's template id names no typed adapter.
  const providerAdapter = resolveAdapterForProvider({
    registry: adapterRegistry ?? null,
    templateId: retryPolicy?.templateId ?? null,
    fallback: inference,
  })
  const providerAdapterCapabilities = providerAdapter.capabilities
  let alternateUsed = false
  let sameKeyRetries = 0
  let ambiguousNetworkRetries = 0
  let lastUpstream: Awaited<ReturnType<InferenceAdapter['forward']>> | null = null
  let retainedTarget: InferenceTarget | null = null
  let lastAttemptRecorder: { readonly finalize: (outcome: AttemptTerminal) => Promise<void> } | null = null
  let lastAttemptKeyId: string | null = null
  let authoritativeExhaustionKnown = false

  const callerHeaders = headersOf(request)
  const inboundIdempotency = callerSuppliedIdempotency(callerHeaders, providerAdapterCapabilities.idempotencyHeader)
  const generatedIdempotency = inboundIdempotency === null && providerAdapterCapabilities.idempotencyGenerationSafe
    ? generateIdempotencyValue()
    : null

  const history = requestHistory?.beginRequest({
    id: correlationId,
    providerId,
    model: envelope.model,
    gatewayKeyId: authorization.keyId,
    gatewayKeyName: authorization.keyName,
  }) ?? null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (requestSignal.aborted) throw abortError()
    let target: InferenceTarget
    if (retainedTarget !== null) {
      target = retainedTarget
      retainedTarget = null
    } else {
      const resolution = await providers.resolveInference(
        providerId,
        envelope.model,
        attemptedKeys,
        alternateUsed,
      )
      if (!resolution.ok) {
        const refusal = authoritativeExhaustionKnown && resolution.failure.code === 'no_eligible_key'
          ? providerCapacityExhaustedRefusal()
          : resolutionRefusal(resolution.failure)
        const retryAfter = lastUpstream === null
          ? await providers.earliestRetryAfterSeconds(providerId)
          : numericRetryAfter(lastUpstream.headers)
            ?? await providers.earliestRetryAfterSeconds(providerId)
            ?? (lastUpstream.status === 429 ? 30 : null)
        await history?.recordSkip(refusal.code, new Date())
        return error(
          refusal.status,
          { ...responseHeaders, ...(retryAfter === null ? {} : { 'retry-after': String(retryAfter) }) },
          refusal,
          correlationId,
        )
      }
      target = resolution.value
    }

    lastAttemptKeyId = target.keyId
    lastAttemptRecorder = (await history?.startAttempt({
      attemptNumber: attempt,
      keyId: target.keyId,
      at: new Date(),
    })) ?? null

    const upstreamHeaders = buildUpstreamHeaders({
      callerHeaders,
      target,
      adapterCapabilities: providerAdapterCapabilities,
      inboundIdempotency,
      generatedIdempotency,
    })

    const forwardRequest: InferenceForwardRequest = {
      baseUrl: target.baseUrl,
      allowInsecureHttp: target.allowInsecureHttp,
      path: upstreamPath,
      method: 'POST',
      body: envelope.raw,
      headers: upstreamHeaders,
      upstreamKey: target.upstreamKey,
      signal: requestSignal,
      authHeader: target.authHeader,
      authPrefix: target.authPrefix,
      staticHeaders: target.staticHeaders,
      redirectAllowSameOrigin: target.redirectAllowSameOrigin,
      idempotencyHeader: target.idempotencyHeader,
      idempotencyGenerationSafe: providerAdapterCapabilities.idempotencyGenerationSafe,
      connectionTimeoutMs: target.connectionTimeoutMs,
      firstByteTimeoutMs: target.firstByteTimeoutMs,
      nonStreamingTotalTimeoutMs: target.nonStreamingTotalTimeoutMs,
      streamingIdleTimeoutMs: target.streamingIdleTimeoutMs,
      totalRetryTimeoutMs: target.totalRetryTimeoutMs,
    }

    if (envelope.stream) {
      const streamed = await streamChatCompletion(
        providerAdapter,
        timer,
        streamingTimeoutsFor(timeouts, target, transport),
        forwardRequest,
        responseHeaders,
        correlationId,
        {
          providerId,
          model: envelope.model,
          keyId: target.keyId,
          attemptNumber: attempt,
          endpointHost: safeHostname(target.baseUrl),
        },
      )
      if (streamed.status >= 200 && streamed.status < 300) {
        await providers.recordInferenceSuccess(target.keyId)
        await lastAttemptRecorder?.finalize({
          status: streamed.status,
          outcome: 'success',
          errorCode: null,
          retryAfterSeconds: null,
          at: new Date(),
        })
        await history?.finalize({
          status: streamed.status,
          outcome: 'success',
          isStreaming: true,
          latencyMs: timer.now() - startedAt,
          keyId: target.keyId,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          errorCode: null,
        })
        streamingResponse = true
        return monitorResponse(streamed, requestActivity)
      }
      const headerMap = Object.fromEntries(streamed.headers.entries())
      const classification = providerAdapter.classifyFailure(
        {
          kind: 'buffered', status: streamed.status, headers: headerMap, body: await streamed.clone().text(),
        },
        { keyId: target.keyId, observedAt: new Date() },
      )
      authoritativeExhaustionKnown = await reconcileInferenceCapacity({
        providers, usageService, providerId, keyId: target.keyId,
        model: envelope.model, classification,
      }) || authoritativeExhaustionKnown
      await providers.recordInferenceFailure({
        keyId: target.keyId,
        model: envelope.model,
        classification,
        reason: `upstream HTTP ${streamed.status}`,
      })
      const refusal = upstreamRefusal(streamed.status, headerMap)
      await lastAttemptRecorder?.finalize({
        status: streamed.status,
        outcome: 'failure',
        errorCode: refusal.code,
        retryAfterSeconds: numericRetryAfter(streamed.headers),
        diagnostics: classification.diagnostics,
        at: new Date(),
      })
      const status = streamed.status
      const boundedAlternate = isSingleAlternateFailure(classification.kind)
      if (classification.retryAction === 'try_alternate' && (!boundedAlternate || !alternateUsed) && attempt < maxAttempts) {
        if (boundedAlternate) alternateUsed = true
        attemptedKeys.push(target.keyId)
        metrics?.recordRetry()
        continue
      }
      if (classification.retryAction === 'retry_same' && sameKeyRetries < 1 && attempt < maxAttempts) {
        sameKeyRetries++
        retainedTarget = target
        await retrySleep(100, requestSignal)
        metrics?.recordRetry()
        continue
      }
      await history?.finalize({
        status: streamed.status,
        outcome: 'failure',
        isStreaming: true,
        latencyMs: timer.now() - startedAt,
        keyId: target.keyId,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        errorCode: refusal.code,
      })
      return streamed
    }

    try {
      lastUpstream = await providerAdapter.forward(forwardRequest)
    } catch (cause) {
      if (isAbort(cause)) {
        await lastAttemptRecorder?.finalize({
          status: null, outcome: 'failure', errorCode: 'request_cancelled',
          retryAfterSeconds: null, at: new Date(),
        })
        await history?.finalize({
          status: 499, outcome: 'failure', isStreaming: false,
          latencyMs: timer.now() - startedAt, keyId: target.keyId,
          promptTokens: null, completionTokens: null, totalTokens: null,
          errorCode: 'request_cancelled',
        })
        throw cause
      }
      if (isAnthropicForwardError(cause)) {
        const refusal = anthropicForwardRefusal(cause as AnthropicForwardErrorLike)
        await lastAttemptRecorder?.finalize({
          status: refusal.status,
          outcome: 'failure',
          errorCode: refusal.code,
          retryAfterSeconds: null,
          at: new Date(),
        })
        await history?.finalize({
          status: refusal.status,
          outcome: 'failure',
          isStreaming: false,
          latencyMs: timer.now() - startedAt,
          keyId: target.keyId,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          errorCode: refusal.code,
        })
        return error(
          refusal.status,
          { ...responseHeaders, ...(refusal.retryAfter ? { 'retry-after': refusal.retryAfter } : {}) },
          refusal,
          correlationId,
        )
      }
      await lastAttemptRecorder?.finalize({
        status: null,
        outcome: 'failure',
        errorCode: 'upstream_unreachable',
        retryAfterSeconds: null,
        at: new Date(),
      })
      if (
        retryAmbiguousNetwork &&
        ambiguousNetworkRetries < 1 &&
        attempt < maxAttempts &&
        timer.now() - startedAt < totalRetryBudgetMs
      ) {
        ambiguousNetworkRetries++
        retainedTarget = target
        await retrySleep(100, requestSignal)
        metrics?.recordRetry()
        continue
      }
      await history?.finalize({
        status: 502,
        outcome: 'failure',
        isStreaming: false,
        latencyMs: timer.now() - startedAt,
        keyId: target.keyId,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        errorCode: 'upstream_unreachable',
      })
      return error(
        502,
        responseHeaders,
        { code: 'upstream_unreachable', message: 'The Provider could not be reached.' },
        correlationId,
      )
    }

    if (lastUpstream.status >= 200 && lastUpstream.status < 300) {
      await providers.recordInferenceSuccess(target.keyId)
      const usage = lastUpstream.kind === 'buffered' ? parseUsage(lastUpstream.body) : { promptTokens: null, completionTokens: null, totalTokens: null }
      await lastAttemptRecorder?.finalize({
        status: lastUpstream.status,
        outcome: 'success',
        errorCode: null,
        retryAfterSeconds: null,
        at: new Date(),
      })
      await history?.finalize({
        status: lastUpstream.status,
        outcome: 'success',
        isStreaming: false,
        latencyMs: timer.now() - startedAt,
        keyId: target.keyId,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        errorCode: null,
      })
      return new Response(lastUpstream.kind === 'stream' ? lastUpstream.stream : lastUpstream.body, {
        status: lastUpstream.status,
        headers: {
          ...responseHeaders,
          'content-type': lastUpstream.headers['content-type'] ?? 'application/json',
        },
      })
    }

    const status = lastUpstream.status
    await logUpstreamFailure(lastUpstream, {
      requestId: correlationId,
      providerId,
      model: envelope.model,
      keyId: target.keyId,
      attemptNumber: attempt,
      endpointHost: safeHostname(target.baseUrl),
    })
    const classification = providerAdapter.classifyFailure(
      lastUpstream,
      { keyId: target.keyId, observedAt: new Date() },
    )
    authoritativeExhaustionKnown = await reconcileInferenceCapacity({
      providers, usageService, providerId, keyId: target.keyId,
      model: envelope.model, classification,
    }) || authoritativeExhaustionKnown
    await providers.recordInferenceFailure({
      keyId: target.keyId,
      model: envelope.model,
      classification,
      reason: `upstream HTTP ${status}`,
    })

    const refusal = upstreamRefusal(status, lastUpstream.headers)
    await lastAttemptRecorder?.finalize({
      status,
      outcome: 'failure',
      errorCode: refusal.code,
      retryAfterSeconds: numericRetryAfter(lastUpstream.headers),
      diagnostics: classification.diagnostics,
      at: new Date(),
    })

    const insideBudget = timer.now() - startedAt < totalRetryBudgetMs
    if (!insideBudget || requestSignal.aborted) break

    const boundedAlternate = isSingleAlternateFailure(classification.kind)
    if (classification.retryAction === 'try_alternate' && (!boundedAlternate || !alternateUsed)) {
      if (boundedAlternate) alternateUsed = true
      attemptedKeys.push(target.keyId)
      metrics?.recordRetry()
      continue
    }
    if (classification.retryAction === 'retry_same' && sameKeyRetries < 1) {
      sameKeyRetries++
      retainedTarget = target
      await retrySleep(100, requestSignal)
      metrics?.recordRetry()
      continue
    }
    break
  }

  if (lastUpstream === null) {
await history?.finalize({
    status: 503,
    outcome: 'failure',
    isStreaming: false,
    latencyMs: timer.now() - startedAt,
    keyId: lastAttemptKeyId,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    errorCode: 'upstream_credentials_unavailable',
  })
  return error(
    503,
    responseHeaders,
    { code: 'upstream_credentials_unavailable', message: 'No eligible Upstream Key is available for this connection.' },
    correlationId,
  )
}
  if (lastUpstream.status === 429) {
    const retryAfter = numericRetryAfter(lastUpstream.headers)
      ?? await providers.earliestRetryAfterSeconds(providerId)
    await history?.finalize({
      status: 503,
      outcome: 'failure',
      isStreaming: false,
      latencyMs: timer.now() - startedAt,
      keyId: lastAttemptKeyId,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorCode: 'upstream_credentials_unavailable',
    })
    return error(
      503,
      { ...responseHeaders, ...(retryAfter === null ? {} : { 'retry-after': String(retryAfter) }) },
      {
        code: 'upstream_credentials_unavailable',
        message: 'No eligible Upstream Key is available for this connection.',
      },
      correlationId,
    )
  }
  const refusal = upstreamRefusal(lastUpstream.status, lastUpstream.headers)
  if (authoritativeExhaustionKnown) {
    const exhausted = providerCapacityExhaustedRefusal()
    await history?.finalize({
      status: exhausted.status, outcome: 'failure', isStreaming: false,
      latencyMs: timer.now() - startedAt, keyId: lastAttemptKeyId,
      promptTokens: null, completionTokens: null, totalTokens: null,
      errorCode: exhausted.code,
    })
    return error(exhausted.status, responseHeaders, exhausted, correlationId)
  }
  await history?.finalize({
    status: refusal.status,
    outcome: 'failure',
    isStreaming: false,
    latencyMs: timer.now() - startedAt,
    keyId: lastAttemptKeyId,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    errorCode: refusal.code,
  })
  return error(
    refusal.status,
    { ...responseHeaders, ...(refusal.retryAfter ? { 'retry-after': refusal.retryAfter } : {}) },
    refusal,
    correlationId,
  )
  } finally {
    if (!streamingResponse) requestActivity?.finish()
  }
}

/**
 * The Anthropic-compatible `/v1/messages` public surface. Anthropic SDK
 * callers hit this route; the body is Anthropic-shape. When the Provider
 * Connection uses the `anthropic` template the body is forwarded verbatim to
 * upstream `/v1/messages`; when the Provider Connection uses any other
 * template the Anthropic adapter translates the body to OpenAI-shape, calls
 * upstream `/chat/completions`, and translates the response back to
 * Anthropic-shape.
 *
 * Error envelopes are Anthropic-shape (matching the caller's wire format).
 * Streaming SSE events follow Anthropic's documented event ordering whether
 * the upstream is Anthropic (passthrough) or an OpenAI-shaped Provider
 * (translated).
 */
async function forwardAnthropicMessages(options: {
  request: Request
  providerId: string
  database?: Database | null
  gatewayKeys: GatewayKeyRegistry
  providers: ProviderRegistry
  modelCatalog: ModelCatalogService
  timer: Timer
  timeouts?: StreamingTimeouts | undefined
  retrySleep: (ms: number, signal: AbortSignal) => Promise<void>
  transport: TransportDefaults
  adapterRegistry: AdapterRegistry | null
  requestHistory?: RequestHistoryService | undefined
  requestActivity?: InferenceActivity
  metrics?: MetricsCollector
  usageService?: UsageService | undefined
  /** Authorization already captured by a global Qualified Model admission decision. */
  authorization?: Extract<InferenceAuthorization, { readonly ok: true }>
}): Promise<Response> {
  const {
    request,
    providerId,
    providers,
    modelCatalog,
    timer,
    retrySleep,
    transport,
    adapterRegistry,
    timeouts,
    requestHistory,
    requestActivity,
    metrics,
    usageService,
    database,
  } = options

  const correlationId = newRequestId()
  const requestSignal = requestActivity?.signal ?? request.signal
  let streamingResponse = false

  try {
    const baseHeaders: Record<string, string> = {
      'content-type': 'application/json',
      'x-request-id': correlationId,
    }
    const cors = await buildCorsHeaders({
      providerId,
      gatewayKeys: options.gatewayKeys,
      database: database ?? null,
      transport,
      request,
    })
    const responseHeaders: Record<string, string> = { ...baseHeaders, ...cors }

    const corsPreflight = await maybeCorsDeny({
      request,
      providerId,
      gatewayKeys: options.gatewayKeys,
      database: database ?? null,
      transport,
      correlationId,
      headers: responseHeaders,
    })
    if (corsPreflight !== null) return corsPreflight

    const anthropicAdapter = adapterRegistry?.inferenceAdapter(ANTHROPIC_INFERENCE_ADAPTER_ID) ?? null
    if (anthropicAdapter === null || anthropicAdapter.forwardAnthropic === undefined) {
      return anthropicMessagesErrorResponse(
        404,
        'route_unavailable',
        'This Iroha build does not expose the Anthropic-compatible /v1/messages surface.',
        responseHeaders,
        correlationId,
      )
    }

    const envelope = readAnthropicEnvelope(await request.text())
    if (!envelope.ok) {
      return anthropicMessagesErrorResponse(
        envelope.status,
        envelope.code,
        envelope.message,
        responseHeaders,
        correlationId,
      )
    }

    const token = bearerToken(request.headers)
    const authorization = options.authorization ?? await options.gatewayKeys.authorizeInference(providerId, envelope.model, token)
    if (!authorization.ok) {
      const refusal = authorizationRefusal(authorization)
      return anthropicMessagesErrorResponse(
        refusal.status,
        refusal.code,
        refusal.message,
        responseHeaders,
        correlationId,
      )
    }

    if (await modelCatalog.isExcluded(providerId, envelope.model)) {
      return anthropicMessagesErrorResponse(
        403,
        'model_excluded',
        'This model is excluded on this Provider Connection.',
        responseHeaders,
        correlationId,
      )
    }

    const retryPolicy = await providers.getProvider(providerId)
    const templateId = retryPolicy?.templateId ?? null
    const passthrough = templateId === 'anthropic'
    const maxAttempts = retryPolicy?.retryMaxAttempts ?? MAX_INFERENCE_ATTEMPTS
    const retryAmbiguousNetwork = retryPolicy?.retryAmbiguousNetwork ?? false
    const totalRetryBudgetMs = retryPolicy?.totalRetryTimeoutMs ?? transport.totalRetryTimeoutMs

    const attemptedKeys: string[] = []
    const startedAt = timer.now()
    let alternateUsed = false
    let sameKeyRetries = 0
    let ambiguousNetworkRetries = 0
    let lastUpstream: InferenceForwardResult | null = null
    let retainedTarget: InferenceTarget | null = null
    let lastAttemptRecorder: { readonly finalize: (outcome: AttemptTerminal) => Promise<void> } | null = null
    let lastAttemptKeyId: string | null = null

    const callerHeaders = headersOf(request)
    const providerAdapterCapabilities = anthropicAdapter.capabilities
    const inboundIdempotency = callerSuppliedIdempotency(callerHeaders, providerAdapterCapabilities.idempotencyHeader)
    const generatedIdempotency = inboundIdempotency === null && providerAdapterCapabilities.idempotencyGenerationSafe
      ? generateIdempotencyValue()
      : null

    const history = requestHistory?.beginRequest({
      id: correlationId,
      providerId,
      model: envelope.model,
      gatewayKeyId: authorization.keyId,
      gatewayKeyName: authorization.keyName,
    }) ?? null

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (requestSignal.aborted) throw abortError()

      let target: InferenceTarget
      if (retainedTarget !== null) {
        target = retainedTarget
        retainedTarget = null
      } else {
        const resolution = await providers.resolveInference(
          providerId,
          envelope.model,
          attemptedKeys,
          alternateUsed,
        )
        if (!resolution.ok) {
          // For the Anthropic-shape route the Anthropic SDK expects to see
          // the upstream's actual error envelope, not an Iroha-shaped
          // `upstream_credentials_unavailable` wrapper. When the retry loop
          // exhausted the eligible keys but we did get at least one
          // non-success upstream answer, surface that envelope verbatim
          // (passthrough mode) or translated (OpenAI-shape → Anthropic-shape).
          if (lastUpstream !== null && lastUpstream.kind === 'buffered') {
            await history?.finalize({
              status: lastUpstream.status,
              outcome: 'failure',
              isStreaming: false,
              latencyMs: timer.now() - startedAt,
              keyId: lastAttemptKeyId,
              promptTokens: null,
              completionTokens: null,
              totalTokens: null,
              errorCode: resolutionRefusal(resolution.failure).code,
            })
            const retryAfter = numericRetryAfter(lastUpstream.headers) ?? (lastUpstream.status === 429 ? 30 : null)
            return returnLastUpstreamAsAnthropic(
              lastUpstream,
              { ...responseHeaders, ...(retryAfter === null ? {} : { 'retry-after': String(retryAfter) }) },
              correlationId,
            )
          }
          const refusal = resolutionRefusal(resolution.failure)
          const retryAfter = await providers.earliestRetryAfterSeconds(providerId)
          await history?.recordSkip(refusal.code, new Date())
          return anthropicMessagesErrorResponse(
            refusal.status,
            refusal.code,
            refusal.message,
            { ...responseHeaders, ...(retryAfter === null ? {} : { 'retry-after': String(retryAfter) }) },
            correlationId,
          )
        }
        target = resolution.value
      }

      lastAttemptKeyId = target.keyId
      lastAttemptRecorder = (await history?.startAttempt({
        attemptNumber: attempt,
        keyId: target.keyId,
        at: new Date(),
      })) ?? null

      const upstreamHeaders = buildUpstreamHeaders({
        callerHeaders,
        target,
        adapterCapabilities: providerAdapterCapabilities,
        inboundIdempotency,
        generatedIdempotency,
      })

      const forwardRequest: InferenceForwardRequest = {
        baseUrl: target.baseUrl,
        allowInsecureHttp: target.allowInsecureHttp,
        path: '/messages',
        method: 'POST',
        body: envelope.raw,
        headers: upstreamHeaders,
        upstreamKey: target.upstreamKey,
        signal: requestSignal,
        authHeader: target.authHeader,
        authPrefix: target.authPrefix,
        staticHeaders: target.staticHeaders,
        redirectAllowSameOrigin: target.redirectAllowSameOrigin,
        idempotencyHeader: target.idempotencyHeader,
        idempotencyGenerationSafe: providerAdapterCapabilities.idempotencyGenerationSafe,
        connectionTimeoutMs: target.connectionTimeoutMs,
        firstByteTimeoutMs: target.firstByteTimeoutMs,
        nonStreamingTotalTimeoutMs: target.nonStreamingTotalTimeoutMs,
        streamingIdleTimeoutMs: target.streamingIdleTimeoutMs,
        totalRetryTimeoutMs: target.totalRetryTimeoutMs,
      }

      if (envelope.stream) {
        if (anthropicAdapter.forwardAnthropic === undefined) {
          return anthropicMessagesErrorResponse(
            404,
            'route_unavailable',
            'This Iroha build does not expose the Anthropic-compatible /v1/messages surface.',
            responseHeaders,
            correlationId,
          )
        }
        const streamed = await streamAnthropicMessages(
          { forwardAnthropic: anthropicAdapter.forwardAnthropic, classifyFailure: anthropicAdapter.classifyFailure },
          timer,
          forwardRequest,
          passthrough,
          streamingTimeoutsFor(timeouts, target, transport),
          responseHeaders,
          correlationId,
        )
        if (streamed.status >= 200 && streamed.status < 300) {
          await providers.recordInferenceSuccess(target.keyId)
          await lastAttemptRecorder?.finalize({
            status: streamed.status,
            outcome: 'success',
            errorCode: null,
            retryAfterSeconds: null,
            at: new Date(),
          })
          await history?.finalize({
            status: streamed.status,
            outcome: 'success',
            isStreaming: true,
            latencyMs: timer.now() - startedAt,
            keyId: target.keyId,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            errorCode: null,
          })
          streamingResponse = true
          return monitorResponse(streamed, requestActivity)
        }
        const headerMap = Object.fromEntries(streamed.headers.entries())
        const classification = anthropicAdapter.classifyFailure({
          kind: 'buffered', status: streamed.status, headers: headerMap, body: '',
        })
        await providers.recordInferenceFailure({
          keyId: target.keyId,
          model: envelope.model,
          classification,
          reason: `upstream HTTP ${streamed.status}`,
        })
        const refusal = upstreamRefusal(streamed.status, headerMap)
        await lastAttemptRecorder?.finalize({
          status: streamed.status,
          outcome: 'failure',
          errorCode: refusal.code,
          retryAfterSeconds: numericRetryAfter(streamed.headers),
          at: new Date(),
        })
        const status = streamed.status
        const boundedAlternate = isSingleAlternateFailure(classification.kind)
        if (classification.retryAction === 'try_alternate' && (!boundedAlternate || !alternateUsed) && attempt < maxAttempts) {
          if (boundedAlternate) alternateUsed = true
          attemptedKeys.push(target.keyId)
          metrics?.recordRetry()
          continue
        }
        if (classification.retryAction === 'retry_same' && sameKeyRetries < 1 && attempt < maxAttempts) {
          sameKeyRetries++
          retainedTarget = target
          await retrySleep(100, requestSignal)
          metrics?.recordRetry()
          continue
        }
        await history?.finalize({
          status: streamed.status,
          outcome: 'failure',
          isStreaming: true,
          latencyMs: timer.now() - startedAt,
          keyId: target.keyId,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          errorCode: refusal.code,
        })
        return anthropicMessagesUpstreamResponse(streamed, responseHeaders, correlationId)
      }

      try {
        lastUpstream = await anthropicAdapter.forwardAnthropic!({
          ...forwardRequest,
          passthrough,
        })
      } catch (cause) {
        if (isAbort(cause)) {
          await lastAttemptRecorder?.finalize({
            status: null, outcome: 'failure', errorCode: 'request_cancelled',
            retryAfterSeconds: null, at: new Date(),
          })
          await history?.finalize({
            status: 499, outcome: 'failure', isStreaming: false,
            latencyMs: timer.now() - startedAt, keyId: target.keyId,
            promptTokens: null, completionTokens: null, totalTokens: null,
            errorCode: 'request_cancelled',
          })
          throw cause
        }
        if (isAnthropicForwardError(cause)) {
          const refusal = anthropicForwardRefusal(cause as AnthropicForwardErrorLike)
          await lastAttemptRecorder?.finalize({
            status: refusal.status,
            outcome: 'failure',
            errorCode: refusal.code,
            retryAfterSeconds: null,
            at: new Date(),
          })
          await history?.finalize({
            status: refusal.status,
            outcome: 'failure',
            isStreaming: false,
            latencyMs: timer.now() - startedAt,
            keyId: target.keyId,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            errorCode: refusal.code,
          })
          return anthropicMessagesErrorResponse(
            refusal.status,
            refusal.code,
            refusal.message,
            responseHeaders,
            correlationId,
          )
        }
        await lastAttemptRecorder?.finalize({
          status: null,
          outcome: 'failure',
          errorCode: 'upstream_unreachable',
          retryAfterSeconds: null,
          at: new Date(),
        })
        if (
          retryAmbiguousNetwork &&
          ambiguousNetworkRetries < 1 &&
          attempt < maxAttempts &&
          timer.now() - startedAt < totalRetryBudgetMs
        ) {
          ambiguousNetworkRetries++
          retainedTarget = target
          await retrySleep(100, requestSignal)
          metrics?.recordRetry()
          continue
        }
        await history?.finalize({
          status: 502,
          outcome: 'failure',
          isStreaming: false,
          latencyMs: timer.now() - startedAt,
          keyId: target.keyId,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          errorCode: 'upstream_unreachable',
        })
        return anthropicMessagesErrorResponse(
          502,
          'upstream_unreachable',
          'The Provider could not be reached.',
          responseHeaders,
          correlationId,
        )
      }

      if (lastUpstream.status >= 200 && lastUpstream.status < 300) {
        await providers.recordInferenceSuccess(target.keyId)
        await lastAttemptRecorder?.finalize({
          status: lastUpstream.status,
          outcome: 'success',
          errorCode: null,
          retryAfterSeconds: null,
          at: new Date(),
        })
        await history?.finalize({
          status: lastUpstream.status,
          outcome: 'success',
          isStreaming: false,
          latencyMs: timer.now() - startedAt,
          keyId: target.keyId,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
          errorCode: null,
        })
        const responseHeadersWithContentType: Record<string, string> = {
          ...responseHeaders,
          'content-type': lastUpstream.headers['content-type'] ?? 'application/json',
        }
        if (lastUpstream.kind === 'stream') {
          return new Response(lastUpstream.stream, {
            status: lastUpstream.status,
            headers: responseHeadersWithContentType,
          })
        }
        return new Response(lastUpstream.body, {
          status: lastUpstream.status,
          headers: responseHeadersWithContentType,
        })
      }

      const status = lastUpstream.status
      const classification = anthropicAdapter.classifyFailure(lastUpstream)
      await providers.recordInferenceFailure({
        keyId: target.keyId,
        model: envelope.model,
        classification,
        reason: `upstream HTTP ${status}`,
      })

      const refusal = upstreamRefusal(status, lastUpstream.headers)
      await lastAttemptRecorder?.finalize({
        status,
        outcome: 'failure',
        errorCode: refusal.code,
        retryAfterSeconds: numericRetryAfter(lastUpstream.headers),
        at: new Date(),
      })

      const insideBudget = timer.now() - startedAt < totalRetryBudgetMs
      if (!insideBudget || requestSignal.aborted) break

      const boundedAlternate = isSingleAlternateFailure(classification.kind)
      if (classification.retryAction === 'try_alternate' && (!boundedAlternate || !alternateUsed)) {
        if (boundedAlternate) alternateUsed = true
        attemptedKeys.push(target.keyId)
        metrics?.recordRetry()
        continue
      }
      if (classification.retryAction === 'retry_same' && sameKeyRetries < 1) {
        sameKeyRetries++
        retainedTarget = target
        await retrySleep(100, requestSignal)
        metrics?.recordRetry()
        continue
      }
      break
    }

    if (lastUpstream === null) {
      await history?.finalize({
        status: 503,
        outcome: 'failure',
        isStreaming: false,
        latencyMs: timer.now() - startedAt,
        keyId: lastAttemptKeyId,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        errorCode: 'upstream_credentials_unavailable',
      })
      return anthropicMessagesErrorResponse(
        503,
        'upstream_credentials_unavailable',
        'No eligible Upstream Key is available for this connection.',
        responseHeaders,
        correlationId,
      )
    }
    if (lastUpstream.status === 429) {
      const retryAfter = await providers.earliestRetryAfterSeconds(providerId)
      await history?.finalize({
        status: 503,
        outcome: 'failure',
        isStreaming: false,
        latencyMs: timer.now() - startedAt,
        keyId: lastAttemptKeyId,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        errorCode: 'upstream_credentials_unavailable',
      })
      return anthropicMessagesErrorResponse(
        503,
        'upstream_credentials_unavailable',
        'No eligible Upstream Key is available for this connection.',
        { ...responseHeaders, ...(retryAfter === null ? {} : { 'retry-after': String(retryAfter) }) },
        correlationId,
      )
    }
    const refusal = upstreamRefusal(lastUpstream.status, lastUpstream.headers)
    await history?.finalize({
      status: refusal.status,
      outcome: 'failure',
      isStreaming: false,
      latencyMs: timer.now() - startedAt,
      keyId: lastAttemptKeyId,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      errorCode: refusal.code,
    })
    return anthropicMessagesUpstreamResponse(
      makeBufferedFromForward(lastUpstream),
      { ...responseHeaders, ...(refusal.retryAfter ? { 'retry-after': refusal.retryAfter } : {}) },
      correlationId,
    )
  } finally {
    if (!streamingResponse) requestActivity?.finish()
  }
}

/**
 * The Anthropic-shape envelope: the caller's body is Anthropic-shape and
 * carries a top-level `model`. Other fields are unknown to the route; the
 * adapter forwards them unchanged.
 */
type AnthropicMessagesEnvelope =
  | { readonly ok: true; readonly model: string; readonly raw: string; readonly stream: boolean }
  | { readonly ok: false; readonly status: 400; readonly code: string; readonly message: string }

function readAnthropicEnvelope(raw: string): AnthropicMessagesEnvelope {
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
  return {
    ok: true,
    model: model.trim(),
    raw,
    stream: (parsed as Record<string, unknown>).stream === true,
  }
}

/**
 * Returns an Anthropic-shape error envelope: `{type: "error", error: {type,
 * message}, request_id}`. The Iroha code is preserved in the `error.type`
 * field so callers can branch on it; the upstream HTTP status is preserved.
 */
function anthropicMessagesErrorResponse(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string>,
  correlationId: string,
): Response {
  return new Response(
    JSON.stringify({
      type: 'error',
      error: { type: code, message },
      request_id: correlationId,
    }),
    { status, headers: { ...headers, 'content-type': 'application/json' } },
  )
}

/**
 * Surfaces the last upstream answer to the Anthropic SDK caller. The body is
 * either an Anthropic-shape error envelope (passthrough mode) or an
 * OpenAI-shape error envelope (OpenAI-Provider mode); the latter is
 * translated to Anthropic-shape here so the caller gets a consistent wire
 * format.
 */
function returnLastUpstreamAsAnthropic(
  lastUpstream: InferenceForwardResult,
  baseHeaders: Record<string, string>,
  correlationId: string,
): Response {
  if (lastUpstream.kind !== 'buffered') {
    return anthropicMessagesErrorResponse(
      lastUpstream.status,
      'upstream_error',
      'The Provider answered with an error.',
      baseHeaders,
      correlationId,
    )
  }
  if (looksLikeOpenAiError(lastUpstream.body)) {
    const envelope = translateBufferedUpstreamErrorToAnthropic(lastUpstream.status, lastUpstream.body, correlationId)
    return new Response(JSON.stringify(envelope), {
      status: lastUpstream.status,
      headers: { ...baseHeaders, 'content-type': 'application/json' },
    })
  }
  // Already Anthropic-shape (passthrough mode) — return verbatim.
  return new Response(lastUpstream.body, {
    status: lastUpstream.status,
    headers: { ...baseHeaders, 'content-type': lastUpstream.headers['content-type'] ?? 'application/json' },
  })
}

/**
 * The streaming sibling of {@link returnLastUpstreamAsAnthropic}. The body
 * already carries Anthropic-shape (passthrough) or the OpenAI-shape error
 * was translated by {@link streamAnthropicMessages} before this is called;
 * either way we just surface the response.
 */
function anthropicMessagesUpstreamResponse(
  response: Response,
  baseHeaders: Record<string, string>,
  _correlationId: string,
): Response {
  const headers: Record<string, string> = {
    ...baseHeaders,
    'content-type': response.headers.get('content-type') ?? 'application/json',
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  })
}

/**
 * Reads the upstream body and returns a fresh Response with the same status
 * and headers. Used by the non-streaming retry loop where the upstream
 * answered with an error status.
 */
function makeBufferedFromForward(result: InferenceForwardResult): Response {
  const body = result.kind === 'buffered' ? result.body : ''
  const headers: Record<string, string> = { ...result.headers, 'content-type': result.headers['content-type'] ?? 'application/json' }
  return new Response(body, { status: result.status, headers })
}

function looksLikeOpenAiError(rawBody: string): boolean {
  if (rawBody === '') return false
  try {
    const parsed = JSON.parse(rawBody) as { error?: unknown }
    return typeof parsed === 'object' && parsed !== null && typeof parsed.error === 'object'
  } catch {
    return false
  }
}

function translateBufferedUpstreamErrorToAnthropic(
  status: number,
  rawBody: string,
  correlationId: string,
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    parsed = null
  }
  const anthropicType = openAiStatusToAnthropicType(status)
  const message = readOpenAiErrorMessageFromParse(parsed, rawBody)
  return {
    type: 'error',
    error: { type: anthropicType, message },
    request_id: correlationId,
  }
}

function readOpenAiErrorMessageFromParse(parsed: unknown, rawBody: string): string {
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const err = (parsed as Record<string, unknown>).error
    if (typeof err === 'object' && err !== null && !Array.isArray(err)) {
      const msg = (err as Record<string, unknown>).message
      if (typeof msg === 'string' && msg.length > 0) return msg
    }
  }
  if (rawBody.length > 0) return rawBody
  return 'The Provider answered with an error.'
}

function openAiStatusToAnthropicType(status: number): string {
  switch (status) {
    case 400:
      return 'invalid_request_error'
    case 401:
      return 'authentication_error'
    case 403:
      return 'permission_error'
    case 404:
      return 'not_found_error'
    case 409:
      return 'conflict_error'
    case 413:
      return 'request_too_large'
    case 429:
      return 'rate_limit_error'
    case 500:
      return 'api_error'
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error'
  }
}

/**
 * Reads a {@link ReadableStream} of bytes into a UTF-8 string. Used when an
 * upstream error arrives on a stream-shaped {@link InferenceForwardResult}
 * (the non-streaming path returns a buffered body directly).
 */
async function readStreamAsText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      out += decoder.decode(next.value, { stream: true })
    }
    out += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return out
}

/**
 * The streaming sibling of `forwardAnthropicMessages`. Streams Anthropic
 * SSE events back to the caller; the Anthropic adapter handles the
 * passthrough-vs-translate decision via `forwardAnthropic({passthrough})`.
 */
async function streamAnthropicMessages(
  anthropicAdapter: {
    forwardAnthropic: NonNullable<InferenceAdapter['forwardAnthropic']>
    classifyFailure: InferenceAdapter['classifyFailure']
  },
  timer: Timer,
  forwardRequest: InferenceForwardRequest,
  passthrough: boolean,
  timeouts: StreamingTimeouts,
  baseHeaders: Record<string, string>,
  correlationId: string,
): Promise<Response> {
  const upstream = new AbortController()
  const abortUpstream = () => upstream.abort()
  const callerAbort = () => abortUpstream()
  forwardRequest.signal?.addEventListener('abort', callerAbort, { once: true })
  if (forwardRequest.signal?.aborted === true) abortUpstream()

  let answer: Awaited<ReturnType<NonNullable<typeof anthropicAdapter>['forwardAnthropic']>>
  try {
    answer = await anthropicAdapter.forwardAnthropic({
      ...forwardRequest,
      stream: true,
      signal: upstream.signal,
      passthrough,
    })
  } catch (cause) {
    if (isAbort(cause)) throw cause
    return anthropicMessagesErrorResponse(
      502,
      'upstream_unreachable',
      'The Provider could not be reached.',
      baseHeaders,
      correlationId,
    )
  }

  if (answer.status < 200 || answer.status >= 300) {
    const rawBody = answer.kind === 'buffered'
      ? await Promise.resolve(answer.body)
      : await readStreamAsText(answer.stream)
    if (looksLikeOpenAiError(rawBody)) {
      const envelope = translateBufferedUpstreamErrorToAnthropic(answer.status, rawBody, correlationId)
      return new Response(JSON.stringify(envelope), {
        status: answer.status,
        headers: { ...baseHeaders, 'content-type': 'application/json' },
      })
    }
    return new Response(rawBody, {
      status: answer.status,
      headers: {
        ...baseHeaders,
        'content-type': answer.headers['content-type'] ?? 'application/json',
      },
    })
  }

  if (answer.kind !== 'stream') {
    return new Response(answer.body, {
      status: answer.status,
      headers: {
        ...baseHeaders,
        'content-type': answer.headers['content-type'] ?? 'application/json',
      },
    })
  }

  const guarded = deadlineGuard(answer.stream, {
    timer,
    timeouts,
    signal: upstream.signal,
    abort: abortUpstream,
  })

  return new Response(guarded.stream, {
    status: answer.status,
    headers: {
      ...baseHeaders,
      'content-type': answer.headers['content-type'] ?? 'text/event-stream',
    },
  })
}

/** Adds the Iroha-managed authentication, static, and idempotency headers to a forwarded request. */
function buildUpstreamHeaders(options: {
  callerHeaders: Readonly<Record<string, string>>
  target: InferenceTarget
  adapterCapabilities: InferenceAdapterCapabilities
  inboundIdempotency: string | null
  generatedIdempotency: string | null
}): Readonly<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.callerHeaders)) {
    if (!shouldForwardHeader(name)) continue
    result[name] = value
  }
  const authValue = options.target.authPrefix + options.target.upstreamKey
  result[options.target.authHeader.toLowerCase()] = authValue
  for (const [name, value] of Object.entries(options.target.staticHeaders)) {
    if (name.toLowerCase() === options.target.authHeader.toLowerCase()) continue
    result[name.toLowerCase()] = value
  }
  if (options.inboundIdempotency !== null) {
    result[options.adapterCapabilities.idempotencyHeader.toLowerCase()] = options.inboundIdempotency
  } else if (options.generatedIdempotency !== null) {
    result[options.adapterCapabilities.idempotencyHeader.toLowerCase()] = options.generatedIdempotency
  }
  return result
}

const FORWARD_BLOCKED_HEADERS = adapterBlockedHeaders

function shouldForwardHeader(name: string): boolean {
  if (FORWARD_BLOCKED_HEADERS.has(name.toLowerCase())) return false
  if (name.toLowerCase().startsWith('iroha-')) return false
  return true
}

function numericRetryAfter(headers: Readonly<Record<string, string>> | Headers): number | null {
  const value = headers instanceof Headers ? headers.get('retry-after') : headers['retry-after']
  if (value === null || value === undefined || !/^\d+$/.test(value.trim())) return null
  return Number(value.trim())
}

function sleepWithTimer(timer: Timer): (ms: number, signal: AbortSignal) => Promise<void> {
  return async (ms, signal) => {
    await new Promise<void>((resolve, reject) => {
      const cancel = timer.set(resolve, ms)
      signal.addEventListener(
        'abort',
        () => {
          cancel()
          reject(abortError())
        },
        { once: true },
      )
    })
  }
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' })
}

/**
 * The routing-critical envelope: the exact request model. Everything else is
 * unknown by design and travels upstream byte-for-byte, so Provider extensions
 * and newer fields need no Iroha release.
 */
type Envelope =
  | { readonly ok: true; readonly model: string; readonly raw: string; readonly stream: boolean }
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

  return { ok: true, model: model.trim(), raw, stream: (parsed as Record<string, unknown>).stream === true }
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
        code: 'provider_not_allowed',
        message: 'This Gateway Key is not allowed to use that Provider.',
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
    case 'provider_not_found':
      return { status: 404, code: 'provider_not_found', message: 'No such Provider.' }
    case 'provider_archived':
      return {
        status: 409,
        code: 'provider_archived',
        message: 'This Provider is archived and serves no inference.',
      }
    case 'provider_disabled':
      return {
        status: 409,
        code: 'provider_disabled',
        message: 'This Provider is disabled and serves no inference.',
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

function providerHandleError(
  code: 'invalid_provider_handle' | 'provider_not_allowed',
  correlationId = newRequestId(),
): Response {
  const refusal = code === 'invalid_provider_handle'
    ? { status: 400, code, message: 'The Provider Handle is invalid.' }
    : { status: 403, code, message: 'This Gateway Key is not allowed to use that Provider.' }
  return error(refusal.status, { 'content-type': 'application/json', 'x-request-id': correlationId }, refusal, correlationId)
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

function providerCapacityExhaustedRefusal(): Refusal {
  return {
    status: 503,
    code: 'provider_capacity_exhausted',
    message: 'Authoritative Provider entitlement shows no remaining capacity.',
  }
}

/**
 * Uses fresh entitlement immediately. A positive entitlement does not erase
 * the observed failure: it becomes a short authoritative cooldown. Missing or
 * stale authority starts one deduplicated refresh without delaying failover.
 */
async function reconcileInferenceCapacity(input: {
  readonly providers: ProviderRegistry
  readonly usageService: UsageService | undefined
  readonly providerId: string
  readonly keyId: string
  readonly model: string
  readonly classification: InferenceFailureClassification
}): Promise<boolean> {
  if (input.classification.capacityEvidence === undefined || input.usageService === undefined) {
    return false
  }

  const authoritative = await input.usageService.capacityEvidenceFor(
    input.providerId,
    input.keyId,
    60_000,
  )
  if (authoritative.length === 0) {
    void input.usageService.refreshAfterCapacityFailure(input.providerId).catch(() => undefined)
    return false
  }

  const exhausted = authoritative.filter((evidence) => evidenceEstablishesExhaustion(evidence))
  const evidence = exhausted.length > 0
    ? exhausted
    : authoritative.map((item) => cooldownEvidence(item, input.classification))
  await input.providers.reconcileCapacityEvidence({
    providerId: input.providerId,
    keyId: input.keyId,
    model: input.model,
    capacityEvidence: evidence,
  })
  return exhausted.length > 0
}

function evidenceEstablishesExhaustion(evidence: CapacityEvidence): boolean {
  return evidence.availability === 'exhausted'
    || evidence.facts.remaining !== undefined && evidence.facts.remaining <= 0
    || evidence.facts.remainingPercent !== undefined && evidence.facts.remainingPercent <= 0
}

function cooldownEvidence(
  evidence: CapacityEvidence,
  classification: InferenceFailureClassification,
): CapacityEvidence {
  const seconds = Math.max(1, classification.retryAfterSeconds ?? 30)
  const failureObservedAt = classification.capacityEvidence?.observedAt ?? evidence.observedAt
  const retryAt = new Date(failureObservedAt.getTime() + seconds * 1_000)
  return {
    ...evidence,
    availability: 'temporarily_limited',
    reason: 'temporarily_limited',
    observedAt: failureObservedAt,
    freshUntil: retryAt,
    recheckAt: retryAt,
    diagnostics: {
      ...evidence.diagnostics,
      ...classification.diagnostics,
      classification: 'capacity_limited',
      capacityScope: evidence.scope.kind,
      retryAfterSeconds: seconds,
      retryAt: retryAt.toISOString(),
    },
  }
}

/** Failures whose alternate-key retry is deliberately capped at one. */
function isSingleAlternateFailure(kind: InferenceFailureKind): boolean {
  return kind === 'capacity_limited' ||
    kind === 'payment_required' ||
    kind === 'content_inspection_failed'
}

/** One OpenAI-shaped error: message, type, param, stable code, and correlation. */
function error(
  status: number,
  headers: Record<string, string>,
  refusal: { code: string; message: string },
  correlationId: string,
  upstreamCode?: string | null,
  upstreamType?: string | null,
): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: refusal.message,
        type: errorType(status),
        param: null,
        code: refusal.code,
        request_id: correlationId,
        ...(upstreamCode === null || upstreamCode === undefined ? {} : { upstream_code: upstreamCode }),
        ...(upstreamType === null || upstreamType === undefined ? {} : { upstream_type: upstreamType }),
      },
    }),
    { status, headers },
  )
}

function shuttingDownError(): Response {
  const correlationId = newRequestId()
  return error(
    503,
    { 'content-type': 'application/json', 'x-request-id': correlationId },
    { code: 'upstream_credentials_unavailable', message: 'Iroha is shutting down and cannot accept inference.' },
    correlationId,
  )
}

function monitorResponse(response: Response, activity: InferenceActivity | undefined): Response {
  if (activity === undefined) return response
  if (response.body === null) {
    activity.finish()
    return response
  }

  let completed = false
  const finish = () => {
    if (completed) return
    completed = true
    activity.finish()
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = response.body!.getReader()
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) {
            finish()
            controller.close()
            return
          }
          controller.enqueue(chunk.value)
        }
      } catch (cause) {
        finish()
        controller.error(cause)
      }
    },
    async cancel(reason) {
      await response.body!.cancel(reason)
      finish()
    },
  })
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function errorType(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

function headersOf(request: Request): Readonly<Record<string, string>> {
  return Object.fromEntries(request.headers.entries())
}

function newRequestId(): string {
  return `req_${randomBytes(16).toString('base64url')}`
}

/**
 * The streaming answer. The upstream SSE body flows straight to the caller,
 * guarded by first-byte and idle deadlines, and aborts the instant the caller
 * goes away. Failures before the upstream answer arrives keep the normal
 * OpenAI-shaped error contract; after the first byte reaches the caller the
 * only honest outcome is the stream ending, never an error JSON swapped in
 * mid-stream.
 */
async function streamChatCompletion(
  inference: InferenceAdapter,
  timer: Timer,
  timeouts: StreamingTimeouts,
  request: InferenceForwardRequest,
  baseHeaders: Record<string, string>,
  correlationId: string,
  diagnosticContext: UpstreamFailureDiagnosticContext,
): Promise<Response> {
  const upstream = new AbortController()
  const abortUpstream = () => upstream.abort()
  const callerAbort = () => abortUpstream()
  request.signal?.addEventListener('abort', callerAbort, { once: true })
  if (request.signal?.aborted === true) abortUpstream()

  let answer
  try {
    answer = await inference.forward({ ...request, stream: true, signal: upstream.signal })
  } catch (cause) {
    // The caller went away, or the upstream was unreachable before any byte
    // could be emitted; both keep the buffered error contract.
    if (isAbort(cause)) throw cause
    return error(
      502,
      baseHeaders,
      { code: 'upstream_unreachable', message: 'The Provider could not be reached.' },
      correlationId,
    )
  }

  if (answer.status < 200 || answer.status >= 300) {
    const diagnostic = await logUpstreamFailure(answer, {
      ...diagnosticContext,
      requestId: correlationId,
    })
    const refusal = upstreamRefusal(answer.status, answer.headers)
    return error(
      refusal.status,
      { ...baseHeaders, ...(refusal.retryAfter ? { 'retry-after': refusal.retryAfter } : {}) },
      refusal,
      correlationId,
      typeof diagnostic.upstreamCode === 'string' ? diagnostic.upstreamCode : null,
      typeof diagnostic.upstreamType === 'string' ? diagnostic.upstreamType : null,
    )
  }

  if (answer.kind !== 'stream') {
    // A buffered answer to a streaming request (e.g. a provider that ignored
    // `stream: true`) is delivered as the finished body it already is.
    return new Response(answer.body, {
      status: answer.status,
      headers: {
        ...baseHeaders,
        'content-type': answer.headers['content-type'] ?? 'text/event-stream',
      },
    })
  }

  const guarded = deadlineGuard(answer.stream, {
    timer,
    timeouts,
    signal: upstream.signal,
    abort: abortUpstream,
  })

  return new Response(guarded.stream, {
    status: answer.status,
    headers: {
      ...baseHeaders,
      'content-type': answer.headers['content-type'] ?? 'text/event-stream',
    },
  })
}

interface UpstreamFailureDiagnosticContext {
  readonly providerId: string
  readonly model: string
  readonly keyId: string
  readonly attemptNumber: number
  readonly endpointHost: string | null
}

interface UpstreamFailureDiagnosticInput extends UpstreamFailureDiagnosticContext {
  readonly requestId: string
  readonly status: number
  readonly body: string
}

async function logUpstreamFailure(
  answer: InferenceForwardResult,
  context: UpstreamFailureDiagnosticContext & { readonly requestId: string },
): Promise<Record<string, unknown>> {
  const body = await readBoundedUpstreamError(answer)
  const diagnostic = upstreamFailureDiagnostic({
    ...context,
    status: answer.status,
    body,
  })
  console.warn(JSON.stringify(diagnostic))
  return diagnostic
}

const UPSTREAM_ERROR_BODY_LIMIT = 16_384
/** Builds the only upstream-body-derived object allowed into inference logs. */
export function upstreamFailureDiagnostic(input: UpstreamFailureDiagnosticInput): Record<string, unknown> {
  const fields = safeUpstreamErrorFields(input.body)
  return {
    event: 'upstream_inference_failure',
    requestId: input.requestId,
    providerId: input.providerId,
    model: input.model,
    keyId: input.keyId,
    attemptNumber: input.attemptNumber,
    endpointHost: input.endpointHost,
    status: input.status,
    upstreamCode: fields.code,
    upstreamType: fields.type,
    upstreamRequestId: fields.requestId,
  }
}

async function readBoundedUpstreamError(answer: InferenceForwardResult): Promise<string> {
  if (answer.kind === 'buffered') return answer.body.slice(0, UPSTREAM_ERROR_BODY_LIMIT)
  const reader = answer.stream.getReader()
  const decoder = new TextDecoder()
  let out = ''
  try {
    while (out.length < UPSTREAM_ERROR_BODY_LIMIT) {
      const chunk = await reader.read()
      if (chunk.done) break
      out += decoder.decode(chunk.value, { stream: true })
    }
    out += decoder.decode()
  } catch {
    // The structural HTTP failure remains useful even when its body breaks.
  } finally {
    if (out.length >= UPSTREAM_ERROR_BODY_LIMIT) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return out.slice(0, UPSTREAM_ERROR_BODY_LIMIT)
}

function safeUpstreamErrorFields(body: string): { code: string | null; type: string | null; requestId: string | null } {
  let root: unknown
  try { root = JSON.parse(body) } catch { return { code: null, type: null, requestId: null } }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return { code: null, type: null, requestId: null }
  }
  const record = root as Record<string, unknown>
  const nested = record.error !== null && typeof record.error === 'object' && !Array.isArray(record.error)
    ? record.error as Record<string, unknown>
    : record
  return {
    code: safeDiagnosticField(nested.code, 80),
    type: safeDiagnosticField(nested.type, 80),
    requestId: safeDiagnosticField(record.request_id ?? record.requestId, 120),
  }
}

function safeDiagnosticField(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{8,}\b/gi, '<REDACTED>')
    .replace(/Bearer\s+\S+/gi, 'Bearer <REDACTED>')
    .trim()
  return text === '' ? null : text.slice(0, limit)
}

function safeHostname(baseUrl: string): string | null {
  try { return new URL(baseUrl).hostname } catch { return null }
}

/**
 * Guards a live upstream body with the streaming deadlines and the caller's
 * cancellation, passing its bytes through unchanged. `started` is the "has
 * started emitting" signal a retry loop must consult: once it reports true,
 * no retry or key switch may happen. A deadline violation or a mid-stream
 * upstream failure ends the stream rather than replacing it with error JSON,
 * because bytes may already have reached the caller.
 */
function deadlineGuard(
  upstream: ReadableStream<Uint8Array>,
  options: {
    timer: Timer
    timeouts: StreamingTimeouts
    signal: AbortSignal
    abort: () => void
  },
): { readonly stream: ReadableStream<Uint8Array>; readonly started: () => boolean } {
  const { timer, timeouts, signal, abort } = options
  const reader = upstream.getReader()
  let emitted = false
  let ending = false
  let armed: (() => void) | null = null

  const disarm = () => {
    if (armed !== null) armed()
    armed = null
  }

  const stop = () => {
    if (ending) return
    ending = true
    disarm()
    if (!signal.aborted) abort()
    void reader.cancel().catch(() => undefined)
  }

  return {
    started: () => emitted,
    stream: new ReadableStream<Uint8Array>({
      start() {
        armed = timer.set(stop, timeouts.streamingHeaderMs)
      },
      async pull(downstream) {
        if (ending) {
          downstream.close()
          return
        }

        let chunk
        try {
          chunk = await reader.read()
        } catch {
          stop()
          downstream.close()
          return
        }
        if (ending) {
          downstream.close()
          return
        }
        if (chunk.done) {
          stop()
          downstream.close()
          return
        }

        disarm()
        emitted = true
        downstream.enqueue(chunk.value)
        armed = timer.set(stop, timeouts.streamingIdleMs)
      },
      cancel() {
        stop()
      },
    }),
  }
}

function isAbort(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  return (cause as { name?: unknown }).name === 'AbortError'
}

/**
 * Resolves the streaming deadlines for one inference call. Priority is the
 * route-level override (tests use it to compress time), then the connection's
 * per-connection overrides, then the global transport defaults. The fallbacks
 * exist so a target without those fields still has safe upper bounds.
 */
function streamingTimeoutsFor(
  routeOverride: StreamingTimeouts | undefined,
  target: InferenceTarget,
  transport: TransportDefaults,
): StreamingTimeouts {
  return {
    streamingHeaderMs:
      routeOverride?.streamingHeaderMs ?? target.firstByteTimeoutMs ?? transport.firstByteTimeoutMs,
    streamingIdleMs:
      routeOverride?.streamingIdleMs ?? target.streamingIdleTimeoutMs ?? transport.streamingIdleTimeoutMs,
  }
}

const CORS_ALLOW_METHODS = 'POST, OPTIONS'
const CORS_ALLOW_HEADERS = 'authorization, content-type, idempotency-key, x-api-key, api-key'
const CORS_MAX_AGE = '600'

/**
 * Resolves the CORS allow-list for a request. A missing `Origin` header means
 * a server-to-server call, which never goes through CORS machinery. An origin
 * that matches the request's host is treated as same-origin and gets no CORS
 * headers; any other origin must match the global allow-list, the per-key
 * allow-list, or the request is denied.
 *
 * The function returns the headers a successful response should carry. A
 * null return means "no CORS machinery", not "denied"; the caller decides.
 */
async function buildCorsHeaders(options: {
  providerId: string
  gatewayKeys: GatewayKeyRegistry
  database: Database | null
  transport: TransportDefaults
  request: Request
}): Promise<Record<string, string>> {
  const origin = options.request.headers.get('origin')
  if (origin === null) return {}

  const sameOrigin = isSameOrigin(options.request, origin)
  if (sameOrigin) return {}

  const allow = await resolveAllowList(options)
  if (allow !== origin) return {}

  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': CORS_ALLOW_METHODS,
    'access-control-allow-headers': CORS_ALLOW_HEADERS,
    'access-control-max-age': CORS_MAX_AGE,
    vary: 'Origin',
  }
}

/**
 * If the request is a cross-origin browser call from a denied Origin, returns
 * a 403 response; otherwise returns null and the caller proceeds. The check
 * runs before bearer authentication so an Origin probe cannot learn whether
 * a Gateway Key exists.
 */
async function maybeCorsDeny(options: {
  request: Request
  providerId: string
  gatewayKeys: GatewayKeyRegistry
  database: Database | null
  transport: TransportDefaults
  correlationId: string
  headers: Record<string, string>
}): Promise<Response | null> {
  const origin = options.request.headers.get('origin')
  if (origin === null) return null
  if (isSameOrigin(options.request, origin)) return null

  const allow = await resolveAllowList({
    providerId: options.providerId,
    gatewayKeys: options.gatewayKeys,
    database: options.database,
    transport: options.transport,
    request: options.request,
  })
  if (allow === origin) return null

  return new Response(
    JSON.stringify({
      error: {
        code: 'cors_origin_denied',
        message: 'This Origin is not allowed to call Iroha.',
      },
    }),
    {
      status: 403,
      headers: {
        ...options.headers,
        'content-type': 'application/json',
        'x-request-id': options.correlationId,
      },
    },
  )
}

async function resolveAllowList(options: {
  providerId: string
  gatewayKeys: GatewayKeyRegistry
  database: Database | null
  transport: TransportDefaults
  request: Request
}): Promise<string | null> {
  const origin = options.request.headers.get('origin')
  if (origin === null) return null

  const token = bearerToken(options.request.headers)
  if (token !== null && options.database !== null) {
    const key = await locateGatewayKey(options.database, token)
    if (key !== null && key.corsOrigins.includes(origin)) return origin
  }

  if (options.transport.corsAllowedOrigins.includes(origin)) return origin
  return null
}

async function locateGatewayKey(database: Database, token: string): Promise<{
  readonly corsOrigins: readonly string[]
} | null> {
  const separator = token.indexOf('.')
  if (separator <= 0) return null
  const id = token.slice(0, separator)
  const record = await database.gatewayKeys.get(id)
  if (record === null || record.revokedAt !== null) return null
  return { corsOrigins: record.corsOrigins }
}

function isSameOrigin(request: Request, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  // The `Host` header is caller-controlled and must not be trusted to decide
  // the same-origin question: a browser never sets Host. The real authority
  // is the URL the request reached Iroha on, which the runtime fills in.
  const requestHost = new URL(request.url).host
  return parsed.host === requestHost
}

async function handleCors(options: {
  providerId: string
  gatewayKeys: GatewayKeyRegistry
  database: Database | null
  transport: TransportDefaults
  request: Request
}): Promise<Response> {
  const origin = options.request.headers.get('origin')
  const correlationId = newRequestId()
  const baseHeaders = { 'content-type': 'application/json', 'x-request-id': correlationId }

  if (origin === null || isSameOrigin(options.request, origin)) {
    return new Response(null, { status: 204, headers: baseHeaders })
  }

  const allow = await resolveAllowList({
    providerId: options.providerId,
    gatewayKeys: options.gatewayKeys,
    database: options.database,
    transport: options.transport,
    request: options.request,
  })
  if (allow === origin) {
    return new Response(null, {
      status: 204,
      headers: {
        ...baseHeaders,
        'access-control-allow-origin': origin,
        'access-control-allow-methods': CORS_ALLOW_METHODS,
        'access-control-allow-headers': CORS_ALLOW_HEADERS,
        'access-control-max-age': CORS_MAX_AGE,
        vary: 'Origin',
      },
    })
  }

  return new Response(
    JSON.stringify({
      error: { code: 'cors_origin_denied', message: 'This Origin is not allowed to call Iroha.' },
    }),
    {
      status: 403,
      headers: {
        ...baseHeaders,
        'content-type': 'application/json',
        'x-request-id': correlationId,
      },
    },
  )
}

/**
 * Picks the Inference Adapter that should handle one Provider Connection's
 * request. The dispatch order is:
 *
 *   1. the Adapter Registry the route was assembled with (when supplied),
 *      looking up the Provider Template's `inferenceAdapterId`;
 *   2. when the template names the generic adapter (or the connection has no
 *      template), the fallback the route was assembled with (the same one the
 *      single-adapter era passed in directly);
 *   3. the fallback outright when no registry is supplied, which preserves
 *      the pre-registry behaviour for older tests and external callers.
 *
 * The dispatch never throws and never returns null: the fallback is the
 * route's guarantee that every request reaches an adapter.
 */
function resolveAdapterForProvider(options: {
  registry: AdapterRegistry | null
  templateId: string | null
  fallback: InferenceAdapter
}): InferenceAdapter {
  const { registry, templateId, fallback } = options
  if (registry === null) return fallback
  if (templateId === null) return fallback
  const template = registry.providerTemplate(templateId)
  if (template === null) return fallback
  const adapter = registry.inferenceAdapter(template.inferenceAdapterId)
  if (adapter === null) return fallback
  return adapter
}

/**
 * Detects an Anthropic adapter error without depending on its class type.
 * The adapter sets `name` to `AnthropicForwardError`; matching by name keeps
 * the route from needing an extra import.
 */
function isAnthropicForwardError(cause: unknown): boolean {
  if (typeof cause !== 'object' || cause === null) return false
  return (cause as { name?: unknown }).name === 'AnthropicForwardError'
}

/**
 * The structural shape an Anthropic adapter error exposes. The route
 * pattern-matches on `name` and reads these three fields to build the Iroha
 * refusal envelope.
 */
interface AnthropicForwardErrorLike {
  readonly status: number
  readonly code: string
  readonly message: string
}

function anthropicForwardRefusal(cause: AnthropicForwardErrorLike): Refusal {
  return { status: cause.status, code: cause.code, message: cause.message }
}
