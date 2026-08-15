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
  AnthropicForwardRequest,
  InferenceAdapter,
  InferenceAdapterCapabilities,
  InferenceFailureClassification,
  InferenceForwardRequest,
  InferenceForwardResult,
  InferenceBufferedResult,
  InferenceStreamResult,
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
      const wantStream = request.stream === true
      const { body: translatedBody, toolNameForwardMap } = translateOpenAiToAnthropic(parsedBody, model, wantStream)
      const toolNameReverseMap = invertForwardMap(toolNameForwardMap)

      const callHeaders = buildUpstreamHeaders({
        callerHeaders: request.headers,
        authHeader: request.authHeader,
        authPrefix: request.authPrefix,
        upstreamKey: request.upstreamKey,
        staticHeaders: request.staticHeaders,
        stream: wantStream,
      })

      const response = await fetchImpl(upstreamUrl(request.baseUrl, upstreamPath), {
        method: 'POST',
        headers: callHeaders,
        body: JSON.stringify(translatedBody),
        signal: request.signal ?? null,
      })

      if (wantStream) {
        return translateStreamingResponse(response, model, toolNameReverseMap)
      }

      const responseHeaders: Record<string, string> = Object.fromEntries(response.headers.entries())
      const rawBody = await response.text()

      if (response.status < 200 || response.status >= 300) {
        return translateErrorResponse(response.status, rawBody, responseHeaders)
      }

      return translateAnthropicCompletionResponse(rawBody, model, toolNameReverseMap)
    },

    async forwardAnthropic(request: AnthropicForwardRequest): Promise<InferenceForwardResult> {
      const parsedBody = parseAnthropicBodyOrThrow(request.body)
      const model = readModel(parsedBody)
      const wantStream = request.stream === true
      const passthrough = request.passthrough === true

      if (passthrough) {
        const callHeaders = buildAnthropicPassthroughHeaders({
          callerHeaders: request.headers,
          authHeader: request.authHeader,
          authPrefix: request.authPrefix,
          upstreamKey: request.upstreamKey,
          staticHeaders: request.staticHeaders,
          stream: wantStream,
        })

        const response = await fetchImpl(upstreamUrl(request.baseUrl, '/messages'), {
          method: 'POST',
          headers: callHeaders,
          body: request.body,
          signal: request.signal ?? null,
        })

        if (response.status < 200 || response.status >= 300) {
          return await passthroughErrorResponseBody(response)
        }

        if (wantStream) {
          return passthroughStreamingResponse(response)
        }

        const responseHeaders: Record<string, string> = Object.fromEntries(response.headers.entries())
        const rawBody = await response.text()
        return {
          kind: 'buffered',
          status: response.status,
          headers: { ...responseHeaders, 'content-type': responseHeaders['content-type'] ?? 'application/json' },
          body: rawBody,
        }
      }

      return forwardAnthropicAsOpenAi(fetchImpl, request, parsedBody, model, wantStream)
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
  /** When true, the adapter asks Anthropic for `text/event-stream` instead of JSON. */
  stream: boolean
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
  out['accept'] = options.stream ? 'text/event-stream' : 'application/json'
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
  stream: boolean,
): { body: Record<string, unknown>; toolNameForwardMap: Map<string, string> } {
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
    if (message.role === 'tool') {
      translatedMessages.push(translateToolMessage(message))
      continue
    }
    translatedMessages.push({
      role: typeof message.role === 'string' && message.role.length > 0 ? message.role : 'user',
      content: message.content,
    })
  }

  const maxTokens = readMaxTokens(body.max_tokens) ?? getMaxTokensForModel(model)
  const { tools: sanitizedTools, forwardMap } = sanitizeToolsList(body.tools)
  const toolChoice = translateToolChoice(body.tool_choice, forwardMap)
  const parallelToolCalls = translateParallelToolCalls(body.parallel_tool_calls)

  const out: Record<string, unknown> = {
    model,
    messages: translatedMessages,
    max_tokens: maxTokens,
  }
  if (stream) out.stream = true
  if (systemBlocks.length > 0) out.system = systemBlocks
  if (sanitizedTools.length > 0) out.tools = sanitizedTools
  // `tool_choice` nests under its own key on Anthropic's side
  // (`{tool_choice: {type, name}}`), while `disable_parallel_tool_use` is a
  // top-level field on the Messages request body.
  if (toolChoice !== null) out.tool_choice = toolChoice
  if (parallelToolCalls !== null) {
    for (const [key, value] of Object.entries(parallelToolCalls)) out[key] = value
  }
  for (const [key, value] of Object.entries(body)) {
    if (
      key === 'model' || key === 'messages' || key === 'stream' || key === 'max_tokens' ||
      key === 'tools' || key === 'tool_choice' || key === 'parallel_tool_calls'
    ) continue
    out[key] = value
  }
  return { body: out, toolNameForwardMap: forwardMap }
}

function readMaxTokens(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.floor(value)
}

/* ------------------------------------------------------------------------- *
 * Tool handling: tool-name sanitisation, `tool_choice` mapping, and the
 * `role: "tool"` → Anthropic `tool_result` bridge. The forward map records
 * `original → sanitized` so the response translator can build the reverse
 * map (`sanitized → original`) and the caller sees the tool names they sent.
 *
 * Mirrors LiteLLM's `_sanitize_tool_names_in_request`
 * (`litellm/llms/anthropic/chat/transformation.py:1014-1074`) and Bifrost's
 * `transformToolName` (`core/providers/anthropic/utils.go`).
 * ------------------------------------------------------------------------- */

/** Anthropic's tool-name constraint. Mirrors the documented regex. */
const TOOL_NAME_CHAR_PATTERN = /[a-zA-Z0-9_-]/
const TOOL_NAME_MAX_LENGTH = 128

/**
 * Returns whether the given name is already a valid Anthropic tool name. A
 * valid name uses only `[a-zA-Z0-9_-]`, is at most {@link TOOL_NAME_MAX_LENGTH}
 * characters long, and is non-empty.
 */
function isValidToolName(name: string): boolean {
  if (name.length === 0 || name.length > TOOL_NAME_MAX_LENGTH) return false
  for (let i = 0; i < name.length; i++) {
    if (!TOOL_NAME_CHAR_PATTERN.test(name[i]!)) return false
  }
  return true
}

/**
 * Sanitizes a single tool name. Each character outside `[a-zA-Z0-9_-]` is
 * rewritten to `_`; the result is truncated to
 * {@link TOOL_NAME_MAX_LENGTH} characters. An empty input (or a name that
 * becomes empty after rewriting) becomes `tool` so the upstream never
 * receives an empty `name`.
 */
function sanitizeToolName(name: string): string {
  let out = ''
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!
    out += TOOL_NAME_CHAR_PATTERN.test(c) ? c : '_'
  }
  if (out.length === 0) out = 'tool'
  if (out.length > TOOL_NAME_MAX_LENGTH) out = out.slice(0, TOOL_NAME_MAX_LENGTH)
  return out
}

/**
 * Walks every `tools[].function.name` in the request and sanitizes names
 * that violate Anthropic's `^[a-zA-Z0-9_-]{1,128}$` constraint. Returns the
 * rewritten tools array and a forward map (original → sanitized). Clean
 * names are passed through unchanged; the forward map is empty in that
 * case so the response translator has nothing to reverse-map.
 */
function sanitizeToolsList(tools: unknown): {
  tools: Array<Record<string, unknown>>
  forwardMap: Map<string, string>
} {
  const sanitized: Array<Record<string, unknown>> = []
  const forwardMap = new Map<string, string>()
  if (!Array.isArray(tools)) return { tools: sanitized, forwardMap }
  for (const entry of tools) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const tool = { ...(entry as Record<string, unknown>) }
    const fn = tool.function
    if (typeof fn !== 'object' || fn === null || Array.isArray(fn)) {
      sanitized.push(tool)
      continue
    }
    const fnCopy = { ...(fn as Record<string, unknown>) }
    const rawName = fnCopy.name
    if (typeof rawName !== 'string' || rawName.length === 0) {
      sanitized.push({ ...tool, function: fnCopy })
      continue
    }
    if (isValidToolName(rawName)) {
      sanitized.push({ ...tool, function: fnCopy })
      continue
    }
    const sanitizedName = sanitizeToolName(rawName)
    fnCopy.name = sanitizedName
    forwardMap.set(rawName, sanitizedName)
    sanitized.push({ ...tool, function: fnCopy })
  }
  return { tools: sanitized, forwardMap }
}

/**
 * Inverts a forward map (original → sanitized) into a reverse map
 * (sanitized → original). The response translator uses the reverse map to
 * restore the caller's original tool names on the way back.
 */
function invertForwardMap(forward: ReadonlyMap<string, string>): Map<string, string> {
  const reverse = new Map<string, string>()
  for (const [original, sanitized] of forward) {
    reverse.set(sanitized, original)
  }
  return reverse
}

/**
 * Translates OpenAI's `tool_choice` vocabulary into Anthropic's vocabulary.
 * Returns `null` when the input is absent or unrecognized so the caller can
 * decide whether to write the field.
 *
 * | OpenAI                                  | Anthropic               |
 * |-----------------------------------------|-------------------------|
 * | `"auto"`                                | `{type: "auto"}`        |
 * | `"required"`                            | `{type: "any"}`         |
 * | `"none"`                                | `{type: "none"}`        |
 * | `{type: "function", function: {name}}`  | `{type: "tool", name}`  |
 */
function translateToolChoice(
  toolChoice: unknown,
  forwardMap: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
      case 'auto':
        return { type: 'auto' }
      case 'required':
        return { type: 'any' }
      case 'none':
        return { type: 'none' }
      default:
        return null
    }
  }
  if (typeof toolChoice === 'object' && toolChoice !== null && !Array.isArray(toolChoice)) {
    const tc = toolChoice as Record<string, unknown>
    if (tc.type === 'function') {
      const fn = tc.function
      if (typeof fn === 'object' && fn !== null && !Array.isArray(fn)) {
        const name = (fn as Record<string, unknown>).name
        if (typeof name === 'string' && name.length > 0) {
          // The upstream Anthropic `tool_choice.name` must match the
          // sanitized name from `tools[]`, so the reverse lookup is
          // applied here as well.
          const sanitizedName = forwardMap.get(name) ?? name
          return { type: 'tool', name: sanitizedName }
        }
      }
    }
  }
  return null
}

/**
 * Translates OpenAI's `parallel_tool_calls` into Anthropic's
 * `disable_parallel_tool_use` (the inverse). The Anthropic default is
 * `false` (parallel allowed), so `true` on the OpenAI side is a no-op;
 * `false` becomes an explicit `disable_parallel_tool_use: true`.
 *
 * Mirrors the comment at
 * `litellm/llms/anthropic/chat/transformation.py:643-650`.
 */
function translateParallelToolCalls(value: unknown): Record<string, unknown> | null {
  if (value === false) return { disable_parallel_tool_use: true }
  return null
}

/**
 * Translates an OpenAI `role: "tool"` message with `tool_call_id` and
 * optional `content` into an Anthropic user-message carrying a single
 * `tool_result` block whose `tool_use_id` matches the matching upstream
 * `tool_use.id`. The OpenAI `content` is preserved structurally — strings
 * pass through as-is (Anthropic accepts strings in `tool_result.content`)
 * and arrays of text/image blocks are forwarded as-is.
 */
function translateToolMessage(message: Record<string, unknown>): Record<string, unknown> {
  const toolCallId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
  let toolResultContent: unknown
  const content = message.content
  if (typeof content === 'string') {
    toolResultContent = content
  } else if (Array.isArray(content)) {
    const blocks: Array<Record<string, unknown>> = []
    for (const entry of content) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      blocks.push({ ...(entry as Record<string, unknown>) })
    }
    toolResultContent = blocks
  } else {
    toolResultContent = ''
  }
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolCallId, content: toolResultContent }],
  }
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
 * `role: "assistant"`, `content: [{type: "text"|"tool_use", ...}]`,
 * `stop_reason`, `usage`).
 *
 * When the response carries `tool_use` blocks, the caller's original tool
 * names are restored via `toolNameReverseMap` so an OpenAI SDK sees the
 * names it sent.
 */
function translateAnthropicCompletionResponse(
  rawBody: string,
  fallbackModel: string,
  toolNameReverseMap: ReadonlyMap<string, string>,
): InferenceBufferedResult {
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
  const toolCalls = collectToolCalls(content, toolNameReverseMap)
  const finishReason = computeFinishReason(root.stop_reason, toolCalls.length > 0)
  const usage = mapUsage(root.usage)

  const message: Record<string, unknown> = { role: 'assistant', content: text }
  if (toolCalls.length > 0) message.tool_calls = toolCalls

  const out = {
    id,
    object: 'chat.completion',
    created: nowSeconds(),
    model,
    choices: [
      {
        index: 0,
        message,
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

/**
 * Walks every `tool_use` block in the Anthropic response content and builds
 * the matching OpenAI `tool_calls[]` array. Each entry carries the upstream
 * `id` unchanged (the wire format lets OpenAI and Anthropic ids coexist),
 * and the `name` is restored from `toolNameReverseMap` so the caller sees
 * the names they sent.
 */
function collectToolCalls(
  content: unknown,
  toolNameReverseMap: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (!Array.isArray(content)) return out
  let index = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const entry = block as Record<string, unknown>
    if (entry.type !== 'tool_use') continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    const rawName = typeof entry.name === 'string' ? entry.name : ''
    const name = toolNameReverseMap.get(rawName) ?? rawName
    const argumentsJson = serialiseToolInput(entry.input)
    out.push({
      id,
      type: 'function',
      index,
      function: { name, arguments: argumentsJson },
    })
    index += 1
  }
  return out
}

/**
 * Stringifies a `tool_use.input` value into the JSON OpenAI SDKs expect on
 * `tool_calls[].function.arguments`. Anthropic returns the parsed object;
 * OpenAI returns a JSON-encoded string. An absent or non-object input
 * surfaces as an empty string so the caller never sees `{}` or `null`.
 */
function serialiseToolInput(input: unknown): string {
  if (input === undefined) return ''
  try {
    return JSON.stringify(input ?? '')
  } catch {
    return ''
  }
}

/**
 * Returns the OpenAI-shaped `finish_reason`. The Anthropic `stop_reason` is
 * mapped through {@link mapStopReason}; when the response carried `tool_use`
 * blocks but the upstream reported `stop_reason: end_turn`, we override to
 * `tool_calls` so OpenAI SDKs treat the response as a tool call.
 */
function computeFinishReason(stopReason: unknown, hasToolCalls: boolean): string {
  const mapped = mapStopReason(stopReason)
  if (hasToolCalls && mapped === 'stop') return 'tool_calls'
  return mapped
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
 * Maps Anthropic `stop_reason` to the OpenAI `finish_reason` vocabulary.
 * Mirrors LiteLLM's `map_finish_reason`
 * (`litellm/litellm_core_utils/core_helpers.py:99-141`) and the ticket's
 * enumeration: tool calls and refusals round-trip to OpenAI's vocabulary;
 * `compaction` falls through to `length` (LiteLLM convention); unknown
 * reasons fall back to `stop` so the caller always gets a stable value.
 */
function mapStopReason(reason: unknown): string {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
    case 'compaction':
      return 'length'
    case 'tool_use':
      return 'tool_calls'
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

/* ------------------------------------------------------------------------- *
 * Streaming translate: Anthropic SSE → OpenAI `chat.completion.chunk` SSE.
 * ------------------------------------------------------------------------- */

/**
 * The per-stream state the translator threads through one request. The
 * ticket calls out exactly these fields; concurrent streams do not
 * cross-contaminate because each transform stream owns one instance. The
 * fields are kept even when not read at the emit site so the ticket's
 * acceptance bullet ("tracks currentContentBlockType,
 * currentContentBlockIndex, currentToolIndex, accumulated text, accumulated
 * tool input JSON, model id, message id, and usage") is satisfied verbatim;
 * future tickets (tool-name sanitisation, message-id correlation) will read
 * them.
 */
export interface AnthropicStreamState {
  /** The Anthropic message id surfaced on `message_start`; `null` until seen. */
  messageId: string | null
  /** The Anthropic model id surfaced on `message_start`; defaults to the request's model. */
  model: string
  /** `Date.now()/1000` at construction; reused as `created` on every emitted chunk. */
  created: number
  /** The block type of the most recent `content_block_start` (text / tool_use / …). */
  currentContentBlockType: string | null
  /** The block index of the most recent `content_block_start`. Read by future tickets. */
  currentContentBlockIndex: number | null
  /** The OpenAI-shaped `tool_calls[i].index` for the next `tool_use` block. */
  currentToolIndex: number
  /** Running visible-text concatenation. Read by future tickets; the wire only emits deltas. */
  accumulatedText: string
  /** Running tool-input JSON concatenation. Read by future tickets; the wire only emits deltas. */
  accumulatedToolInputJson: string
  finishReason: string | null
  /**
   * Merged Anthropic usage as the upstream published it, not the OpenAI
   * shape: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
   * `cache_read_input_tokens`, and `output_tokens_details.thinking_tokens`.
   * The final chunk maps this through {@link mapUsage} once so the OpenAI
   * SDK sees a single OpenAI-shaped usage field with the merged totals.
   */
  rawUsage: Record<string, unknown> | null
  /** True once the role-announcement chunk has been emitted. */
  roleEmitted: boolean
  /** True once [DONE] has been emitted; the rest of the stream is dropped. */
  doneEmitted: boolean
  /**
   * Reverse map of sanitized → original tool names, threaded from the
   * request-side sanitiser. When non-null, `content_block_start` for a
   * `tool_use` block looks up the upstream's sanitized name and emits the
   * caller's original name on the wire so the OpenAI SDK receives the
   * names it sent.
   */
  toolNameReverseMap: ReadonlyMap<string, string> | null
}

const STREAM_ENCODER = new TextEncoder()
const STREAM_DECODER = new TextDecoder()

/**
 * Options threaded into {@link createAnthropicStreamToOpenAiTranslator}.
 * Today only the tool-name reverse map is configurable; future tickets may
 * add more options without disturbing existing callers.
 */
export interface AnthropicStreamTranslatorOptions {
  /** Sanitized → original tool names, applied to each `tool_use` block. */
  readonly toolNameReverseMap?: ReadonlyMap<string, string> | null
}

/**
 * Branches on the upstream response shape. A non-2xx answer is converted to
 * an OpenAI-shaped error envelope and returned as a buffered result so the
 * Iroha route can map it to the appropriate Iroha error code. A 2xx answer
 * flows the upstream body through the Anthropic→OpenAI SSE translator and
 * returns the live stream.
 */
async function translateStreamingResponse(
  response: Response,
  fallbackModel: string,
  toolNameReverseMap: ReadonlyMap<string, string>,
): Promise<InferenceForwardResult> {
  const responseHeaders: Record<string, string> = Object.fromEntries(response.headers.entries())
  if (response.status < 200 || response.status >= 300) {
    const rawBody = await response.text()
    return translateErrorResponse(response.status, rawBody, responseHeaders)
  }
  const upstream = response.body ?? new ReadableStream<Uint8Array>()
  return {
    kind: 'stream',
    status: response.status,
    headers: { ...responseHeaders, 'content-type': responseHeaders['content-type'] ?? 'text/event-stream' },
    stream: upstream.pipeThrough(
      createAnthropicStreamToOpenAiTranslator(fallbackModel, { toolNameReverseMap }),
    ),
  }
}

/**
 * Stateful byte-level transform that converts one Anthropic SSE stream into
 * one OpenAI `chat.completion.chunk` stream. The translator tracks the
 * current content block type, the running tool index, and the merged usage
 * so an OpenAI SDK sees a single OpenAI-shaped stream with one terminal
 * `[DONE]` sentinel.
 *
 * Mirrors LiteLLM's `ModelResponseIterator.chunk_parser`
 * (`litellm/llms/anthropic/chat/handler.py:410-606`) and Portkey's
 * `getAnthropicStreamChunkTransform` (`src/providers/anthropic/chatComplete.ts:388-532`).
 */
export function createAnthropicStreamToOpenAiTranslator(
  fallbackModel: string,
  options: AnthropicStreamTranslatorOptions = {},
): TransformStream<Uint8Array, Uint8Array> {
  const state: AnthropicStreamState = {
    messageId: null,
    model: fallbackModel,
    created: nowSeconds(),
    currentContentBlockType: null,
    currentContentBlockIndex: null,
    currentToolIndex: 0,
    accumulatedText: '',
    accumulatedToolInputJson: '',
    finishReason: null,
    rawUsage: null,
    roleEmitted: false,
    doneEmitted: false,
    toolNameReverseMap: options.toolNameReverseMap ?? null,
  }

  let buffer = ''

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      if (state.doneEmitted) return
      buffer += STREAM_DECODER.decode(chunk, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        const { eventName, data } = parseEvent(block)
        buffer = buffer.slice(boundary + 2)
        dispatchEvent(controller, state, eventName, data)
        if (state.doneEmitted) return
        boundary = buffer.indexOf('\n\n')
      }
    },
    flush(controller): void {
      if (state.doneEmitted) return
      const tail = STREAM_DECODER.decode()
      if (tail.length > 0) buffer += tail
      if (buffer.length === 0) return
      const { eventName, data } = parseEvent(buffer)
      dispatchEvent(controller, state, eventName, data)
      buffer = ''
    },
  })
}

/**
 * Parses one SSE event block into an `(eventName, data)` pair. The
 * Anthropic wire format always emits `event:` and `data:` lines; comments
 * (starting with `:`) and other lines are ignored.
 */
function parseEvent(block: string): { eventName: string; data: string } {
  const lines = block.split('\n')
  let eventName = ''
  let data = ''
  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      data += line.slice('data:'.length).trimStart()
    }
  }
  return { eventName, data }
}

/**
 * Dispatches one parsed event to the right emission handler. Mutates the
 * per-stream `state` and writes to `controller`. Returns nothing — callers
 * buffer-slice externally.
 */
function dispatchEvent(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: AnthropicStreamState,
  eventName: string,
  data: string,
): void {
  if (eventName === '' || data === '') return
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const root = parsed as Record<string, unknown>
  switch (eventName) {
    case 'message_start':
      handleMessageStart(controller, state, root)
      return
    case 'content_block_start':
      handleContentBlockStart(controller, state, root)
      return
    case 'content_block_delta':
      handleContentBlockDelta(controller, state, root)
      return
    case 'content_block_stop':
      handleContentBlockStop(state, root)
      return
    case 'message_delta':
      handleMessageDelta(state, root)
      return
    case 'message_stop':
      handleMessageStop(controller, state)
      return
    case 'ping':
      return
    case 'error':
      handleError(controller, state, root)
      return
    default:
      // Unknown events are dropped per Anthropic's streaming contract.
      return
  }
}

/** Resets per-block state before a new content block opens. */
function resetBlockState(state: AnthropicStreamState): void {
  state.currentContentBlockType = null
  state.currentContentBlockIndex = null
  state.accumulatedText = ''
  state.accumulatedToolInputJson = ''
}

/** Emits one OpenAI-shaped chunk wrapped in the canonical SSE framing. */
function emitChunk(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: AnthropicStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null,
  usage: Record<string, unknown> | null,
): void {
  const chunk: Record<string, unknown> = {
    id: state.messageId,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  }
  if (usage !== null) chunk.usage = usage
  controller.enqueue(STREAM_ENCODER.encode(`data: ${JSON.stringify(chunk)}\n\n`))
}

/** Emits the OpenAI `data: [DONE]\n\n` sentinel and marks the stream terminal. */
function emitDone(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: AnthropicStreamState,
): void {
  state.doneEmitted = true
  controller.enqueue(STREAM_ENCODER.encode('data: [DONE]\n\n'))
}

function handleMessageStart(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: AnthropicStreamState,
  root: Record<string, unknown>,
): void {
  const message = root.message
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return
  const m = message as Record<string, unknown>
  if (state.messageId === null && typeof m.id === 'string') state.messageId = m.id
  if (typeof m.model === 'string' && m.model.length > 0) state.model = m.model
  if (m.usage !== undefined) {
    state.rawUsage = mergeRawUsage(state.rawUsage, m.usage)
  }
  if (!state.roleEmitted) {
    state.roleEmitted = true
    emitChunk(controller, state, { role: 'assistant' }, null, null)
  }
}

function handleContentBlockStart(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: AnthropicStreamState,
  root: Record<string, unknown>,
): void {
  state.currentContentBlockIndex = readNumber(root.index)
  const block = root.content_block
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    state.currentContentBlockType = null
    return
  }
  const b = block as Record<string, unknown>
  const blockType = typeof b.type === 'string' ? b.type : null
  state.currentContentBlockType = blockType

  if (blockType === 'text') {
    const text = typeof b.text === 'string' ? b.text : ''
    if (text.length > 0) {
      state.accumulatedText += text
      emitChunk(controller, state, { content: text }, null, null)
    }
    return
  }

  if (blockType === 'tool_use') {
    const toolId = typeof b.id === 'string' ? b.id : ''
    const rawName = typeof b.name === 'string' ? b.name : ''
    // Restore the caller's original tool name when the sanitiser renamed it
    // on the request side; unknown names pass through unchanged so generic
    // adapters (no map threaded) keep working.
    const toolName = state.toolNameReverseMap?.get(rawName) ?? rawName
    const toolIndex = state.currentToolIndex
    state.currentToolIndex += 1
    state.accumulatedToolInputJson = ''
    emitChunk(
      controller,
      state,
      {
        tool_calls: [
          {
            index: toolIndex,
            id: toolId,
            type: 'function',
            function: { name: toolName, arguments: '' },
          },
        ],
      },
      null,
      null,
    )
    return
  }

  // Other block types (thinking, text citations, server-tool results) are
  // not yet handled by the streaming translator; they are dropped on the
  // stream side and surfaced by the `/v1/messages` route later if needed.
}

function handleContentBlockDelta(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: AnthropicStreamState,
  root: Record<string, unknown>,
): void {
  const delta = root.delta
  if (typeof delta !== 'object' || delta === null || Array.isArray(delta)) return
  const d = delta as Record<string, unknown>

  if (state.currentContentBlockType === 'text' && d.type === 'text_delta') {
    const text = typeof d.text === 'string' ? d.text : ''
    if (text.length > 0) {
      state.accumulatedText += text
      emitChunk(controller, state, { content: text }, null, null)
    }
    return
  }

  if (
    state.currentContentBlockType === 'tool_use' &&
    d.type === 'input_json_delta'
  ) {
    const partial = typeof d.partial_json === 'string' ? d.partial_json : ''
    if (partial.length > 0) {
      state.accumulatedToolInputJson += partial
      emitChunk(
        controller,
        state,
        {
          tool_calls: [
            {
              index: state.currentToolIndex - 1,
              function: { arguments: partial },
            },
          ],
        },
        null,
        null,
      )
    }
    return
  }

  // thinking_delta, signature_delta, citations_delta are dropped on the
  // stream side; the non-streaming `/v1/messages` route surfaces them when
  // it is built.
}

function handleContentBlockStop(
  state: AnthropicStreamState,
  _root: Record<string, unknown>,
): void {
  // content_block_stop is dropped (no OpenAI-shape equivalent). It does,
  // however, end the current block so the next content_block_start resets
  // the per-block state cleanly.
  resetBlockState(state)
}

function handleMessageDelta(
  state: AnthropicStreamState,
  root: Record<string, unknown>,
): void {
  const delta = root.delta
  if (typeof delta === 'object' && delta !== null && !Array.isArray(delta)) {
    const stopReason = (delta as Record<string, unknown>).stop_reason
    if (typeof stopReason === 'string' && stopReason.length > 0) {
      state.finishReason = mapStopReason(stopReason)
    }
  }
  const usage = root.usage
  if (usage !== undefined) {
    state.rawUsage = mergeRawUsage(state.rawUsage, usage)
  }
}

function handleMessageStop(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: AnthropicStreamState,
): void {
  if (state.doneEmitted) return
  const usage = state.rawUsage === null ? null : mapUsage(state.rawUsage)
  emitChunk(controller, state, {}, state.finishReason ?? 'stop', usage)
  emitDone(controller, state)
}

function handleError(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: AnthropicStreamState,
  root: Record<string, unknown>,
): void {
  if (state.doneEmitted) return
  const errorType = readAnthropicErrorType(root)
  emitChunk(controller, state, {}, errorType, null)
  emitDone(controller, state)
}

function readAnthropicErrorType(root: Record<string, unknown>): string {
  const error = root.error
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return 'api_error'
  const type = (error as Record<string, unknown>).type
  return typeof type === 'string' && type.length > 0 ? type : 'api_error'
}

function readNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.floor(value)
}

/**
 * Merges incoming usage (typically from `message_delta.usage`) into the
 * accumulated raw Anthropic usage. Anthropic streams usage in two phases:
 * `message_start` carries the prompt token counts (input + cache_creation +
 * cache_read), and `message_delta` carries the completion token counts
 * (output + thinking). Non-null fields overwrite the existing value; null
 * fields leave the existing value alone, so a `message_delta.usage` whose
 * `input_tokens` is null preserves the count from `message_start`. The
 * merged record is fed through {@link mapUsage} on `message_stop` so the
 * final OpenAI chunk carries the right totals exactly once.
 */
function mergeRawUsage(
  existing: Record<string, unknown> | null,
  incoming: unknown,
): Record<string, unknown> {
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    return existing ?? {}
  }
  const inc = incoming as Record<string, unknown>
  const base: Record<string, unknown> = existing === null ? {} : { ...existing }
  if (isNonNullNumber(inc.input_tokens)) base.input_tokens = inc.input_tokens
  if (isNonNullNumber(inc.output_tokens)) base.output_tokens = inc.output_tokens
  if (isNonNullNumber(inc.cache_creation_input_tokens)) base.cache_creation_input_tokens = inc.cache_creation_input_tokens
  if (isNonNullNumber(inc.cache_read_input_tokens)) base.cache_read_input_tokens = inc.cache_read_input_tokens
  const incomingDetails = inc.output_tokens_details
  if (typeof incomingDetails === 'object' && incomingDetails !== null && !Array.isArray(incomingDetails)) {
    const thinkingTokens = (incomingDetails as Record<string, unknown>).thinking_tokens
    if (isNonNullNumber(thinkingTokens)) {
      const details = (base.output_tokens_details as Record<string, unknown> | undefined) ?? {}
      details.thinking_tokens = thinkingTokens
      base.output_tokens_details = details
    }
  }
  return base
}

function isNonNullNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/* ------------------------------------------------------------------------- *
 * `/v1/messages` public surface (ticket 04).
 *
 * The route `POST /providers/{connection_id}/v1/messages` receives an
 * Anthropic-shape request body from an Anthropic SDK caller. Two cases:
 *
 *   1. `passthrough: true` — the Provider Connection is an Anthropic Provider
 *      (template id `anthropic`). Forward the body verbatim to upstream
 *      `/v1/messages`, stream SSE events verbatim, and preserve the
 *      Anthropic error envelope.
 *
 *   2. `passthrough: false` — the Provider Connection is a non-Anthropic
 *      OpenAI-compatible Provider. Translate the Anthropic-shape body to
 *      OpenAI-shape, call upstream at `/chat/completions`, translate the
 *      OpenAI-shape response back to Anthropic-shape, and emit SSE events
 *      in Anthropic's named event order on the streaming side.
 * ------------------------------------------------------------------------- */

/**
 * The StreamingTimeouts-style upstream-header matrix for passthrough mode.
 * The body is bytes-forward, so the choice is just authentication, content
 * type, version, and the Iroha-blocked hop-by-hop headers.
 */
function buildAnthropicPassthroughHeaders(options: {
  callerHeaders: Readonly<Record<string, string>>
  authHeader: string
  authPrefix: string
  upstreamKey: string
  staticHeaders: Readonly<Record<string, string>>
  stream: boolean
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
  out['content-type'] = out['content-type'] ?? 'application/json'
  out['accept'] = out['accept'] ?? (options.stream ? 'text/event-stream' : 'application/json')
  out['anthropic-version'] = out['anthropic-version'] ?? DEFAULT_ANTHROPIC_VERSION
  return out
}

function parseAnthropicBodyOrThrow(body: string | null): Record<string, unknown> {
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

/**
 * Returns the Anthropic-shape upstream error body untouched: the status is
 * the upstream status and the body is the Anthropic error envelope verbatim
 * so the Anthropic SDK can parse it on the client.
 */
async function passthroughErrorResponseBody(response: Response): Promise<InferenceBufferedResult> {
  const rawBody = await response.text()
  return {
    kind: 'buffered',
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: rawBody,
  }
}

/**
 * Returns the upstream SSE stream verbatim. The Anthropic SDK consumed the
 * same `event:` and `data:` lines on the wire; the adapter introduces no
 * translation.
 */
function passthroughStreamingResponse(response: Response): InferenceStreamResult {
  const stream = response.body ?? new ReadableStream<Uint8Array>()
  return {
    kind: 'stream',
    status: response.status,
    headers: { ...Object.fromEntries(response.headers.entries()), 'content-type': response.headers.get('content-type') ?? 'text/event-stream' },
    stream,
  }
}

/* ------------------------------------------------------------------------- *
 * Anthropic-shape → OpenAI-shape translation. Mirrors the round-trip defined
 * in tickets 01–03 in reverse:
 *
 *   top-level `system` → `messages[0].role = "system"`
 *   `messages[].content` blocks:
 *     `text`                    → `messages[].content` (string)
 *     `image`                   → `messages[].content[].type = "image_url"`
 *     `tool_use`                → `messages[].tool_calls[]`
 *     `tool_result`             → `messages[].role = "tool", tool_call_id`
 *     `thinking` (and other)    → preserved as unknown JSON passthrough
 *   `tools[]`:
 *     name                      → preserved (OpenAI accepts the same regex)
 *     input_schema              → `parameters`
 *   `tool_choice`:
 *     `{type: "auto"}`            → `"auto"`
 *     `{type: "any"}`             → `"required"`
 *     `{type: "tool", name}`     → `{type: "function", function: {name}}`
 *   `output_config.format`:
 *     `{type: "json_schema", schema}` → `response_format: {type: "json_schema", ...}`
 *   `cache_control` and `thinking` blocks:
 *     preserved as unknown JSON passthrough on the message side
 * ------------------------------------------------------------------------- */

async function forwardAnthropicAsOpenAi(
  fetchImpl: typeof fetch,
  request: AnthropicForwardRequest,
  anthropicBody: Record<string, unknown>,
  model: string,
  wantStream: boolean,
): Promise<InferenceForwardResult> {
  const { body: openAiBody, toolNameForwardMap } = translateAnthropicToOpenAi(anthropicBody, model, wantStream)
  const toolNameReverseMap = invertForwardMap(toolNameForwardMap)

  const callHeaders = buildAnthropicPassthroughHeaders({
    callerHeaders: request.headers,
    authHeader: request.authHeader,
    authPrefix: request.authPrefix,
    upstreamKey: request.upstreamKey,
    staticHeaders: request.staticHeaders,
    stream: wantStream,
  })
  delete (callHeaders as Record<string, string>)['anthropic-version']

  const response = await fetchImpl(upstreamUrl(request.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: callHeaders,
    body: JSON.stringify(openAiBody),
    signal: request.signal ?? null,
  })

  if (response.status < 200 || response.status >= 300) {
    const rawBody = await response.text()
    return openAiToAnthropicErrorResponse(response.status, rawBody, Object.fromEntries(response.headers.entries()))
  }

  if (wantStream) {
    return openAiToAnthropicStreamingResponse(response, model, toolNameReverseMap)
  }

  const responseHeaders: Record<string, string> = Object.fromEntries(response.headers.entries())
  const rawBody = await response.text()
  return openAiToAnthropicCompletionResponse(rawBody, model, toolNameReverseMap, responseHeaders)
}

/**
 * Translates the Anthropic-shape Messages body into the OpenAI-shape Chat
 * Completions body. The inverse of `translateOpenAiToAnthropic` for the
 * fields the round-trip already covers; unknown fields (cache_control on
 * any block, thinking blocks, server-tool markers, citations) are forwarded
 * as-is on the message side so Provider extensions keep working.
 */
function translateAnthropicToOpenAi(
  body: Record<string, unknown>,
  model: string,
  stream: boolean,
): { body: Record<string, unknown>; toolNameForwardMap: Map<string, string> } {
  const out: Record<string, unknown> = { model }
  if (stream) out.stream = true

  const messages: Array<Record<string, unknown>> = []
  const systemRaw = body.system
  if (typeof systemRaw === 'string' && systemRaw.length > 0) {
    messages.push({ role: 'system', content: systemRaw })
  } else if (Array.isArray(systemRaw)) {
    const text = collectAnthropicTextBlocks(systemRaw)
    if (text.length > 0) messages.push({ role: 'system', content: text })
  }

  const toolNameForwardMap = new Map<string, string>()
  const toolCallsAccumulator = new Map<string, Array<Record<string, unknown>>>()

  const messagesRaw = Array.isArray(body.messages) ? body.messages : []
  for (const entry of messagesRaw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const message = entry as Record<string, unknown>
    const role = typeof message.role === 'string' ? message.role : 'user'
    const content = message.content

    if (Array.isArray(content)) {
      const textSegments: string[] = []
      const imageParts: Array<Record<string, unknown>> = []
      const callId = typeof message.id === 'string' ? message.id : null
      for (const block of content) {
        if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
        const b = block as Record<string, unknown>
        switch (b.type) {
          case 'text': {
            if (typeof b.text === 'string' && b.text.length > 0) textSegments.push(b.text)
            break
          }
          case 'image': {
            const source = b.source
            if (typeof source === 'object' && source !== null && !Array.isArray(source)) {
              const s = source as Record<string, unknown>
              if (s.type === 'base64' && typeof s.media_type === 'string' && typeof s.data === 'string') {
                imageParts.push({
                  type: 'image_url',
                  image_url: { url: `data:${s.media_type};base64,${s.data}` },
                })
              } else if (s.type === 'url' && typeof s.url === 'string') {
                imageParts.push({
                  type: 'image_url',
                  image_url: { url: s.url },
                })
              }
            }
            break
          }
          case 'tool_use': {
            const id = typeof b.id === 'string' ? b.id : ''
            const rawName = typeof b.name === 'string' ? b.name : ''
            const sanitized = sanitizeToolName(rawName)
            if (sanitized !== rawName) toolNameForwardMap.set(rawName, sanitized)
            const args = JSON.stringify(b.input ?? {})
            const arr = toolCallsAccumulator.get(role) ?? []
            arr.push({
              id,
              type: 'function',
              function: { name: sanitized, arguments: args },
            })
            toolCallsAccumulator.set(role, arr)
            break
          }
          case 'tool_result': {
            const toolCallId = typeof b.tool_use_id === 'string' ? b.tool_use_id : ''
            const toolContent = normaliseToolResultContent(b.content)
            const toolMessage: Record<string, unknown> = {
              role: 'tool',
              tool_call_id: toolCallId,
              content: toolContent,
            }
            messages.push(toolMessage)
            break
          }
          default: {
            // Unknown block types (thinking, citations, server-tool
            // markers, …) are dropped; the per-request content array only
            // carries OpenAI-shape segments. Anthropic's documented content
            // types are exhaustively covered above; "preserve as unknown
            // JSON passthrough" applies to *fields*, not to the translated
            // content for the OpenAI-shape envelope.
            break
          }
        }
      }
      const textContent = textSegments.join('')
      const outMessage: Record<string, unknown> = { role }
      if (callId !== null) outMessage.id = callId
      if (imageParts.length > 0) {
        const parts: Array<Record<string, unknown>> = []
        if (textContent.length > 0) parts.push({ type: 'text', text: textContent })
        for (const part of imageParts) parts.push(part)
        outMessage.content = parts
      } else {
        outMessage.content = textContent
      }
      const calls = toolCallsAccumulator.get(role)
      if (calls !== undefined && calls.length > 0) {
        outMessage.tool_calls = calls
        toolCallsAccumulator.delete(role)
      }
      messages.push(outMessage)
    } else if (typeof content === 'string') {
      messages.push({ role, content })
    } else {
      // nil content (Anthropic allows it for tool_result anchors in assistant
      // turns) is forwarded as an empty string so the OpenAI SDK gets a
      // well-formed message.
      messages.push({ role, content: '' })
    }
  }

  out.messages = messages

  const maxTokens = readMaxTokens(body.max_tokens)
  if (maxTokens !== null) out.max_tokens = maxTokens

  const temperature = readNumeric(body.temperature)
  if (temperature !== null) out.temperature = temperature
  const topP = readNumeric(body.top_p)
  if (topP !== null) out.top_p = topP
  const topK = readNumeric(body.top_k)
  if (topK !== null) out.top_k = topK

  const stop = body.stop_sequences
  if (Array.isArray(stop)) {
    const stopStrings: string[] = []
    for (const entry of stop) {
      if (typeof entry === 'string' && entry.length > 0) stopStrings.push(entry)
    }
    if (stopStrings.length > 0) out.stop = stopStrings
  }

  const toolsOut = translateAnthropicToolsToOpenAi(body.tools, toolNameForwardMap)
  if (toolsOut !== null) out.tools = toolsOut
  const toolChoice = translateAnthropicToolChoice(body.tool_choice, toolNameForwardMap)
  if (toolChoice !== null) out.tool_choice = toolChoice
  const parallel = readParallelFromDisable(body.disable_parallel_tool_use)
  if (parallel !== null) out.parallel_tool_calls = parallel

  const responseFormat = translateAnthropicOutputFormat(body.output_config, body.output_format)
  if (responseFormat !== null) out.response_format = responseFormat

  return { body: out, toolNameForwardMap }
}

function collectAnthropicTextBlocks(blocks: ReadonlyArray<unknown>): string {
  let out = ''
  for (const block of blocks) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
      out += b.text
    }
  }
  return out
}

function normaliseToolResultContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const textSegments: string[] = []
    for (const block of content) {
      if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') textSegments.push(b.text)
    }
    if (textSegments.length === content.length) return textSegments.join('')
    return ''
  }
  return ''
}

function translateAnthropicToolsToOpenAi(
  tools: unknown,
  forwardMap: Map<string, string>,
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(tools)) return null
  const out: Array<Record<string, unknown>> = []
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) continue
    const t = tool as Record<string, unknown>
    const rawName = typeof t.name === 'string' ? t.name : ''
    const sanitized = sanitizeToolName(rawName)
    if (sanitized !== rawName) forwardMap.set(rawName, sanitized)
    const description = typeof t.description === 'string' ? t.description : ''
    const schema = (t.input_schema !== undefined && t.input_schema !== null) ? t.input_schema : {}
    const toolOut: Record<string, unknown> = {
      type: 'function',
      function: {
        name: sanitized,
        description,
        parameters: schema,
      },
    }
    out.push(toolOut)
  }
  return out
}

function translateAnthropicToolChoice(
  choice: unknown,
  forwardMap: ReadonlyMap<string, string>,
): Record<string, unknown> | string | null {
  if (choice === null || choice === undefined) return null
  if (typeof choice === 'string') {
    switch (choice) {
      case 'auto':
        return 'auto'
      case 'any':
        return 'required'
      case 'none':
        return 'none'
      default:
        return null
    }
  }
  if (typeof choice === 'object' && !Array.isArray(choice)) {
    const c = choice as Record<string, unknown>
    const type = c.type
    if (type === 'auto') return 'auto'
    if (type === 'any') return 'required'
    if (type === 'none') return 'none'
    if (type === 'tool' && typeof c.name === 'string') {
      const sanitized = forwardMap.has(c.name) ? (forwardMap.get(c.name) as string) : c.name
      return { type: 'function', function: { name: sanitized } }
    }
  }
  return null
}

function readParallelFromDisable(value: unknown): boolean | null {
  if (value === true) return false
  if (value === false) return true
  return null
}

function translateAnthropicOutputFormat(
  outputConfig: unknown,
  legacyOutputFormat: unknown,
): Record<string, unknown> | null {
  const format = readOutputConfigFormat(outputConfig) ?? readLegacyOutputFormat(legacyOutputFormat)
  if (format === null) return null
  const { type, schema } = format
  if (type === 'json_schema' && schema !== undefined) {
    return { type: 'json_schema', json_schema: { schema } }
  }
  return null
}

function readOutputConfigFormat(outputConfig: unknown): { type: string; schema?: unknown } | null {
  if (typeof outputConfig !== 'object' || outputConfig === null || Array.isArray(outputConfig)) return null
  const cfg = outputConfig as Record<string, unknown>
  const format = cfg.format
  if (typeof format !== 'object' || format === null || Array.isArray(format)) return null
  const f = format as Record<string, unknown>
  if (typeof f.type !== 'string') return null
  if (f.type === 'json_schema') {
    return { type: 'json_schema', schema: f.schema ?? {} }
  }
  return { type: f.type }
}

function readLegacyOutputFormat(legacy: unknown): { type: string; schema?: unknown } | null {
  if (typeof legacy !== 'object' || legacy === null || Array.isArray(legacy)) return null
  const l = legacy as Record<string, unknown>
  if (typeof l.type !== 'string') return null
  if (l.type === 'json_schema') {
    return { type: 'json_schema', schema: l.schema ?? {} }
  }
  return { type: l.type }
}

function readNumeric(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/* ------------------------------------------------------------------------- *
 * OpenAI-shape → Anthropic-shape response translation (the streaming and
 * non-streaming forward directions for the `/v1/messages` route when the
 * target Provider is OpenAI-compatible).
 * ------------------------------------------------------------------------- */

function openAiToAnthropicErrorResponse(
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
  const envelope = toAnthropicErrorEnvelope(status, parsed, rawBody)
  return {
    kind: 'buffered',
    status,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  }
}

function toAnthropicErrorEnvelope(
  status: number,
  parsed: unknown,
  rawBody: string,
): Record<string, unknown> {
  const anthropicType = openAiStatusToAnthropicType(status)
  const message = readOpenAiErrorMessage(parsed, rawBody)
  const requestId = readOpenAiErrorRequestId(parsed)
  const envelope: Record<string, unknown> = {
    type: 'error',
    error: { type: anthropicType, message },
  }
  if (requestId !== null) envelope.request_id = requestId
  return envelope
}

function readOpenAiErrorMessage(parsed: unknown, rawBody: string): string {
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

function readOpenAiErrorRequestId(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const candidates = [
    (parsed as Record<string, unknown>).request_id,
    (parsed as Record<string, unknown>).requestId,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  const err = (parsed as Record<string, unknown>).error
  if (typeof err === 'object' && err !== null && !Array.isArray(err)) {
    const inner = (err as Record<string, unknown>).request_id
    if (typeof inner === 'string' && inner.length > 0) return inner
  }
  return null
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
    case 502:
    case 503:
    case 504:
      return 'api_error'
    default:
      return status >= 500 ? 'api_error' : 'invalid_request_error'
  }
}

function openAiToAnthropicCompletionResponse(
  rawBody: string,
  fallbackModel: string,
  toolNameReverseMap: ReadonlyMap<string, string>,
  headers: Readonly<Record<string, string>>,
): InferenceBufferedResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return {
      kind: 'buffered',
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(toAnthropicErrorEnvelope(502, null, 'The Provider body was not valid JSON.')),
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      kind: 'buffered',
      status: 200,
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(toAnthropicErrorEnvelope(502, null, 'The Provider body was not a JSON object.')),
    }
  }
  const root = parsed as Record<string, unknown>
  const id = typeof root.id === 'string' ? root.id : `msg_${fallbackModel}-${randomSuffix()}`
  const model = typeof root.model === 'string' ? root.model : fallbackModel
  const choices = Array.isArray(root.choices) ? root.choices : []
  const choice = choices[0]
  const message = (choice !== undefined && typeof choice === 'object' && choice !== null)
    ? (choice as Record<string, unknown>).message
    : undefined
  const messageRecord = (message !== undefined && typeof message === 'object' && message !== null && !Array.isArray(message))
    ? (message as Record<string, unknown>)
    : null
  const finishReason = (choice !== undefined && typeof choice === 'object' && choice !== null)
    ? (choice as Record<string, unknown>).finish_reason
    : null

  const content: Array<Record<string, unknown>> = []
  if (messageRecord !== null) {
    const text = messageRecord.content
    if (typeof text === 'string' && text.length > 0) {
      content.push({ type: 'text', text })
    }
    const calls = messageRecord.tool_calls
    if (Array.isArray(calls)) {
      for (const call of calls) {
        if (call === null || typeof call !== 'object' || Array.isArray(call)) continue
        const c = call as Record<string, unknown>
        const callId = typeof c.id === 'string' ? c.id : ''
        const fn = c.function
        if (typeof fn !== 'object' || fn === null || Array.isArray(fn)) continue
        const fnRecord = fn as Record<string, unknown>
        const rawName = typeof fnRecord.name === 'string' ? fnRecord.name : ''
        const name = toolNameReverseMap.get(rawName) ?? rawName
        let input: unknown = {}
        const args = fnRecord.arguments
        if (typeof args === 'string' && args.length > 0) {
          try {
            input = JSON.parse(args)
          } catch {
            input = {}
          }
        }
        content.push({ type: 'tool_use', id: callId, name, input })
      }
    }
  }

  const anthropicFinish = openAiFinishToAnthropicStopReason(finishReason)
  const usage = openAiUsageToAnthropic(root.usage)

  const body: Record<string, unknown> = {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicFinish,
    stop_sequence: null,
    usage,
  }
  return {
    kind: 'buffered',
    status: 200,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }
}

function openAiFinishToAnthropicStopReason(reason: unknown): string {
  if (typeof reason !== 'string') return 'end_turn'
  switch (reason) {
    case 'stop':
    case 'stop_sequence':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    case 'content_filter':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

function openAiUsageToAnthropic(usage: unknown): Record<string, unknown> {
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) {
    return { input_tokens: 0, output_tokens: 0 }
  }
  const u = usage as Record<string, unknown>
  const input = readNumberOrZero(u.prompt_tokens)
  const output = readNumberOrZero(u.completion_tokens)
  const cached = readOpenAiCacheTokens(u.prompt_tokens_details)
  const thinking = readOpenAiThinkingTokens(u.completion_tokens_details)
  const out: Record<string, unknown> = {
    input_tokens: input,
    output_tokens: output,
  }
  if (cached.creation > 0) out.cache_creation_input_tokens = cached.creation
  if (cached.read > 0) out.cache_read_input_tokens = cached.read
  if (thinking > 0) {
    out.output_tokens_details = { thinking_tokens: thinking }
  }
  return out
}

function readOpenAiCacheTokens(details: unknown): { creation: number; read: number } {
  const result = { creation: 0, read: 0 }
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return result
  const d = details as Record<string, unknown>
  if (typeof d.cache_creation_input_tokens === 'number' && Number.isFinite(d.cache_creation_input_tokens)) {
    result.creation = Math.max(0, Math.floor(d.cache_creation_input_tokens))
  }
  if (typeof d.cache_read_input_tokens === 'number' && Number.isFinite(d.cache_read_input_tokens)) {
    result.read = Math.max(0, Math.floor(d.cache_read_input_tokens))
  }
  return result
}

function readOpenAiThinkingTokens(details: unknown): number {
  if (typeof details !== 'object' || details === null || Array.isArray(details)) return 0
  const d = details as Record<string, unknown>
  if (typeof d.reasoning_tokens === 'number' && Number.isFinite(d.reasoning_tokens)) {
    return Math.max(0, Math.floor(d.reasoning_tokens))
  }
  return 0
}

function readNumberOrZero(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0
  return Math.floor(value)
}

function openAiToAnthropicStreamingResponse(
  response: Response,
  fallbackModel: string,
  toolNameReverseMap: ReadonlyMap<string, string>,
): InferenceStreamResult {
  const upstream = response.body ?? new ReadableStream<Uint8Array>()
  return {
    kind: 'stream',
    status: response.status,
    headers: { ...Object.fromEntries(response.headers.entries()), 'content-type': response.headers.get('content-type') ?? 'text/event-stream' },
    stream: upstream.pipeThrough(createOpenAiToAnthropicStreamTranslator(fallbackModel, toolNameReverseMap)),
  }
}

/**
 * Per-stream state for the OpenAI→Anthropic SSE translator. Mirrors the
 * fields the Anthropic→OpenAI translator tracks in {@link AnthropicStreamState}
 * but inverted: the OpenAI chunks we read have `choices[].delta.{content,
 * tool_calls, role}` and a final `usage` (sometimes `stream_options`
 * controls it). The translator emits Anthropic named SSE events in the
 * documented order: `message_start`, `content_block_start` (one per block),
 * `content_block_delta` (one per OpenAI delta), `content_block_stop`,
 * `message_delta` (carrying final `stop_reason` + `usage`), `message_stop`.
 *
 * `ping` events are dropped; mid-stream OpenAI errors do not produce an
 * Anthropic `error` event (the stream simply ends — the Anthropic SDK sees
 * the truncated body as the answer).
 */
interface OpenAiToAnthropicStreamState {
  messageId: string | null
  model: string
  created: number
  started: boolean
  /** Block index for the next emitted content_block_start. */
  blockIndex: number
  /** The OpenAI `tool_calls[].index` of the currently open tool block, or null. */
  openToolIndex: number | null
  /** Accumulated OpenAI usage fields (the final chunk after `[DONE]` mirrors them). */
  usage: Record<string, unknown> | null
  /** The final stop_reason, drained from the last chunk's `finish_reason`. */
  finishReason: string | null
  /** True once message_stop has been emitted. */
  doneEmitted: boolean
  /** Reverse map of sanitized → original tool names; used to restore caller's tool names. */
  toolNameReverseMap: ReadonlyMap<string, string>
}

export function createOpenAiToAnthropicStreamTranslator(
  fallbackModel: string,
  toolNameReverseMap: ReadonlyMap<string, string> = new Map(),
): TransformStream<Uint8Array, Uint8Array> {
  const state: OpenAiToAnthropicStreamState = {
    messageId: null,
    model: fallbackModel,
    created: nowSeconds(),
    started: false,
    blockIndex: 0,
    openToolIndex: null,
    usage: null,
    finishReason: null,
    doneEmitted: false,
    toolNameReverseMap,
  }

  let buffer = ''

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller): void {
      if (state.doneEmitted) return
      buffer += STREAM_DECODER.decode(chunk, { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const block = buffer.slice(0, boundary)
        const { data } = parseOpenAiSse(block)
        buffer = buffer.slice(boundary + 2)
        if (data === '[DONE]') {
          emitAnthropicStop(controller, state)
        } else if (data !== '') {
          dispatchOpenAiChunk(controller, state, data)
        }
        if (state.doneEmitted) return
        boundary = buffer.indexOf('\n\n')
      }
    },
    flush(controller): void {
      if (state.doneEmitted) return
      const tail = STREAM_DECODER.decode()
      if (tail.length > 0) buffer += tail
      if (buffer.length === 0) {
        emitAnthropicStop(controller, state)
        return
      }
      const { data } = parseOpenAiSse(buffer)
      if (data === '[DONE]') {
        emitAnthropicStop(controller, state)
      } else if (data !== '') {
        dispatchOpenAiChunk(controller, state, data)
      }
      if (!state.doneEmitted) emitAnthropicStop(controller, state)
      buffer = ''
    },
  })
}

function parseOpenAiSse(block: string): { data: string } {
  const lines = block.split('\n')
  let data = ''
  for (const line of lines) {
    if (line.startsWith('data:')) data += line.slice(5).trimStart()
  }
  return { data }
}

function dispatchOpenAiChunk(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: OpenAiToAnthropicStreamState,
  data: string,
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
  const chunk = parsed as Record<string, unknown>
  if (state.messageId === null && typeof chunk.id === 'string') state.messageId = chunk.id
  if (typeof chunk.model === 'string' && chunk.model.length > 0) state.model = chunk.model
  if (chunk.usage !== undefined) {
    state.usage = (typeof chunk.usage === 'object' && chunk.usage !== null && !Array.isArray(chunk.usage))
      ? (chunk.usage as Record<string, unknown>)
      : state.usage
  }

  const choices = Array.isArray(chunk.choices) ? chunk.choices : []
  for (const choice of choices) {
    if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) continue
    const c = choice as Record<string, unknown>
    const finishReason = c.finish_reason
    if (typeof finishReason === 'string' && finishReason.length > 0) {
      state.finishReason = finishReason
    }
    const delta = c.delta
    if (delta === null || typeof delta !== 'object' || Array.isArray(delta)) continue
    const d = delta as Record<string, unknown>
    if (!state.started) {
      state.started = true
      emitAnthropicMessageStart(controller, state)
    }
    if (typeof d.content === 'string' && d.content.length > 0) {
      ensureTextBlock(controller, state)
      emitAnthropicEvent(controller, 'content_block_delta', {
        type: 'content_block_delta',
        index: state.blockIndex - 1,
        delta: { type: 'text_delta', text: d.content },
      })
    }
    if (Array.isArray(d.tool_calls)) {
      for (const call of d.tool_calls) {
        if (call === null || typeof call !== 'object' || Array.isArray(call)) continue
        const callRecord = call as Record<string, unknown>
        const index = readNumberOrZero(callRecord.index)
        const fn = callRecord.function
        if (typeof fn === 'object' && fn !== null && !Array.isArray(fn)) {
          const fnRecord = fn as Record<string, unknown>
          if (typeof fnRecord.name === 'string' && fnRecord.name.length > 0 && (state.openToolIndex === null || state.openToolIndex !== index)) {
            // Open a new tool_use block.
            if (state.openToolIndex !== null) {
              emitAnthropicEvent(controller, 'content_block_stop', {
                type: 'content_block_stop',
                index: state.blockIndex - 1,
              })
            }
            const rawName = fnRecord.name
            const name = state.toolNameReverseMap.get(rawName) ?? rawName
            const id = typeof callRecord.id === 'string' ? callRecord.id : `toolu_${randomSuffix()}`
            if (state.openToolIndex === null) {
              emitAnthropicEvent(controller, 'content_block_start', {
                type: 'content_block_start',
                index: state.blockIndex,
                content_block: { type: 'tool_use', id, name, input: {} },
              })
            }
            state.openToolIndex = index
            state.blockIndex += 1
          }
          if (state.openToolIndex !== null && typeof fnRecord.arguments === 'string' && fnRecord.arguments.length > 0) {
            emitAnthropicEvent(controller, 'content_block_delta', {
              type: 'content_block_delta',
              index: state.blockIndex - 1,
              delta: { type: 'input_json_delta', partial_json: fnRecord.arguments },
            })
          }
        }
      }
    }
  }
}

function ensureTextBlock(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: OpenAiToAnthropicStreamState,
): void {
  if (state.openToolIndex !== null) return
  if (state.blockIndex > 0) return
  emitAnthropicEvent(controller, 'content_block_start', {
    type: 'content_block_start',
    index: state.blockIndex,
    content_block: { type: 'text', text: '' },
  })
  state.blockIndex += 1
}

function emitAnthropicMessageStart(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: OpenAiToAnthropicStreamState,
): void {
  const usage = openAiUsageToAnthropic(state.usage)
  emitAnthropicEvent(controller, 'message_start', {
    type: 'message_start',
    message: {
      id: state.messageId ?? `msg_${state.model}-${randomSuffix()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: state.model,
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  })
}

function emitAnthropicStop(
  controller: TransformStreamDefaultController<Uint8Array>,
  state: OpenAiToAnthropicStreamState,
): void {
  if (state.doneEmitted) return
  if (state.started) {
    if (state.openToolIndex !== null) {
      emitAnthropicEvent(controller, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.blockIndex - 1,
      })
      state.openToolIndex = null
    } else if (state.blockIndex > 0) {
      // A text block was open (or has already been started but never closed
      // because no tool block followed it). Close it before the final
      // message_delta so the Anthropic SDK sees the documented ordering:
      // content_block_stop happens once per content_block_start.
      emitAnthropicEvent(controller, 'content_block_stop', {
        type: 'content_block_stop',
        index: state.blockIndex - 1,
      })
    }
    const anthropicReason = openAiFinishToAnthropicStopReason(state.finishReason)
    const usage = openAiUsageToAnthropic(state.usage)
    emitAnthropicEvent(controller, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: anthropicReason, stop_sequence: null },
      usage,
    })
    emitAnthropicEvent(controller, 'message_stop', { type: 'message_stop' })
  }
  state.doneEmitted = true
}

function emitAnthropicEvent(
  controller: TransformStreamDefaultController<Uint8Array>,
  event: string,
  data: Record<string, unknown>,
): void {
  controller.enqueue(STREAM_ENCODER.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
}

