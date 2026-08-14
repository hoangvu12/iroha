import { randomUUID } from 'node:crypto'
import type {
  InferenceAdapter,
  InferenceAdapterCapabilities,
  InferenceForwardRequest,
  InferenceForwardResult,
} from './adapter.ts'

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
 * Hop-by-hop headers (RFC 9113 §8.2.2 and friends), proxy-control headers,
 * credential-bearing headers, and headers Iroha itself owns are never
 * forwarded upstream. Everything else passes through so provider extensions
 * keep working.
 */
const BLOCKED_HEADERS = new Set([
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
      const signal = request.signal ?? null

      const follow = request.redirectAllowSameOrigin ? 'follow-same-origin' : 'manual'
      const response = await fetchWithSameOriginRedirects(fetchImpl, {
        url: upstreamUrl(request.baseUrl, request.path),
        method: request.method,
        headers: upstreamHeaders,
        body: request.body ?? undefined,
        signal,
        follow,
        origin: sameOriginOf(request.baseUrl),
      })

      if (request.stream === true) {
        const upstream = response.body ?? new ReadableStream<Uint8Array>()
        return {
          kind: 'stream',
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
          stream: upstream.pipeThrough(createOpenAiStreamingNormalizer()),
        }
      }

      const rawBody = await response.text()
      return {
        kind: 'buffered',
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
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
  const content = next.content

  if (existingReasoning === undefined && typeof content === 'string') {
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
 * A manually-redirected fetch the same-origin path walks. The transport is
 * `redirect: 'manual'` on every call; the wrapper inspects each response and,
 * when the Owner enabled same-origin redirects, follows it as long as the
 * `Location` stays on the configured origin. A cross-origin hop returns the
 * redirect response itself so the routing layer can map it to `upstream_redirect`.
 */
async function fetchWithSameOriginRedirects(
  fetchImpl: typeof fetch,
  options: {
    url: string
    method: InferenceForwardRequest['method']
    headers: Readonly<Record<string, string>>
    body: string | undefined
    signal: AbortSignal | null
    follow: 'manual' | 'follow-same-origin'
    origin: string | null
  },
): Promise<Response> {
  let currentUrl = options.url
  let currentHeaders: Record<string, string> = { ...options.headers }

  while (true) {
    const response = await fetchImpl(currentUrl, {
      method: options.method,
      headers: currentHeaders,
      body: options.body,
      redirect: 'manual',
      signal: options.signal,
    })

    if (response.status < 300 || response.status >= 400) return response
    if (options.follow !== 'follow-same-origin') return response
    if (options.origin === null) return response

    const location = response.headers.get('location')
    if (location === null) return response
    void response.body?.cancel().catch(() => undefined)

    const nextUrl = new URL(location, currentUrl).href
    if (!sameOrigin(nextUrl, options.origin)) return response

    // Credentials and static headers stay in place because the resolved URL
    // remains on the configured origin. Iroha never propagates them across a
    // host change; this branch is exactly the "same-origin only" path.
    currentUrl = nextUrl
  }
}

/** The `{scheme}://{host}:{port}` portion of a base URL, or null when invalid. */
function sameOriginOf(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return null
  }
}

/** Two URLs share an origin when their scheme, host, and port match. */
function sameOrigin(url: string, origin: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return `${parsed.protocol}//${parsed.host}` === origin
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
interface StreamingChoiceState {
  inReasoning: boolean
}

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
      buffer += STREAM_DECODER.decode(chunk, { stream: true })

      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const out = normalizeSseEvent(event, choiceStates)
        if (out !== null) {
          if (out === '[DONE]') {
            if (doneEmitted) continue
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
      buffer += STREAM_DECODER.decode()
      if (buffer.length === 0) return
      const out = normalizeSseEvent(buffer, choiceStates)
      buffer = ''
      if (out === null) {
        controller.enqueue(STREAM_ENCODER.encode(`${buffer}\n\n`))
      } else if (out === '[DONE]') {
        if (!doneEmitted) controller.enqueue(STREAM_ENCODER.encode(`data: [DONE]\n\n`))
      } else {
        controller.enqueue(STREAM_ENCODER.encode(`data: ${out}\n\n`))
      }
    },
  })
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
    const state = choiceStates.get(idx) ?? { inReasoning: false }
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

  const content = d.content
  // Skip the split when the upstream already published a separate
  // reasoning field — the buffered normaliser treats that as authoritative,
  // and the streaming path has to do the same so OpenRouter / Kimi / GLM
  // responses round-trip untouched.
  if (typeof content === 'string' && content.length > 0 && !('reasoning_content' in d) && !('reasoning' in d)) {
    const split = splitStreamingReasoning(state, content)
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

  return mutated ? d : null
}

interface StreamingSplitResult {
  reasoning: string
  content: string
  inReasoning: boolean
  mutated: boolean
}

/**
 * Routes characters of one `delta.content` string into `reasoning` vs
 * `content` based on the current open/close state and the positions of
 * `<think|thinking|budget:thinking>` and `</…>` tags inside it. Tags that
 * straddle the boundary are split across the two outputs so the close-tag
 * prefix stays with the reasoning half and the trailing whitespace stays
 * with the clean-text half — preserving the visible output's leading
 * whitespace while keeping the reasoning field tight.
 */
export function splitStreamingReasoning(
  initial: StreamingChoiceState,
  text: string,
): StreamingSplitResult {
  const tagRegex = /<\/?(?:think|thinking|budget:thinking)>/g
  let reasoning = ''
  let content = ''
  let state = initial.inReasoning
  let mutated = false
  let sawCloseInChunk = false
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = tagRegex.exec(text)) !== null) {
    mutated = true
    const isClose = m[0].startsWith('</')
    const between = text.slice(lastIndex, m.index)
    if (state) reasoning += between
    else content += between

    if (isClose && state) {
      state = false
      sawCloseInChunk = true
    } else if (!isClose && !state) {
      state = true
    }

    lastIndex = m.index + m[0].length
  }
  const trailing = text.slice(lastIndex)
  if (state) {
    reasoning += trailing
  } else {
    content += trailing
  }

  // The upstream emits `</think>\n\n<visible>`. When this chunk carries
  // both the close tag and the first visible characters, the leading
  // whitespace pair belongs to the reasoning block visually but arrives
  // inside the *content* run — strip it here so a concatenating client
  // sees no stray blank prefix.
  if (sawCloseInChunk && content.length > 0) {
    content = content.replace(/^\s+/, '')
  }

  if (trailing.length > 0 && mutated) mutated = true

  return { reasoning, content, inReasoning: state, mutated }
}
