/**
 * The Anthropic Inference Adapter: the single source of truth for the
 * OpenAI ↔ Anthropic translation that lets an OpenAI-shaped caller reach an
 * Anthropic Provider Connection through Iroha. The generic Inference Adapter
 * knows nothing of Anthropic's wire format; this adapter owns the system
 * hoisting, the `max_tokens` defaulting, the header injection (`x-api-key`
 * plus the `anthropic-version` the caller chose or `2023-06-01` as fallback),
 * the path remap (`/chat/completions` → `/messages`), the response translation
 * (stop-reason mapping, usage field mapping), and the error envelope
 * translation.
 *
 * The scope of this ticket is text-only, non-streaming Chat Completions.
 * Streaming, the tool-name sanitiser, the `/v1/messages` caller surface, the
 * `/v1/responses` bridge, and the `response_format` ↔ `output_config.format`
 * translation are added by later tickets.
 */

import { adapterBlockedHeaders } from './blocked-headers.ts'
import { classifyGenericFailure, upstreamUrl } from './generic-adapter.ts'
import type {
  InferenceAdapter,
  InferenceAdapterCapabilities,
  InferenceFailureClassification,
  InferenceForwardRequest,
  InferenceForwardResult,
  InferenceBufferedResult,
} from './adapter.ts'

/**
 * The hardcoded fallback when no per-model entry matches. Anthropic enforces
 * a hard upper bound (model-dependent) and rejects any request whose
 * `max_tokens` exceeds it. 4096 is a conservative value every Anthropic model
 * accepts.
 */
export const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096

/**
 * The Anthropic SDK default `anthropic-version`. The SDK source (`client.ts`
 * in `anthropic-sdk-typescript`) and Anthropic's own `/api/versioning` still
 * publish this as the only documented version. The adapter honors the
 * caller's `anthropic-version` header when present; this is the fallback.
 */
export const DEFAULT_ANTHROPIC_VERSION = '2023-06-01'

/**
 * The published `max_tokens` ceiling for each Anthropic model the template
 * lists. Unknown models fall back to {@link DEFAULT_ANTHROPIC_MAX_TOKENS} so
 * a newly released model that hasn't been added to the table yet still passes
 * a value Anthropic will accept. Mirrors LiteLLM's per-model table
 * (`litellm/llms/anthropic/chat/transformation.py`).
 */
const ANTHROPIC_MAX_TOKENS: Readonly<Record<string, number>> = {
  'anthropic-opus-5': 32_000,
  'anthropic-sonnet-5': 64_000,
  'anthropic-fable-5': 32_000,
  'anthropic-mythos-5': 32_000,
  'anthropic-opus-4-8': 32_000,
  'anthropic-opus-4-7': 32_000,
  'anthropic-mythos-preview': 32_000,
  'anthropic-opus-4-6': 32_000,
  'anthropic-sonnet-4-6': 64_000,
  'anthropic-haiku-4-5': 8_192,
  'anthropic-haiku-4-5-20251001': 8_192,
  'anthropic-opus-4-5': 32_000,
  'anthropic-opus-4-5-20251101': 32_000,
  'anthropic-sonnet-4-5': 64_000,
  'anthropic-sonnet-4-5-20250929': 64_000,
}

/**
 * Returns the published `max_tokens` ceiling for the given model. Unknown
 * model ids fall back to {@link DEFAULT_ANTHROPIC_MAX_TOKENS}.
 */
export function getMaxTokensForModel(model: string): number {
  return ANTHROPIC_MAX_TOKENS[model] ?? DEFAULT_ANTHROPIC_MAX_TOKENS
}

const ANTHROPIC_CAPABILITIES: InferenceAdapterCapabilities = {
  idempotencyHeader: 'Idempotency-Key',
  idempotencyGenerationSafe: true,
}

export interface AnthropicInferenceAdapterOptions {
  /** Injectable transport; production uses the runtime's fetch. */
  readonly fetch?: typeof fetch
}

/**
 * Builds the Anthropic Inference Adapter. The adapter implements the same
 * `InferenceAdapter` contract the generic adapter does; the HTTP route picks
 * one or the other based on the Provider Connection's `inferenceAdapterId`.
 */
export function createAnthropicInferenceAdapter(
  options: AnthropicInferenceAdapterOptions = {},
): InferenceAdapter {
  const fetchImpl = options.fetch ?? globalThis.fetch

  return {
    capabilities: ANTHROPIC_CAPABILITIES,

    classifyFailure: classifyAnthropicFailure,

    async forward(request: InferenceForwardRequest): Promise<InferenceForwardResult> {
      const upstreamPath = remapUpstreamPath(request.path)
      const parsedBody = parseJsonOrThrow(request.body)
      const model = readModel(parsedBody)
      const translated = translateOpenAiToAnthropic(parsedBody, model)

      const callHeaders = buildUpstreamHeaders({
        callerHeaders: request.headers,
        authHeader: request.authHeader,
        authPrefix: request.authPrefix,
        upstreamKey: request.upstreamKey,
        staticHeaders: request.staticHeaders,
      })

      const response = await fetchImpl(upstreamUrl(request.baseUrl, upstreamPath), {
        method: 'POST',
        headers: callHeaders,
        body: JSON.stringify(translated),
        signal: request.signal ?? null,
      })

      const responseHeaders: Record<string, string> = Object.fromEntries(response.headers.entries())
      const rawBody = await response.text()

      if (response.status < 200 || response.status >= 300) {
        return translateErrorResponse(response.status, rawBody, responseHeaders)
      }

      return translateAnthropicCompletionResponse(rawBody, model)
    },
  }
}

/**
 * Remaps the Iroha-side OpenAI-shaped path to the Anthropic path. The HTTP
 * route is provider-scoped and OpenAI-shaped (`/v1/chat/completions`) on the
 * way in; this adapter turns it into the Anthropic Messages path. The
 * `/v1/responses` path is owned by ticket 04 and ticket 05; rejecting it
 * here keeps the ticket 01 contract honest about what it implements.
 */
function remapUpstreamPath(path: string): string {
  if (path === '/chat/completions') return '/messages'
  throw new AnthropicForwardError(
    400,
    'invalid_request',
    `Anthropic Inference Adapter does not handle upstream path ${JSON.stringify(path)}`,
  )
}

/**
 * A structural error the adapter raises when the OpenAI-shape body is not
 * translatable. Today the adapter only produces these for paths it does not
 * handle and for invalid JSON; the HTTP route maps them to the standard
 * Iroha error envelope.
 */
export class AnthropicForwardError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'AnthropicForwardError'
    this.status = status
    this.code = code
  }
}

function parseJsonOrThrow(body: string | null): Record<string, unknown> {
  if (body === null || body === '') {
    throw new AnthropicForwardError(400, 'invalid_request', 'Anthropic request body is required.')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new AnthropicForwardError(400, 'invalid_request', 'Anthropic request body is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new AnthropicForwardError(400, 'invalid_request', 'Anthropic request body must be a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function readModel(body: Record<string, unknown>): string {
  const model = body.model
  if (typeof model !== 'string' || model.trim() === '') {
    throw new AnthropicForwardError(400, 'model_required', 'The request must name a model.')
  }
  return model.trim()
}

function buildUpstreamHeaders(options: {
  callerHeaders: Readonly<Record<string, string>>
  authHeader: string
  authPrefix: string
  upstreamKey: string
  staticHeaders: Readonly<Record<string, string>>
}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.callerHeaders)) {
    if (isBlockedHeader(name)) continue
    out[name.toLowerCase()] = value
  }
  out[options.authHeader.toLowerCase()] = `${options.authPrefix}${options.upstreamKey}`
  for (const [name, value] of Object.entries(options.staticHeaders)) {
    if (name.toLowerCase() === options.authHeader.toLowerCase()) continue
    out[name.toLowerCase()] = value
  }
  out['content-type'] = 'application/json'
  out['accept'] = 'application/json'
  out['anthropic-version'] = out['anthropic-version'] ?? DEFAULT_ANTHROPIC_VERSION
  return out
}

function isBlockedHeader(name: string): boolean {
  if (adapterBlockedHeaders.has(name.toLowerCase())) return true
  if (name.toLowerCase().startsWith('iroha-')) return true
  return false
}

/**
 * Translates the OpenAI-shape Chat Completions body into the Anthropic
 * Messages body this adapter sends upstream. The contract is deliberately
 * small today: every `role: "system"` message inside `messages[]` is hoisted
 * into the top-level `system` array, and `max_tokens` is filled in from
 * {@link getMaxTokensForModel} when the caller omitted it.
 *
 * The rest of the OpenAI shape (user, assistant, and other fields) is
 * passed through. Tools, images, documents, response_format, extended
 * thinking, stop sequences, and other Anthropic-specific fields are added by
 * later tickets.
 */
function translateOpenAiToAnthropic(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const messagesRaw = body.messages
  if (!Array.isArray(messagesRaw)) {
    throw new AnthropicForwardError(400, 'invalid_request', 'Anthropic messages must be an array.')
  }

  const systemBlocks: Array<Record<string, unknown>> = []
  const translatedMessages: Array<Record<string, unknown>> = []
  for (const entry of messagesRaw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AnthropicForwardError(400, 'invalid_request', 'Anthropic messages must be JSON objects.')
    }
    const message = entry as Record<string, unknown>
    if (message.role === 'system') {
      const blocks = textBlocksFor(message.content, message.name)
      for (const block of blocks) systemBlocks.push(block)
      continue
    }
    translatedMessages.push({
      role: typeof message.role === 'string' && message.role.length > 0 ? message.role : 'user',
      content: message.content,
    })
  }

  const maxTokens = readMaxTokens(body.max_tokens) ?? getMaxTokensForModel(model)

  const out: Record<string, unknown> = {
    model,
    messages: translatedMessages,
    max_tokens: maxTokens,
  }
  if (systemBlocks.length > 0) out.system = systemBlocks
  for (const [key, value] of Object.entries(body)) {
    if (key === 'model' || key === 'messages' || key === 'stream' || key === 'max_tokens') continue
    out[key] = value
  }
  return out
}

function readMaxTokens(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}

function textBlocksFor(
  content: unknown,
  name: unknown,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    if (content.length === 0) return []
    const block: Record<string, unknown> = { type: 'text', text: content }
    if (typeof name === 'string' && name.length > 0) block.name = name
    return [block]
  }
  if (Array.isArray(content)) {
    const blocks: Array<Record<string, unknown>> = []
    for (const entry of content) {
      if (entry === null || typeof entry !== 'object') continue
      const block = entry as Record<string, unknown>
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
        blocks.push({ type: 'text', text: block.text })
        continue
      }
      if (typeof block.text === 'string' && block.text.length > 0) {
        const next: Record<string, unknown> = { type: 'text', text: block.text }
        if (typeof name === 'string' && name.length > 0) next.name = name
        blocks.push(next)
      }
    }
    return blocks
  }
  return []
}

/**
 * Translates an Anthropic non-streaming Messages response into an
 * OpenAI-shaped Chat Completions response. The body matches Anthropic's
 * documented `/v1/messages` shape (`id: msg_*`, `type: "message"`,
 * `role: "assistant"`, `content: [{type: "text", ...}]`, `stop_reason`,
 * `usage`).
 */
function translateAnthropicCompletionResponse(rawBody: string, fallbackModel: string): InferenceBufferedResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return bufferedRaw(rawBody)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return bufferedRaw(rawBody)
  }
  const root = parsed as Record<string, unknown>

  if (root.type === 'error') {
    return translateAnthropicErrorEnvelope(root, rawBody)
  }

  const id = typeof root.id === 'string' ? root.id : `msg_${fallbackModel}-${randomSuffix()}`
  const model = typeof root.model === 'string' ? root.model : fallbackModel
  const content = Array.isArray(root.content) ? root.content : []
  const text = collectText(content)
  const finishReason = mapStopReason(root.stop_reason)
  const usage = mapUsage(root.usage)

  const out = {
    id,
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: finishReason,
        logprobs: null,
      },
    ],
    usage,
  }
  return {
    kind: 'buffered',
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(out),
  }
}

function translateErrorResponse(
  status: number,
  rawBody: string,
  headers: Readonly<Record<string, string>>,
): InferenceBufferedResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    parsed = null
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const root = parsed as Record<string, unknown>
    if (root.type === 'error') {
      return translateAnthropicErrorEnvelope(root, rawBody, headers)
    }
  }
  const code = openAiCodeForStatus(status)
  return {
    kind: 'buffered',
    status,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      error: {
        message: 'The Provider answered with an error.',
        type: openAiTypeForStatus(status),
        param: null,
        code,
      },
    }),
  }
}

function translateAnthropicErrorEnvelope(
  root: Record<string, unknown>,
  rawBody: string,
  headers?: Readonly<Record<string, string>>,
): InferenceBufferedResult {
  const status = openAiStatusForAnthropicError(root)
  const code = openAiCodeForStatus(status)
  const message = readAnthropicErrorMessage(root)
  const requestId = typeof root.request_id === 'string' ? root.request_id : null
  const out = {
    error: {
      message,
      type: openAiTypeForStatus(status),
      param: null,
      code,
      ...(requestId === null ? {} : { request_id: requestId }),
    },
  }
  return {
    kind: 'buffered',
    status,
    headers: {
      ...(headers ?? {}),
      'content-type': 'application/json',
    },
    body: rawBody.length === 0 ? JSON.stringify(out) : rawBody,
  }
}

function readAnthropicErrorMessage(root: Record<string, unknown>): string {
  const error = root.error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) {
    return 'The Provider answered with an error.'
  }
  const message = (error as Record<string, unknown>).message
  return typeof message === 'string' && message.length > 0 ? message : 'The Provider answered with an error.'
}

function openAiStatusForAnthropicError(root: Record<string, unknown>): number {
  const error = root.error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return 502
  const type = (error as Record<string, unknown>).type
  switch (type) {
    case 'invalid_request_error':
      return 400
    case 'authentication_error':
      return 401
    case 'billing_error':
      return 402
    case 'permission_error':
      return 403
    case 'not_found_error':
      return 404
    case 'conflict_error':
      return 409
    case 'request_too_large':
      return 413
    case 'rate_limit_error':
      return 429
    case 'timeout_error':
      return 504
    case 'overloaded_error':
      return 529
    case 'api_error':
      return 500
    default:
      return 502
  }
}

function openAiCodeForStatus(status: number): string {
  if (status === 401) return 'upstream_invalid_credentials'
  if (status === 403) return 'upstream_forbidden'
  if (status === 404) return 'upstream_not_found'
  if (status === 429) return 'upstream_rate_limited'
  if (status === 400) return 'upstream_bad_request'
  if (status >= 500) return 'upstream_unavailable'
  return 'upstream_error'
}

function openAiTypeForStatus(status: number): string {
  if (status === 401) return 'authentication_error'
  if (status === 403) return 'permission_error'
  if (status === 404) return 'not_found_error'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

/**
 * Maps Anthropic `stop_reason` to the OpenAI `finish_reason` vocabulary. The
 * ticket specifies three mappings; unknown reasons fall back to `stop` so the
 * caller always gets a stable value and never an unexpected null.
 */
function mapStopReason(reason: unknown): string {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
      return 'length'
    case 'refusal':
      return 'content_filter'
    default:
      return 'stop'
  }
}

/**
 * Translates Anthropic usage to OpenAI usage. Anthropic's `total_tokens` is
 * the sum of `input_tokens`, `cache_creation_input_tokens`, and
 * `cache_read_input_tokens` (`docs/research/anthropic-api.md` section C); the
 * Iroha surface mirrors that so the OpenAI SDK gets the same total a direct
 * Anthropic call would.
 */
function mapUsage(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
  const usage = raw as Record<string, unknown>
  const inputTokens = readUsageNumber(usage.input_tokens) ?? 0
  const outputTokens = readUsageNumber(usage.output_tokens) ?? 0
  const cacheCreation = readUsageNumber(usage.cache_creation_input_tokens) ?? 0
  const cacheRead = readUsageNumber(usage.cache_read_input_tokens) ?? 0
  const thinkingTokens = readThinkingTokens(usage.output_tokens_details)
  const cachedTokens = (cacheCreation > 0 || cacheRead > 0) ? cacheCreation + cacheRead : null
  const out: Record<string, unknown> = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: inputTokens + cacheCreation + cacheRead + outputTokens,
  }
  if (cacheCreation > 0 || cacheRead > 0) {
    out.cache_creation_input_tokens = cacheCreation
    out.cache_read_input_tokens = cacheRead
  }
  if (cachedTokens !== null) out.prompt_tokens_details = { cached_tokens: cachedTokens }
  if (thinkingTokens !== null) out.completion_tokens_details = { reasoning_tokens: thinkingTokens }
  return out
}

function readThinkingTokens(value: unknown): number | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const thinkingTokens = (value as Record<string, unknown>).thinking_tokens
  return readUsageNumber(thinkingTokens)
}

function readUsageNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.floor(value)
}

function collectText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const entry = block as Record<string, unknown>
    if (entry.type === 'text' && typeof entry.text === 'string') {
      out += entry.text
    }
  }
  return out
}

function bufferedRaw(body: string): InferenceBufferedResult {
  return { kind: 'buffered', status: 200, headers: { 'content-type': 'application/json' }, body }
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 12)
}

/**
 * Classifies one Anthropic-shaped answer. The Anthropic adapter translates
 * upstream status codes to OpenAI vocabulary before returning
 * (`authentication_error → 401`, `rate_limit_error → 429`, etc.), so the
 * generic OpenAI-shaped classification is the right call here: the Iroha
 * retry engine consumes the same fields a generic Provider would.
 */
export function classifyAnthropicFailure(result: InferenceForwardResult): InferenceFailureClassification {
  return classifyGenericFailure(result)
}
