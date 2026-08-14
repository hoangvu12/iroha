import { randomBytes } from 'node:crypto'
import { Elysia, t } from 'elysia'
import type { RequestHistoryService } from '../history/index.ts'
import type { AttemptOutcome } from '../persistence/index.ts'
import {
  callerSuppliedIdempotency,
  generateIdempotencyValue,
  type InferenceAdapter,
  type InferenceAdapterCapabilities,
  type InferenceForwardRequest,
} from '../inference/index.ts'
import type { GatewayKeyRegistry } from '../keys/index.ts'
import type { ModelCatalogService } from '../models/index.ts'
import type { Database } from '../persistence/index.ts'
import type { InferenceTarget, ProviderRegistry } from '../providers/index.ts'
import type { MetricsCollector } from '../metrics/metrics.ts'
import type { InferenceActivity, ShutdownController } from '../runtime/shutdown.ts'
import { systemTimer, type Timer } from '../runtime/timer.ts'
import type { UsageService } from '../usage/index.ts'

/** The terminal shape of one attempt's outcome, what the recorder writes. */
interface AttemptTerminal {
  readonly status: number | null
  readonly outcome: AttemptOutcome
  readonly errorCode: string | null
  readonly retryAfterSeconds: number | null
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
  const adapterCapabilities: InferenceAdapterCapabilities = inference.capabilities
  const requestHistory = options.requestHistory

  return new Elysia({ name: 'iroha/inference', prefix: '/providers' })
    .options(
      '/:providerId/*',
      async ({ params, request }) => {
        return handleCors({
          providerId: params.providerId,
          gatewayKeys,
          database: options.database ?? null,
          transport,
          adapterCapabilities,
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
      '/:providerId/v1/models',
      async ({ request, params }) => {
        const activity = shutdown === undefined ? undefined : shutdown.beginInference(request.signal)
        if (activity === null) return shuttingDownError()
        try {
        const correlationId = newRequestId()
        const baseHeaders = { 'content-type': 'application/json', 'x-request-id': correlationId }

        const cors = await buildCorsHeaders({
          providerId: params.providerId,
          gatewayKeys,
          database: options.database ?? null,
          transport,
          request,
        })
        const responseHeaders = { ...baseHeaders, ...cors }

        const token = bearerToken(request.headers)
        const authorization = await gatewayKeys.authorizeConnection(params.providerId, token)
        if (!authorization.ok) {
          const refusal = authorizationRefusal(authorization)
          return error(refusal.status, responseHeaders, refusal, correlationId)
        }

        const result = await modelCatalog.listForScope(params.providerId, authorization.models)
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
      '/:providerId/v1/chat/completions',
      async ({ request, params }) => {
        const activity = shutdown === undefined ? undefined : shutdown.beginInference(request.signal)
        if (activity === null) return shuttingDownError()
        return await forwardGeneration({
          request,
          providerId: params.providerId,
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
          adapterCapabilities,
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
      '/:providerId/v1/responses',
      async ({ request, params }) => {
        const activity = shutdown === undefined ? undefined : shutdown.beginInference(request.signal)
        if (activity === null) return shuttingDownError()
        return await forwardGeneration({
          request,
          providerId: params.providerId,
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
          adapterCapabilities,
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
}

export type InferenceRoutes = ReturnType<typeof createInferenceRoutes>

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
  adapterCapabilities: InferenceAdapterCapabilities
  requestHistory?: RequestHistoryService | undefined
  requestActivity?: InferenceActivity
  metrics?: MetricsCollector
  usageService?: UsageService | undefined
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
    adapterCapabilities,
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
  const authorization = await gatewayKeys.authorizeInference(providerId, envelope.model, token)
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
  let alternateUsed = false
  let sameKeyRetries = 0
  let lastUpstream: Awaited<ReturnType<InferenceAdapter['forward']>> | null = null
  let retainedTarget: InferenceTarget | null = null
  let lastAttemptRecorder: { readonly finalize: (outcome: AttemptTerminal) => Promise<void> } | null = null
  let lastAttemptKeyId: string | null = null

  const callerHeaders = headersOf(request)
  const inboundIdempotency = callerSuppliedIdempotency(callerHeaders, adapterCapabilities.idempotencyHeader)
  const generatedIdempotency = inboundIdempotency === null && adapterCapabilities.idempotencyGenerationSafe
    ? generateIdempotencyValue()
    : null

  const history = requestHistory?.beginRequest({
    id: correlationId,
    providerId,
    model: envelope.model,
    gatewayKeyId: authorization.keyId,
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
        const refusal = resolutionRefusal(resolution.failure)
        const retryAfter = await providers.earliestRetryAfterSeconds(providerId)
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
      adapterCapabilities,
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
      idempotencyGenerationSafe: adapterCapabilities.idempotencyGenerationSafe,
      connectionTimeoutMs: target.connectionTimeoutMs,
      firstByteTimeoutMs: target.firstByteTimeoutMs,
      nonStreamingTotalTimeoutMs: target.nonStreamingTotalTimeoutMs,
      streamingIdleTimeoutMs: target.streamingIdleTimeoutMs,
      totalRetryTimeoutMs: target.totalRetryTimeoutMs,
    }

    if (envelope.stream) {
      const streamed = await streamChatCompletion(
        inference,
        timer,
        streamingTimeoutsFor(timeouts, target, transport),
        forwardRequest,
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
      await providers.recordInferenceFailure({
        keyId: target.keyId,
        model: envelope.model,
        status: streamed.status,
        retryAfterSeconds: numericRetryAfter(streamed.headers),
        reason: `upstream HTTP ${streamed.status}`,
      })
      const headerMap = Object.fromEntries(streamed.headers.entries())
      const refusal = upstreamRefusal(streamed.status, headerMap)
      await lastAttemptRecorder?.finalize({
        status: streamed.status,
        outcome: 'failure',
        errorCode: refusal.code,
        retryAfterSeconds: numericRetryAfter(streamed.headers),
        at: new Date(),
      })
      const status = streamed.status
      if ((status === 401 || status === 403) && attempt < maxAttempts) {
        attemptedKeys.push(target.keyId)
        metrics?.recordRetry()
        continue
      }
      if (status === 429 && !alternateUsed && attempt < maxAttempts) {
        alternateUsed = true
        attemptedKeys.push(target.keyId)
        metrics?.recordRetry()
        continue
      }
      if (status >= 500 && sameKeyRetries < 1 && attempt < maxAttempts) {
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
      lastUpstream = await inference.forward(forwardRequest)
    } catch (cause) {
      if (isAbort(cause)) throw cause
      await lastAttemptRecorder?.finalize({
        status: null,
        outcome: 'failure',
        errorCode: 'upstream_unreachable',
        retryAfterSeconds: null,
        at: new Date(),
      })
      if (
        retryAmbiguousNetwork &&
        attempt < maxAttempts &&
        timer.now() - startedAt < totalRetryBudgetMs
      ) {
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
      if (usageService !== undefined) {
        void usageService.refreshAfterInference(providerId).catch(() => undefined)
      }
      return new Response(lastUpstream.kind === 'stream' ? lastUpstream.stream : lastUpstream.body, {
        status: lastUpstream.status,
        headers: {
          ...responseHeaders,
          'content-type': lastUpstream.headers['content-type'] ?? 'application/json',
        },
      })
    }

    const status = lastUpstream.status
    await providers.recordInferenceFailure({
      keyId: target.keyId,
      model: envelope.model,
      status,
      retryAfterSeconds: numericRetryAfter(lastUpstream.headers),
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

    if (status === 401 || status === 403) {
      attemptedKeys.push(target.keyId)
      metrics?.recordRetry()
      continue
    }
    if (status === 429 && !alternateUsed) {
      alternateUsed = true
      attemptedKeys.push(target.keyId)
      metrics?.recordRetry()
      continue
    }
    if (status >= 500 && sameKeyRetries < 1) {
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

const FORWARD_BLOCKED_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'referer',
  'set-cookie',
  'te',
  'traceparent',
  'tracestate',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-correlation-id',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'x-request-id',
])

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
    const refusal = upstreamRefusal(answer.status, answer.headers)
    return error(
      refusal.status,
      { ...baseHeaders, ...(refusal.retryAfter ? { 'retry-after': refusal.retryAfter } : {}) },
      refusal,
      correlationId,
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
  adapterCapabilities: InferenceAdapterCapabilities
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
