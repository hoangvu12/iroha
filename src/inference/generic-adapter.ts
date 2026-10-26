import { randomUUID } from 'node:crypto'
import { adapterBlockedHeaders } from './blocked-headers.ts'
import type {
  InferenceAdapter,
  InferenceAdapterCapabilities,
  InferenceFailureClassification,
  InferenceForwardRequest,
  InferenceForwardResult,
} from './adapter.ts'
import {
  appendStreamingReasoning,
  flushStreamingReasoning,
  type StreamingReasoningState,
} from './streaming-reasoning.ts'
import type { ProviderDiagnostics } from '../providers/provider-evidence.ts'
import { redirectPolicy, upstreamFetch } from './upstream-transport.ts'
import { safeUpstreamErrorFields } from './upstream-error-fields.ts'

export { appendStreamingReasoning as splitStreamingReasoning } from './streaming-reasoning.ts'

/** Extracts text and reasoning from a content-blocks array (ZAI GLM format). */
function extractContentBlocks(blocks: unknown[]): { text: string; reasoning: string } {
  const textParts: string[] = []
  const reasoningParts: string[] = []

  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    const b = block as Record<string, unknown>

    if (b.type === 'thinking') {
      const thinkingBlocks = b.thinking
      if (Array.isArray(thinkingBlocks)) {
        for (const tb of thinkingBlocks) {
          if (tb !== null && typeof tb === 'object') {
            const t = (tb as Record<string, unknown>).text
            if (typeof t === 'string') reasoningParts.push(t)
          }
        }
      }
    } else if (b.type === 'text') {
      if (typeof b.text === 'string') textParts.push(b.text)
    }
  }

  return { text: textParts.join(''), reasoning: reasoningParts.join('') }
}

export interface GenericInferenceAdapterOptions {
  /** Injectable transport; production uses the runtime's fetch. */
  readonly fetch?: typeof fetch
}

/** The generic adapter declares Idempotency-Key with safe generation. */
const GENERIC_CAPABILITIES: InferenceAdapterCapabilities = {
  idempotencyHeader: 'Idempotency-Key',
  idempotencyGenerationSafe: true,
}

/**
 * Hop-by-hop, proxy-control, credential-bearing, and Iroha-owned headers
 * are never forwarded upstream. Everything else passes through so provider
 * extensions keep working. The list lives in `blocked-headers.ts` so every
 * adapter and the inference HTTP route share one source of truth.
 */
const BLOCKED_HEADERS = adapterBlockedHeaders

/**
 * The generic OpenAI-compatible Inference Adapter: endpoint construction from
 * the connection's base URL, safe bearer authentication, conservative redirect
 * behaviour, and unchanged request and response bodies. No executable
 * authentication code is ever accepted through configuration.
 *
 * `redirect: 'manual'` is the default. When the Owner explicitly enables
 * same-origin redirects on a connection, the wrapper follows them, but only
 * as long as the resolved URL stays on the originally configured origin; any
 * cross-origin hop is refused by returning the redirect response itself so
 * the routing layer can map it to `upstream_redirect`. The upstream key, the
 * static headers, and the configured authentication header therefore never
 * reach a different origin: the request is never issued.
 */
export function createGenericInferenceAdapter(
  options: GenericInferenceAdapterOptions = {},
): InferenceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch

  return {
    capabilities: GENERIC_CAPABILITIES,
    classifyFailure: classifyGenericFailure,

    async forward(request: InferenceForwardRequest): Promise<InferenceForwardResult> {
      const forwarded: Record<string, string> = {}
      for (const [name, value] of Object.entries(request.headers)) {
        if (!BLOCKED_HEADERS.has(name.toLowerCase())) forwarded[name] = value
      }
      // The configured authentication header always wins over any caller-supplied
      // value: the prefix and key together form one atomic value the Owner
      // chose, and an existing header in the same slot is overwritten rather
      // than appended so a caller cannot smuggle a second credential.
      forwarded[request.authHeader.toLowerCase()] = `${request.authPrefix}${request.upstreamKey}`
      forwarded['content-type'] ??= 'application/json'
      if (!('accept' in forwarded)) forwarded['accept'] = 'application/json'
      mergeStaticHeaders(forwarded, request.staticHeaders, request.authHeader)

      const upstreamHeaders = { ...forwarded }
      const policy = redirectPolicy(request)
      const upstream = await upstreamFetch(fetchImpl, {
        url: upstreamUrl(request.baseUrl, request.path),
        method: request.method,
        headers: upstreamHeaders,
        body: request.body ?? undefined,
        follow: policy.follow,
        origin: policy.origin,
        signal: request.signal ?? null,
        // The header deadline is the first-byte budget: time to response
        // headers, which includes connection establishment. A custom transport
        // would be needed to bound connect separately.
        headerTimeoutMs: request.firstByteTimeoutMs,
        totalTimeoutMs: request.nonStreamingTotalTimeoutMs,
      })

      if (request.stream === true) {
        // No total deadline: the route's deadlineGuard owns streaming idleness.
        const upstreamBody = upstream.response.body ?? new ReadableStream<Uint8Array>()
        const contentType = upstream.response.headers.get('content-type') ?? ''
        return {
          kind: 'stream',
          status: upstream.response.status,
          headers: Object.fromEntries(upstream.response.headers.entries()),
          stream: contentType.toLowerCase().includes('text/event-stream')
            ? upstreamBody.pipeThrough(createOpenAiStreamingNormalizer())
            : upstreamBody,
        }
      }

      const rawBody = await upstream.readText()
      upstream.dispose()
      return {
        kind: 'buffered',
        status: upstream.response.status,
        headers: Object.fromEntries(upstream.response.headers.entries()),
        body: normalizeOpenAiResponseBody(rawBody),
      }
    },
  }
}

/**
 * Reasoning-content conventions used by OpenAI-compatible upstreams that
 * embed chain-of-thought as a leading XML block inside the visible `content`
 * rather than as a separate field. `liteLLM` recognises the same three tag
 * names (`common_utils._parse_content_for_reasoning`); mirroring them keeps
 * clients that already handle one upstream's shape working against another
 * without bespoke adapters.
 */
const REASONING_TAG_PATTERN =
  /<(?:think|thinking|budget:thinking)>([\s\S]*?)<\/(?:think|thinking|budget:thinking)>/

/**
 * Reconciles an upstream's answer body with what an OpenAI Chat Completions
 * client expects. Three normalisations are applied to every choice's
 * `message`:
 *
 *   - if the upstream already exposes a separate `reasoning_content` (or
 *     `reasoning`) field, it is left untouched and nothing is moved;
 *   - if the visible `content` carries an inline `<think>…</think>` (or the
 *     `thinking` / `budget:thinking` variants DeepSeek and Qwen emit), the
 *     reasoning is lifted into `reasoning_content` and the visible text is
 *     trimmed;
 *   - upstream-specific extras (`audio_content`, a `name` that the model
 *     filled with its own brand) are dropped, since the OpenAI spec does
 *     not define them and strict clients reject unknown keys.
 *
 * The body is returned unchanged when it is not valid JSON, when there are
 * no choices to walk, or when nothing in the body needs touching — that
 * keeps passthrough performance on the hot path free and avoids corrupting
 * the error envelopes `upstreamRefusal` already recognises.
 */
export function normalizeOpenAiResponseBody(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (parsed === null || typeof parsed !== 'object') return body
  const root = parsed as Record<string, unknown>
  const choices = root.choices
  if (!Array.isArray(choices) || choices.length === 0) return body

  let touched = false
  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') continue
    const message = (choice as Record<string, unknown>).message
    if (message === null || typeof message !== 'object') continue
    const normalised = normalizeAssistantMessage(message as Record<string, unknown>)
    if (normalised !== null) {
      ;(choice as Record<string, unknown>).message = normalised
      touched = true
    }
  }
  if (!touched) return body
  return JSON.stringify(parsed)
}

function normalizeAssistantMessage(message: Record<string, unknown>): Record<string, unknown> | null {
  let mutated = false
  const next: Record<string, unknown> = { ...message }

  const existingReasoning = pickReasoningField(next)
  let content = next.content

  if (Array.isArray(content)) {
    const { text, reasoning } = extractContentBlocks(content)
    if (reasoning.length > 0) next.reasoning_content = reasoning
    next.content = text
    content = text
    mutated = true
  }

  if (typeof existingReasoning === 'string' && content === existingReasoning && content.length > 0) {
    next.content = ''
    mutated = true
  } else if (existingReasoning === undefined && typeof content === 'string') {
    const match = REASONING_TAG_PATTERN.exec(content)
    if (match !== null) {
      const reasoning = match[1] ?? ''
      const trailing = content.slice((match.index ?? 0) + match[0].length).replace(/^\s+/, '')
      next.reasoning_content = reasoning
      next.content = trailing
      mutated = true
    }
  }

  if ('audio_content' in next) {
    delete next.audio_content
    mutated = true
  }
  const rawName = next.name
  if (typeof rawName === 'string' && rawName.length > 0 && rawName !== message.role) {
    delete next.name
    mutated = true
  }

  return mutated ? next : null
}

/**
 * Returns the value of the upstream's reasoning field when one is already
 * present, regardless of which name the upstream chose. OpenRouter publishes
 * `reasoning`; Kimi, GLM, and LiteLLM-normalised providers publish
 * `reasoning_content`; anything else is treated as absent so the inline
 * extractor runs.
 */
function pickReasoningField(message: Record<string, unknown>): unknown {
  if ('reasoning_content' in message) return message.reasoning_content
  if ('reasoning' in message) return message.reasoning
  return undefined
}

/** Joins a base URL and a provider path once, tolerating a trailing slash. */
export function upstreamUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

/**
 * Merges the connection's static headers without overwriting the
 * authentication header that was just installed.
 */
function mergeStaticHeaders(
  forwarded: Record<string, string>,
  staticHeaders: Readonly<Record<string, string>>,
  authHeader: string,
): void {
  for (const [name, value] of Object.entries(staticHeaders)) {
    if (name.toLowerCase() === authHeader.toLowerCase()) continue
    forwarded[name.toLowerCase()] = value
  }
}

/**
 * Looks at the caller's headers and reports whether the request already carries
 * an idempotency value. The header name lookup is case-insensitive so a caller
 * writing `Idempotency-Key` or `idempotency-key` is the same Iroha read.
 */
export function callerSuppliedIdempotency(
  headers: Readonly<Record<string, string>>,
  headerName: string,
): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === headerName.toLowerCase()) return value
  }
  return null
}

/** A fresh RFC-4122 v4 UUID, exported for callers that need the same shape. */
export function generateIdempotencyValue(): string {
  return randomUUID()
}

const STREAM_ENCODER = new TextEncoder()
const STREAM_DECODER = new TextDecoder()

/**
 * Per-choice streaming state for the SSE normaliser: whether the next token
 * is inside a `<think>` block, plus the clean-reasoning prefix that should be
 * reattached to the *first* `delta.content` emitted after the close tag so
 * the client sees no whitespace discontinuity.
 */
type StreamingChoiceState = StreamingReasoningState

/**
 * Stateful byte-level transform that wraps an upstream SSE body so that
 * reasoning content carried inline as `<think|thinking|budget:thinking>…</…>`
 * is moved into `delta.reasoning_content` (or the buffered `reasoning_content`
 * field at the end of stream) and the upstream-only `name` / `audio_content`
 * fields are stripped. Mirrors {@link normalizeOpenAiResponseBody} for the
 * streaming path so a caller cannot tell whether it received a buffered or
 * streamed answer from the shape of the payload.
 *
 * The transformer buffers across chunk boundaries because a single tag can
 * straddle two upstream writes — `<think>\nThe user` arrives in one write and
 * ` said "hi"\n</think>\n\nHello!` arrives in the next.
 */
export function createOpenAiStreamingNormalizer(): TransformStream<Uint8Array, Uint8Array> {
  const choiceStates = new Map<number, StreamingChoiceState>()

  let buffer = ''
  let doneEmitted = false

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      const decoded = STREAM_DECODER.decode(chunk, { stream: true })
      buffer += decoded

      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const out = normalizeSseEvent(event, choiceStates)
        if (out !== null) {
          if (out === '[DONE]') {
            if (doneEmitted) continue
            enqueuePendingReasoning(controller, choiceStates)
            doneEmitted = true
            controller.enqueue(STREAM_ENCODER.encode(`data: [DONE]\n\n`))
          } else {
            controller.enqueue(STREAM_ENCODER.encode(`data: ${out}\n\n`))
          }
        } else {
          controller.enqueue(STREAM_ENCODER.encode(`${event}\n\n`))
        }
      }
    },
    flush(controller): void {
      const tail = STREAM_DECODER.decode()
      if (tail.length > 0) {
        buffer += tail
      }
      if (buffer.length > 0) {
        const event = buffer
        buffer = ''
        // Normalize a parseable final event but never manufacture the missing
        // blank-line terminator; that would disguise truncation as completion.
        const out = normalizeSseEvent(event, choiceStates)
        if (out === null) controller.enqueue(STREAM_ENCODER.encode(event))
        else if (out === '[DONE]') controller.enqueue(STREAM_ENCODER.encode('data: [DONE]'))
        else controller.enqueue(STREAM_ENCODER.encode(`data: ${out}`))
      }

      // Drain any per-choice text that was held back to keep a partial tag
      // prefix across a chunk boundary. Emitted *before* [DONE] so the
      // reasoning-to-content transition lands in the right place.
      if (!doneEmitted) {
        enqueuePendingReasoning(controller, choiceStates)
      }
    },
  })
}

/**
 * Conservative semantics shared by OpenAI-compatible adapters without a documented override.
 *
 * A 403, 429 or 5xx is ambiguous on its own: Providers rate-limit, entitle and
 * break individual models as often as whole keys. Unless the body names an
 * account condition, the claim is therefore the narrowest one that is still
 * true — `key_model`, the key that answered for the model it was asked — and
 * the cooldown engine escalates to the whole key once several models fail the
 * same way. A 401, or an account condition, speaks for the key at once.
 */
export function classifyGenericFailure(result: InferenceForwardResult): InferenceFailureClassification {
  const status = classifyGenericStatus(result)
  const diagnostics = genericDiagnostics(result)
  return diagnostics === undefined ? status : { ...status, diagnostics }
}

/**
 * The bounded facts a generic Provider named about its own rejection: the
 * Provider's error code and type, and the request field a strict validator
 * refused. A body that named none of them contributes no diagnostics at all,
 * so an unrecognized failure stays as empty as before rather than growing a
 * bare status the Attempt row already carries.
 */
function genericDiagnostics(result: InferenceForwardResult): ProviderDiagnostics | undefined {
  if (result.kind !== 'buffered' || result.body === '') return undefined
  const fields = safeUpstreamErrorFields(result.body)
  if (fields.code === null && fields.type === null && fields.field === null) return undefined
  return {
    ...(fields.code === null ? {} : { providerCode: fields.code }),
    ...(fields.type === null ? {} : { providerType: fields.type }),
    ...(fields.field === null ? {} : { providerField: fields.field }),
  }
}

function classifyGenericStatus(result: InferenceForwardResult): InferenceFailureClassification {
  const retryAfterSeconds = numericHeader(result.headers['retry-after'])
  if (result.status === 401) {
    return { kind: 'authentication_invalid', capacityScope: 'key', retryAction: 'try_alternate', retryAfterSeconds }
  }
  if (result.status === 403) {
    const capacityScope = namesAccountCondition(result) ? 'key' : 'key_model'
    return { kind: 'authentication_rejected', capacityScope, retryAction: 'try_alternate', retryAfterSeconds }
  }
  if (result.status === 429) {
    const capacityScope = namesAccountCondition(result) ? 'key' : 'key_model'
    return { kind: 'capacity_limited', capacityScope, retryAction: 'try_alternate', retryAfterSeconds }
  }
  if (result.status === 402) {
    return { kind: 'payment_required', capacityScope: 'unknown', retryAction: 'try_alternate', retryAfterSeconds }
  }
  if (result.status >= 500) {
    // A 5xx is an observation about one Attempt: the same key may simply
    // succeed next time (`retryAction` is `retry_same`). Backends fail per
    // model, so the claim is the key-and-model pair; a Provider down for
    // every model reaches the whole key through escalation. Claiming
    // `connection_model` here would let the cooldown engine disqualify every
    // healthy sibling for the model.
    return { kind: 'provider_failure', capacityScope: 'key_model', retryAction: 'retry_same', retryAfterSeconds }
  }
  // A 404 from an upstream that carries the model in its catalog means the
  // specific key lacks entitlement, not that the model doesn't exist — try an
  // alternate key before giving up.
  if (result.status === 404) {
    return { kind: 'request_rejected', capacityScope: 'connection_model', retryAction: 'try_alternate', retryAfterSeconds }
  }
  return { kind: 'request_rejected', capacityScope: 'unknown', retryAction: 'stop', retryAfterSeconds }
}

/**
 * Words with which a Provider describes the key itself or the account behind
 * it rather than one model: a refused credential, an unverified profile, a
 * suspension, spent credit or quota — e.g. ModelScope's 403 "please complete
 * your profile via email verification".
 * A refusal that also names a model ("your account cannot access this model")
 * is about that model and stays narrow; escalation still catches a key that
 * fails that way for every model.
 */
const ACCOUNT_CONDITION = /api[ _-]?key|credential|verif|profile|account|suspend|banned|deactivat|billing|balance|credit|quota|payment|arrear|subscription/i
const NAMES_A_MODEL = /\bmodels?\b/i
const ERROR_TEXT_MAXIMUM = 2_048

function namesAccountCondition(result: InferenceForwardResult): boolean {
  if (result.kind !== 'buffered') return false
  const text = errorText(result.body)
  return ACCOUNT_CONDITION.test(text) && !NAMES_A_MODEL.test(text)
}

/**
 * The human- and machine-readable parts of an error body: the OpenAI-shaped
 * `error` object or a flat envelope's `message`/`code`/`type`/`detail`. Only
 * these are read, so a body that merely echoes the request's `model` field is
 * not mistaken for a model-specific refusal. A non-JSON body is read as text.
 */
function errorText(body: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body.slice(0, ERROR_TEXT_MAXIMUM)
  }
  if (typeof parsed !== 'object' || parsed === null) return ''
  const root = parsed as Record<string, unknown>
  const nested = typeof root.error === 'object' && root.error !== null
    ? (root.error as Record<string, unknown>)
    : {}
  return [root.error, root.message, root.code, root.type, root.detail, nested.message, nested.code, nested.type]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .slice(0, ERROR_TEXT_MAXIMUM)
}

function numericHeader(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value.trim())) return null
  return Number(value.trim())
}

function enqueuePendingReasoning(
  controller: TransformStreamDefaultController<Uint8Array>,
  choiceStates: ReadonlyMap<number, StreamingChoiceState>,
): void {
  for (const [index, state] of choiceStates) {
    const flushed = flushStreamingReasoning(state)
    if (flushed === null) continue
    const encoded = JSON.stringify({
      choices: [
        {
          index,
          delta: {
            content: flushed.content,
            reasoning_content: flushed.reasoning,
          },
        },
      ],
    })
    controller.enqueue(STREAM_ENCODER.encode(`data: ${encoded}\n\n`))
  }
}

/**
 * Normalises one SSE event block. Returns:
 *   - `null` to forward the event verbatim (non-data lines, malformed JSON,
 *     error envelopes);
 *   - `'[DONE]'` for the OpenAI stream sentinel so the caller can write the
 *     canonical `data: [DONE]\n\n`;
 *   - a JSON string of the rewritten payload otherwise.
 */
function normalizeSseEvent(event: string, choiceStates: Map<number, StreamingChoiceState>): string | null {
  const lines = event.split('\n')
  let data = ''
  let hasDataLine = false
  let hasNonPassthroughLine = false
  for (const line of lines) {
    if (line.startsWith('data:')) {
      hasDataLine = true
      data += line.slice(5).trimStart()
    } else if (line.startsWith(':') || line.length === 0) {
      // SSE comment or separator — passthrough.
      hasNonPassthroughLine = true
    } else {
      // event:/id:/retry: — passthrough, but mark so we don't try to rewrite.
      hasNonPassthroughLine = true
    }
  }

  if (!hasDataLine) return null

  const trimmed = data.trim()
  if (trimmed === '[DONE]') return '[DONE]'

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null

  const root = parsed as Record<string, unknown>
  if ('error' in root) return null

  const choices = root.choices
  if (!Array.isArray(choices)) return hasNonPassthroughLine ? trimmed : null

  let touched = false
  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object') continue
    const index = (choice as Record<string, unknown>).index
    const idx = typeof index === 'number' ? index : 0
    const state = choiceStates.get(idx) ?? { inReasoning: false, pendingBuffer: '' }
    const normalised = normalizeStreamingDelta(choice as Record<string, unknown>, state)
    if (normalised !== null) {
      ;(choice as Record<string, unknown>).delta = normalised
      touched = true
    }
    choiceStates.set(idx, state)
  }
  return touched ? JSON.stringify(parsed) : null
}

function normalizeStreamingDelta(
  choice: Record<string, unknown>,
  state: StreamingChoiceState,
): Record<string, unknown> | null {
  const delta = choice.delta
  if (delta === null || typeof delta !== 'object') return null
  const d = { ...(delta as Record<string, unknown>) }

  let mutated = false

  if ('audio_content' in d) {
    delete d.audio_content
    mutated = true
  }
  if ('name' in d && d.name !== '') {
    delete d.name
    mutated = true
  }

  let content = d.content

  if (Array.isArray(content)) {
    const { text, reasoning } = extractContentBlocks(content)
    if (reasoning.length > 0) d.reasoning_content = reasoning
    d.content = text
    content = text
    mutated = true
  }

  const hasReasoningDelta = typeof d.reasoning === 'string' && d.reasoning.length > 0
  const duplicatesReasoningContent = content === d.reasoning_content
  if (typeof content === 'string' && content.length > 0) {
    if (hasReasoningDelta) {
      const reasoning = d.reasoning as string
      let remainder = content
      if (content.startsWith(reasoning)) remainder = content.slice(reasoning.length)
      else if (reasoning.startsWith(content)) remainder = ''

      if (state.inReasoning || remainder.includes('<')) {
        const tagStart = remainder.indexOf('<')
        if (tagStart > 0 && remainder.slice(0, tagStart).trim().length === 0) {
          remainder = remainder.slice(tagStart)
        }
        const split = appendStreamingReasoning(state, remainder)
        d.content = split.content
      } else {
        d.content = ''
      }
      mutated = true
    } else if (duplicatesReasoningContent) {
      d.content = ''
      mutated = true
    } else if (!('reasoning_content' in d) && !('reasoning' in d)) {
      const split = appendStreamingReasoning(state, content)
      if (split.mutated) {
        // Always set both fields (possibly to empty string) when the chunk
        // participates in reasoning, so a client diffing consecutive deltas
        // sees a deterministic shape regardless of whether reasoning is open
        // or closed at this boundary.
        d.content = split.content
        d.reasoning_content = split.reasoning
        state.inReasoning = split.inReasoning
        mutated = true
      }
    }
  }

  return mutated ? d : null
}
