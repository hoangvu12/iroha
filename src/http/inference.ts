import { randomBytes } from 'node:crypto'
import { Elysia } from 'elysia'
import type { InferenceAdapter, InferenceForwardRequest } from '../inference/index.ts'
import type { GatewayKeyRegistry } from '../keys/index.ts'
import type { ModelCatalogService } from '../models/index.ts'
import type { InferenceTarget, ProviderConnectionRegistry } from '../providers/index.ts'
import { systemTimer, type Timer } from '../runtime/timer.ts'

/** The streaming deadlines, deliberately separate knobs from any buffered total timeout. */
export interface StreamingTimeouts {
  /** Wait this long for the first upstream byte before aborting the stream. */
  readonly streamingHeaderMs: number
  /** Maximum silence between upstream bytes before aborting the stream. */
  readonly streamingIdleMs: number
}

export interface InferenceRoutesOptions {
  readonly gatewayKeys: GatewayKeyRegistry
  readonly providers: ProviderConnectionRegistry
  readonly inference: InferenceAdapter
  readonly modelCatalog: ModelCatalogService
  /** Streaming deadlines; tests inject a fake timer to drive them. */
  readonly timer?: Timer
  readonly timeouts?: StreamingTimeouts
  readonly retrySleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const DEFAULT_STREAMING_HEADER_MS = 20_000
const DEFAULT_STREAMING_IDLE_MS = 30_000
const MAX_INFERENCE_ATTEMPTS = 3
const MAX_RETRY_BUDGET_MS = 30_000

/**
 * The provider-scoped OpenAI surface an application reaches with its Gateway
 * Key. Every response carries the request's correlation ID; failures are
 * OpenAI-shaped with stable Iroha codes and sanitized detail, and the caller's
 * authorization never travels beyond this boundary.
 */
export function createInferenceRoutes(options: InferenceRoutesOptions) {
  const { gatewayKeys, providers, inference, modelCatalog } = options
  const timer = options.timer ?? systemTimer
  const retrySleep = options.retrySleep ?? sleepWithTimer(timer)
  const timeouts: StreamingTimeouts = {
    streamingHeaderMs: options.timeouts?.streamingHeaderMs ?? DEFAULT_STREAMING_HEADER_MS,
    streamingIdleMs: options.timeouts?.streamingIdleMs ?? DEFAULT_STREAMING_IDLE_MS,
  }

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
      async ({ request, params }) =>
        await forwardGeneration({
          request,
          connectionId: params.connectionId,
          upstreamPath: '/chat/completions',
          gatewayKeys,
          providers,
          inference,
          modelCatalog,
          timer,
          timeouts,
          retrySleep,
        }),
    )
    .post(
      '/:connectionId/v1/responses',
      async ({ request, params }) =>
        await forwardGeneration({
          request,
          connectionId: params.connectionId,
          upstreamPath: '/responses',
          gatewayKeys,
          providers,
          inference,
          modelCatalog,
          timer,
          timeouts,
          retrySleep,
        }),
    )
}

export type InferenceRoutes = ReturnType<typeof createInferenceRoutes>

async function forwardGeneration(options: {
  request: Request
  connectionId: string
  upstreamPath: '/chat/completions' | '/responses'
  gatewayKeys: GatewayKeyRegistry
  providers: ProviderConnectionRegistry
  inference: InferenceAdapter
  modelCatalog: ModelCatalogService
  timer: Timer
  timeouts: StreamingTimeouts
  retrySleep: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<Response> {
  const { request, connectionId, upstreamPath, gatewayKeys, providers, inference, modelCatalog, timer, timeouts, retrySleep } = options
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
  const authorization = await gatewayKeys.authorizeInference(connectionId, envelope.model, token)
  if (!authorization.ok) {
    const refusal = authorizationRefusal(authorization)
    return error(refusal.status, baseHeaders, refusal, correlationId)
  }

  if (await modelCatalog.isExcluded(connectionId, envelope.model)) {
    return error(
      403,
      baseHeaders,
      { code: 'model_excluded', message: 'This model is excluded on this Provider Connection.' },
      correlationId,
    )
  }

  const attemptedKeys: string[] = []
  const startedAt = timer.now()
  const retryPolicy = await providers.get(connectionId)
  const maxAttempts = retryPolicy?.retryMaxAttempts ?? MAX_INFERENCE_ATTEMPTS
  const retryAmbiguousNetwork = retryPolicy?.retryAmbiguousNetwork ?? false
  let alternateUsed = false
  let sameKeyRetries = 0
  let lastUpstream: Awaited<ReturnType<InferenceAdapter['forward']>> | null = null
  let retainedTarget: InferenceTarget | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (request.signal.aborted) throw abortError()
    let target: InferenceTarget
    if (retainedTarget !== null) {
      target = retainedTarget
      retainedTarget = null
    } else {
      const resolution = await providers.resolveInference(
        connectionId,
        envelope.model,
        attemptedKeys,
        alternateUsed,
      )
      if (!resolution.ok) {
        const refusal = resolutionRefusal(resolution.failure)
        const retryAfter = await providers.earliestRetryAfterSeconds(connectionId)
        return error(
          refusal.status,
          { ...baseHeaders, ...(retryAfter === null ? {} : { 'retry-after': String(retryAfter) }) },
          refusal,
          correlationId,
        )
      }
      target = resolution.value
    }

    const forwardRequest: InferenceForwardRequest = {
      baseUrl: target.baseUrl,
      allowInsecureHttp: target.allowInsecureHttp,
      path: upstreamPath,
      method: 'POST',
      body: envelope.raw,
      headers: headersOf(request),
      upstreamKey: target.upstreamKey,
      signal: request.signal,
    }

    if (envelope.stream) {
      const streamed = await streamChatCompletion(
        inference,
        timer,
        timeouts,
        forwardRequest,
        baseHeaders,
        correlationId,
      )
      if (streamed.status >= 200 && streamed.status < 300) {
        await providers.recordInferenceSuccess(target.keyId)
        return streamed
      }
      await providers.recordInferenceFailure({
        keyId: target.keyId,
        model: envelope.model,
        status: streamed.status,
        retryAfterSeconds: numericRetryAfter(streamed.headers),
        reason: `upstream HTTP ${streamed.status}`,
      })
      const status = streamed.status
      if ((status === 401 || status === 403) && attempt < maxAttempts) {
        attemptedKeys.push(target.keyId)
        continue
      }
      if (status === 429 && !alternateUsed && attempt < maxAttempts) {
        alternateUsed = true
        attemptedKeys.push(target.keyId)
        continue
      }
      if (status >= 500 && sameKeyRetries < 1 && attempt < maxAttempts) {
        sameKeyRetries++
        retainedTarget = target
        await retrySleep(100, request.signal)
        continue
      }
      return streamed
    }

    try {
      lastUpstream = await inference.forward(forwardRequest)
    } catch (cause) {
      if (isAbort(cause)) throw cause
      if (
        retryAmbiguousNetwork &&
        attempt < maxAttempts &&
        timer.now() - startedAt < MAX_RETRY_BUDGET_MS
      ) {
        retainedTarget = target
        await retrySleep(100, request.signal)
        continue
      }
      return error(
        502,
        baseHeaders,
        { code: 'upstream_unreachable', message: 'The Provider could not be reached.' },
        correlationId,
      )
    }

    if (lastUpstream.status >= 200 && lastUpstream.status < 300) {
      await providers.recordInferenceSuccess(target.keyId)
      return new Response(lastUpstream.kind === 'stream' ? lastUpstream.stream : lastUpstream.body, {
        status: lastUpstream.status,
        headers: {
          'content-type': lastUpstream.headers['content-type'] ?? 'application/json',
          'x-request-id': correlationId,
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

    const insideBudget = timer.now() - startedAt < MAX_RETRY_BUDGET_MS
    if (!insideBudget || request.signal.aborted) break

    if (status === 401 || status === 403) {
      attemptedKeys.push(target.keyId)
      continue
    }
    if (status === 429 && !alternateUsed) {
      alternateUsed = true
      attemptedKeys.push(target.keyId)
      continue
    }
    if (status >= 500 && sameKeyRetries < 1) {
      sameKeyRetries++
      retainedTarget = target
      await retrySleep(100, request.signal)
      continue
    }
    break
  }

  if (lastUpstream === null) {
    return error(
      503,
      baseHeaders,
      { code: 'upstream_credentials_unavailable', message: 'No eligible Upstream Key is available for this connection.' },
      correlationId,
    )
  }
  if (lastUpstream.status === 429) {
    const retryAfter = await providers.earliestRetryAfterSeconds(connectionId)
    return error(
      503,
      { ...baseHeaders, ...(retryAfter === null ? {} : { 'retry-after': String(retryAfter) }) },
      {
        code: 'upstream_credentials_unavailable',
        message: 'No eligible Upstream Key is available for this connection.',
      },
      correlationId,
    )
  }
  const refusal = upstreamRefusal(lastUpstream.status, lastUpstream.headers)
  return error(
    refusal.status,
    { ...baseHeaders, ...(refusal.retryAfter ? { 'retry-after': refusal.retryAfter } : {}) },
    refusal,
    correlationId,
  )
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
