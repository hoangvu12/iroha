# Anthropic provider support in OpenAI-compatible inference gateways

A working blueprint of the actual transformations used by production
gateways, sourced from the current `main` branches of the upstream
repositories and the public documentation. Every section below cites
file paths with line numbers (or doc URLs) so the claims are
reproducible, not paraphrased.

The five gateways studied:

| Gateway  | Language | Repo                                                        | Docs                                                   |
|----------|----------|-------------------------------------------------------------|--------------------------------------------------------|
| LiteLLM  | Python   | `BerriAI/litellm`                                           | `docs.litellm.ai`                                      |
| Portkey  | TypeScript | `Portkey-AI/gateway`                                       | `portkey.ai/docs/integrations/llms/anthropic`          |
| Bifrost  | Go       | `maximhq/bifrost`                                           | `docs.getbifrost.ai`                                   |
| OpenRouter | n/a (hosted) | n/a (proprietary)                                       | `openrouter.ai/docs`, `openrouter.ai/anthropic`        |
| Cloudflare | n/a (hosted) | n/a (proprietary)                                       | `developers.cloudflare.com/ai-gateway/providers/anthropic` |

OpenRouter and Cloudflare are reviewed from primary docs only
(no public source). The other three are reviewed from their current
`main`-branch source.

---

## TL;DR — the canonical pattern

Every gateway that exposes an OpenAI-compatible `/v1/chat/completions`
on top of Anthropic does, at minimum:

1. **Hoist `system` out of `messages[]` into the top-level `system` field.**
   Anthropic has no `role: "system"` message; it has a top-level
   `system` parameter. The OpenAI client puts `system` first, so the
   gateway has to lift it.
2. **Default `max_tokens`.** Anthropic 400s when `max_tokens` is
   missing; OpenAI never sends it. LiteLLM defaults to per-model
   `get_max_tokens(model)` falling back to a constant
   (`DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS`). Portkey makes the field
   `required` and propagates the caller's value through. Bifrost does
   neither and relies on the client.
3. **Map `tool_choice`** between OpenAI's `auto` / `required` / `none` /
   `{type: "function", function: {name}}` and Anthropic's `auto` /
   `any` / `none` / `{type: "tool", name}`.
4. **Translate Anthropic SSE → OpenAI chunk shape** by mapping
   `message_start` → role chunk, `content_block_delta` →
   `{choices: [{delta: {content}}]}` or `delta.tool_calls`,
   `message_delta.delta.stop_reason` → `finish_reason` on the
   final chunk, and accumulating `usage` from
   `message.message.usage` + `message_delta.usage`.
5. **Translate non-streaming usage**: `input_tokens` →
   `prompt_tokens`, `output_tokens` → `completion_tokens`,
   `cache_creation_input_tokens` / `cache_read_input_tokens` →
   `prompt_tokens_details.cached_tokens` (or
   `cache_creation_tokens`) and OpenAI-shape top-level mirrors.
6. **Inject `anthropic-version: 2023-06-01`** (OpenAI clients don't
   send it; Anthropic requires it). All three gateways hardcode
   this date string as a default and let it be overridden.
7. **Inject `x-api-key`** as the credential, with a fallback to
   `Authorization: Bearer …` for OAuth tokens, custom bases, or the
   `ANTHROPIC_AUTH_TOKEN` env var.

The least-common-multiple gateway is a host that exposes a real
`POST /v1/messages` passthrough (so Anthropic-native SDKs work
unchanged) plus an OpenAI-compatible `POST /v1/chat/completions` that
does the reverse transform. Both LiteLLM and Portkey do this; Bifrost
and Cloudflare only do the OpenAI-compatible side, and Cloudflare also
does an Anthropic-compatible passthrough at the URL prefix
`/anthropic/`.

---

## A. Provider-as-target (OpenAI client → Anthropic upstream)

### A.1 LiteLLM

**File**: `litellm/llms/anthropic/chat/transformation.py` on `main`.

#### Headers

LiteLLM's header constructor lives in
`AnthropicModelInfo.get_anthropic_headers` on
`litellm/llms/anthropic/common_utils.py:307-403`. The unconditional
shape:

```python
headers = {
    "anthropic-version": anthropic_version or "2023-06-01",
    "accept": "application/json",
    "content-type": "application/json",
}
```

`anthropic-version` default is hardcoded to `"2023-06-01"` and only
overridden if the caller explicitly passes `anthropic_version=`. See
`litellm/llms/anthropic/common_utils.py:368` (`headers["anthropic-version"] = anthropic_version or "2023-06-01"`).

The auth header is decided by `AnthropicModelInfo._make_api_key_auth_header`
at `litellm/llms/anthropic/common_utils.py:289-297`:

```python
if use_bearer_for_custom_base and (
    api_base and "api.anthropic.com" not in api_base
    and not api_key.startswith("sk-ant-")
):
    value = api_key if api_key.startswith("Bearer ") else f"Bearer {api_key}"
    return {"authorization": value}
return {"x-api-key": api_key}
```

So `x-api-key` is the default, with three fallbacks that flip to
`Authorization: Bearer …`:

1. `use_bearer_for_custom_base` litellm param is set and the base URL
   is not `api.anthropic.com`.
2. The key is an OAuth token (`sk-ant-oat*` prefix). Detection happens
   in `optionally_handle_anthropic_oauth` at
   `litellm/llms/anthropic/common_utils.py:69-97`.
3. `ANTHROPIC_AUTH_TOKEN` is set in the environment, not
   `ANTHROPIC_API_KEY` (see `get_auth_token` at
   `litellm/llms/anthropic/common_utils.py:519-526`).

The OAuth path **also** sets
`anthropic-dangerous-direct-browser-access: true` plus the OAuth beta
header (`oauth-2025-04-20`). See
`litellm/llms/anthropic/common_utils.py:85-95`.

`anthropic-beta` is a comma-joined set, conditionally built by
`get_anthropic_beta_list` at `litellm/llms/anthropic/common_utils.py:243-275`.
Conditional values include `computer-use-2025-01-24` /
`computer-use-2024-10-22`, `files-api-2025-04-14`,
`code-execution-2025-05-22`, `mcp-client-2025-04-04`,
`code-execution-2025-08-25`, `skills-2025-10-02`, `effort-2025-11-24`,
and the tool-search/programmatic-tool-calling beta
(`advanced-tool-use-2025-11-20`). Anthropic no longer requires
the prompt-caching beta; LiteLLM explicitly notes this in the comment
at `litellm/llms/anthropic/common_utils.py:288-289`.

#### System prompt extraction

`AnthropicConfig.translate_system_message` at
`litellm/llms/anthropic/chat/transformation.py:1607-1661`:

1. Walks `messages` and collects every message where
   `message["role"] == "system"`.
2. For each, if `content` is a string, wraps it as one
   `{"type": "text", "text": "..."}`. If it's a list, iterates the
   blocks and copies them verbatim into
   `list[AnthropicSystemMessageContent]`.
3. Skips empty text blocks (Anthropic rejects them with
   `"text content blocks must be non-empty"`).
4. Optionally strips `x-anthropic-billing-header:` blocks (off by
   default; Bedrock overrides to True via
   `should_strip_billing_metadata` at
   `litellm/llms/anthropic/chat/transformation.py:1598-1605`).
5. Pops the system messages out of `messages` in reverse so the
   remaining list stays contiguous.

`transform_request` then moves the list to
`optional_params["system"]` at
`litellm/llms/anthropic/chat/transformation.py:1857-1860`:

```python
anthropic_system_message_list = self.translate_system_message(messages=messages)
if len(anthropic_system_message_list) > 0:
    optional_params["system"] = anthropic_system_message_list
```

The remaining `messages` list is then handed to
`anthropic_messages_pt` for OpenAI→Anthropic shape conversion
(`litellm/llms/anthropic/chat/transformation.py:1863`).

#### max_tokens default

`AnthropicConfig.get_config` at
`litellm/llms/anthropic/chat/transformation.py:269-274` falls back to
per-model `get_max_tokens(model)`, which itself falls back to the
module-level constant `DEFAULT_ANTHROPIC_CHAT_MAX_TOKENS`:

```python
# anthropic requires a default value for max_tokens
if config.get("max_tokens") is None:
    config["max_tokens"] = cls.get_max_tokens_for_model(model)
```

User docs warn about this in
`docs.litellm.ai/docs/providers/anthropic` (paragraph under
"SNotes", verbatim): *"Anthropic API fails requests when max_tokens
are not passed. Due to this litellm passes max_tokens=4096 when no
max_tokens are passed."* 4096 is the bundled fallback when no
per-model map entry exists.

#### tool_choice mapping

`AnthropicConfig._map_tool_choice` at
`litellm/llms/anthropic/chat/transformation.py:615-654`:

| OpenAI                                         | Anthropic                                                                     |
|------------------------------------------------|-------------------------------------------------------------------------------|
| `"auto"`                                       | `{"type": "auto"}`                                                            |
| `"required"`                                   | `{"type": "any"}`                                                             |
| `"none"`                                       | `{"type": "none"}`                                                             |
| `{"type": "tool", "function": {"name": ...}}` | `{"type": "tool", "name": ...}`                                                |
| `{"type": "auto"}`                             | `{"type": "auto"}`                                                            |
| `{"type": "required"}` / `{"type": "any"}`     | `{"type": "any"}`                                                             |
| `{"type": "none"}`                             | `{"type": "none"}`                                                             |

`parallel_tool_calls: true` maps to
`disable_parallel_tool_use: !parallel_tool_use`, the inversion noted in
the comment at
`litellm/llms/anthropic/chat/transformation.py:643-650`:

```python
# Anthropic uses 'disable_parallel_tool_use' flag to determine if parallel tool use is allowed
# this is the inverse of the openai flag.
```

#### tool_use_id ↔ tool_call_id reconciliation

LiteLLM uses the Anthropic `id` directly as the OpenAI
`tool_call.id` and rewrites nothing on the request side. The two
identifiers happen to share a character set (Anthropic requires
`^[a-zA-Z0-9_-]+$` for `id` and `tool_use_id`, OpenAI is permissive
but lowercases). On the request side, LiteLLM *sanitizes* tool *names*
not tool *ids*, in
`_sanitize_tool_names_in_request` at
`litellm/llms/anthropic/chat/transformation.py:1014-1074`, and runs a
per-request forward/reverse map (via
`ANTHROPIC_TOOL_NAME_REVERSE_MAP_KEY` plumbed through `litellm_params`
into the streaming iterator) so a sanitized name back on the wire
resolves to the caller's original name on the response side.

`tool_use_id` ↔ `tool_call_id` is identity (no transform); the Sanitize
filter at
`litellm/llms/anthropic/common_utils.py:868-906`
(`sanitize_tool_use_ids_in_anthropic_messages`) is only applied when
replaying history that originated on a non-Anthropic provider (whose
ids may carry `.`/`:` characters).

#### Streaming SSE → OpenAI chunks

`ModelResponseIterator.chunk_parser` at
`litellm/llms/anthropic/chat/handler.py:410-606` does the translation.
Per `type_chunk`:

| Anthropic event                              | LiteLLM output |
|----------------------------------------------|----------------|
| `message_start`                              | First chunk with `choices[0].delta.role='assistant'`. `usage` is computed from `message.usage` (input_tokens + cache_*). |
| `content_block_start` (`type:text`)          | `delta.content = content_block.text`. |
| `content_block_start` (`type:tool_use`)      | `delta.tool_calls[i] = {id, type:'function', function:{name, arguments:''}, index: i}`. The id is the upstream `tool_use.id`; the tool name is reverse-mapped from the per-request forward map when present. |
| `content_block_start` (`type:server_tool_use`) | Same as `tool_use` but also primes the server-tool accumulator for `code_interpreter_results`. |
| `content_block_start` (`type:redacted_thinking`) | `provider_specific_fields.thinking_blocks = [{type: "redacted_thinking", data: ...}]`. |
| `content_block_delta` (`text_delta`)         | `delta.content = delta.text`. |
| `content_block_delta` (`input_json_delta`)   | `delta.tool_calls[i].function.arguments += delta.partial_json` (only when `current_content_block_type in ("tool_use", "server_tool_use")`; web_search and other result blocks are filtered to avoid emitting fake tool calls — see issue 17254 noted at `litellm/llms/anthropic/chat/handler.py:511-521`). |
| `content_block_delta` (`thinking_delta`)     | `delta.reasoning_content = delta.thinking`, `thinking_blocks` updated. |
| `content_block_delta` (`signature`)          | Finalises `thinking_blocks` with the cumulative signature. |
| `content_block_stop`                         | Closes the open tool call. Emits an empty-args tool call (`{}`) when the assistant produced a tool_use with no input — see `check_empty_tool_call_args` at `litellm/llms/anthropic/chat/handler.py:317-336`. |
| `message_delta`                              | Final chunk. `finish_reason = map_finish_reason(delta.stop_reason)`. `usage` is computed from `delta.usage`. |
| `error`                                      | Raises `AnthropicError`. |

Usage timing: Anthropic streams usage twice — `input_tokens` +
`cache_*_input_tokens` arrive in `message.message.usage` on
`message_start`; `output_tokens` + server tool counts arrive in
`message_delta.usage`. LiteLLM accumulates both into the final chunk's
`usage`. The actual SSE event is fed through
`AnthropicConfig.calculate_usage` at
`litellm/llms/anthropic/chat/transformation.py:2120-2230`, which:
- adds `cache_creation_input_tokens` and `cache_read_input_tokens`
  back into `prompt_tokens` (Anthropic only includes them in the raw
  `input_tokens` if there are zero uncached prompt tokens; see the
  comment at `litellm/llms/anthropic/chat/transformation.py:2107-2117`),
- pops them back out into `prompt_tokens_details.cached_tokens` and
  `prompt_tokens_details.cache_creation_tokens`,
- carries `server_tool_use.web_search_requests` /
  `tool_search_requests` through `ServerToolUse(...)`,
- splits `completion_tokens` into `reasoning_tokens` (estimated from
  the streamed `reasoning_content`) plus `text_tokens`.

#### Stop reason mapping

`map_finish_reason` at
`litellm/litellm_core_utils/core_helpers.py:99-141` returns the
OpenAI-shaped string for an Anthropic stop reason:

| Anthropic stop_reason | OpenAI `finish_reason` |
|-----------------------|------------------------|
| `stop_sequence`       | `stop`                 |
| `end_turn`            | `stop`                 |
| `max_tokens`          | `length`               |
| `tool_use`            | `tool_calls`           |
| `refusal`             | `content_filter`       |
| `compaction`          | `length`               |
| `content_filtered`    | `content_filter`       |

Unhandled values default to `stop` with a verbose_logger warning
(`litellm/litellm_core_utils/core_helpers.py:143-148`).

#### Error envelope mapping

Non-streaming: `AnthropicConfig.transform_response` raises a plain
`AnthropicError` (inheriting `BaseLLMException`) on non-200
`httpx.HTTPStatusError`. The handler at
`litellm/llms/anthropic/chat/handler.py:170-185` and
`litellm/llms/anthropic/chat/handler.py:106-119` catches and re-raises
so the proxy maps it to OpenAI's
`{"error": {"message", "type", "param", "code"}}` envelope (LiteLLM
core does the OpenAI shape).

Streaming: `ModelResponseIterator.chunk_parser` (`type_chunk ==
"error"` at `litellm/llms/anthropic/chat/handler.py:529-535`) raises
`AnthropicError(message=…, status_code=500)` because the streaming
error chunk doesn't carry an HTTP status.

The reverse direction — wrapping OpenAI-shaped exceptions into
Anthropic-shape for the Anthropic passthrough surface — lives at
`litellm/anthropic_interface/exceptions/exception_mapping_utils.py:27-36`
via `ANTHROPIC_ERROR_TYPE_MAP`:

```python
ANTHROPIC_ERROR_TYPE_MAP: Final[dict[int, AnthropicErrorType]] = {
    400: "invalid_request_error",
    401: "authentication_error",
    403: "permission_error",
    404: "not_found_error",
    413: "request_too_large",
    429: "rate_limit_error",
    500: "api_error",
    529: "overloaded_error",
}
```

#### Rate-limit / response headers

`process_anthropic_headers` at
`litellm/llms/anthropic/common_utils.py:1049-1063` maps
`anthropic-ratelimit-requests-limit` → `x-ratelimit-limit-requests`,
`anthropic-ratelimit-requests-remaining` →
`x-ratelimit-remaining-requests`, and the same for
`anthropic-ratelimit-tokens-*`. All other headers are wrapped as
`llm_provider-<key>` so they round-trip to the caller.

### A.2 Portkey

**Files**: `src/providers/anthropic/*.ts` on `main`. Source confirmed
via raw GitHub fetches:
- `src/providers/anthropic/index.ts`
- `src/providers/anthropic/chatComplete.ts`
- `src/providers/anthropic/api.ts`
- `src/providers/anthropic/types.ts`
- `src/providers/anthropic/utils.ts`
- `src/providers/utils.ts`
- `src/providers/utils/finishReasonMap.ts`
- `src/providers/anthropic-base/messages.ts`

#### Headers

`src/providers/anthropic/api.ts:11-39` shows the header builder:

```ts
const headers: Record<string, string> = {
  'X-API-Key': apiKey,
};

const betaHeader =
  providerOptions?.['anthropicBeta'] ??
  gatewayRequestBody?.['anthropic_beta'] ??
  'messages-2023-12-15';
const version =
  providerOptions?.['anthropicVersion'] ??
  gatewayRequestBody?.['anthropic_version'] ??
  '2023-06-01';

headers['anthropic-beta'] = betaHeader;
headers['anthropic-version'] = version;
```

So Portkey's defaults are `anthropic-version: "2023-06-01"` and
`anthropic-beta: "messages-2023-12-15"` (this is the legacy beta that
unlocks the messages API features). Both overridable through the SDK
or per-request body. `x-api-key` is hardcoded; there is no separate
`Authorization` path.

#### System prompt extraction

`src/providers/anthropic/chatComplete.ts:284-316`:

```ts
{
  param: 'system',
  required: false,
  transform: (params: Params) => {
    let systemMessages: AnthropicMessageContentItem[] = [];
    if (!!params.messages) {
      params.messages.forEach((msg: Message & PromptCache) => {
        if (
          SYSTEM_MESSAGE_ROLES.includes(msg.role) &&
          msg.content &&
          typeof msg.content === 'object' &&
          msg.content[0].text
        ) {
          msg.content.forEach((_msg) => {
            systemMessages.push({
              text: _msg.text,
              type: 'text',
              ...((_msg as any)?.cache_control && {
                cache_control: { type: 'ephemeral' },
              }),
            });
          });
        } else if (
          SYSTEM_MESSAGE_ROLES.includes(msg.role) &&
          typeof msg.content === 'string'
        ) {
          systemMessages.push({
            ...(msg?.cache_control && {
              cache_control: { type: 'ephemeral' },
            }),
            text: msg.content,
            type: 'text',
          });
        }
      });
    }
    return systemMessages;
  },
},
```

System messages are pulled out of the messages array entirely (the
messages transform skips entries where `SYSTEM_MESSAGE_ROLES.includes(msg.role)`).
The OpenAI `system` role is the only thing matched (the constant
`SYSTEM_MESSAGE_ROLES` lives in `src/types/requestBody`). Each system
text block becomes
`{type:'text', text, cache_control?: {type: 'ephemeral'}}`. No
multi-block diff between str-vs-list is performed — both paths coerce
into a single element, but the loop appends so multiple consecutive
system messages concatenate into the top-level array.

#### max_tokens default

`src/providers/anthropic/chatComplete.ts:382-387` makes `max_tokens`
**required** at the config layer; Portkey propagates the caller's
OpenAI `max_tokens` / `max_completion_tokens` straight through
without defaulting:

```ts
max_tokens: {
  param: 'max_tokens',
  required: true,
},
max_completion_tokens: {
  param: 'max_tokens',
},
```

#### tool_choice mapping

`src/providers/anthropic/chatComplete.ts:341-362`:

| OpenAI                                  | Anthropic                                            |
|-----------------------------------------|------------------------------------------------------|
| `"required"`                            | `{type: 'any'}`                                       |
| `"auto"`                                | `{type: 'auto'}`                                      |
| `"none"`                                | `{type: 'none'}`                                      |
| `{type: 'function', function: {name}}`  | `{type: 'tool', name: <name>}`                         |
| missing                                 | `null` (the field is dropped)                         |

There is **no** `disable_parallel_tool_use` translation; the OpenAI
`parallel_tool_calls` flag is dropped.

#### Streaming SSE → OpenAI chunks

`getAnthropicStreamChunkTransform` at
`src/providers/anthropic/chatComplete.ts:388-532`. Per chunk type:

| Anthropic event                              | Portkey output |
|----------------------------------------------|----------------|
| `event: ping`                                | dropped. |
| `event: content_block_stop`                  | dropped. |
| `event: message_stop`                        | `data: [DONE]\n\n` (translated, not raw). |
| `event: error`                               | OpenAI-shaped chunk with `finish_reason: error.type` followed by `data: [DONE]`. |
| `message_start` (with usage)                 | First chunk: `delta.role='assistant'`, `delta.content=''`, no usage yet — usage buffered in `streamState` and emitted on `message_delta`. |
| `message_delta` (with usage)                 | Final chunk: `finish_reason = transformFinishReason(delta.stop_reason)`, `usage` built from `streamState.usage` (= `prompt_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens`) + `parsedChunk.usage.output_tokens`. |
| `content_block_start` (`type:text`)          | `delta.content = content_block.text`, mirrors delta into `content_blocks` (non-strict only). |
| `content_block_start` (`type:tool_use`)      | `delta.tool_calls[i] = {id: content_block.id, type:'function', function:{name: content_block.name, arguments:''}, index: i}`, `i` incremented on each tool_use start. |
| `content_block_delta` (`input_json_delta`)   | `delta.tool_calls[i].function.arguments = delta.partial_json`. |
| `content_block_delta` (`text_delta`)         | `delta.content = delta.text`. |
| `ping`, `content_block_stop`, non-data lines | `chunk.replace(/^event: …[\r\n]*/, '')` strips the event line; result emitted. |

Note: Portkey uses a regex strip on the `event:` line rather than SSE
parsing. Content blocks like `signature`, `citations`, `thinking`
are folded into the OpenAI chunk under a
`content_blocks` extension field, only emitted when
`strictOpenAiCompliance=false`
(`src/providers/anthropic/chatComplete.ts:519-522`).

#### Stop reason mapping

`src/providers/utils/finishReasonMap.ts:23-30` for the
Anthropic→OpenAI direction:

| Anthropic `stop_reason` | OpenAI `finish_reason` |
|-------------------------|------------------------|
| `stop_sequence`         | `stop`                 |
| `end_turn`              | `stop`                 |
| `pause_turn`            | `stop`                 |
| `tool_use`              | `tool_calls`           |
| `max_tokens`            | `length`               |

Missing values map to `stop`
(`src/providers/utils.ts:75-84`): the `transformFinishReason` helper
falls back to `stop` and emits the raw reason only when
`strictOpenAiCompliance=false`.

#### Error mapping

`src/providers/anthropic/utils.ts:5-13`:

```ts
export const AnthropicErrorResponseTransform: (
  response: AnthropicErrorResponse,
  provider: string
) => ErrorResponse = (response, provider) => {
  return generateErrorResponse(
    {
      message: response.error?.message,
      type: response.error?.type,
      param: null,
      code: null,
    },
    provider
  );
};
```

So an Anthropic error envelope
`{"type":"error","error":{"type":"...","message":"..."}}` becomes the
OpenAI shape
`{"error":{"message":"<provider> error: <msg>","type":"<...>","param":null,"code":null},"provider":"anthropic"}`.

#### Stream-passthrough mode (overloaded error)

Portkey has a dedicated behaviour for Anthropic streaming 200 + error
event, documented at
`portkey.ai/docs/integrations/llms/anthropic` (the "Catch Overloaded
Error on Stream" section). When enabled on the integration, the
gateway inspects the first SSE event for `event: error` with
`overloaded_error`, and converts to HTTP 529 before forwarding. This
unlocks Anthropic-stream retry/fallback paths that rely on HTTP
status codes.

#### Usage mapping (non-streaming)

`getAnthropicChatCompleteResponseTransform` at
`src/providers/anthropic/chatComplete.ts:317-385`:

```ts
const {
  input_tokens = 0,
  output_tokens = 0,
  cache_creation_input_tokens,
  cache_read_input_tokens,
} = response?.usage;

const shouldSendCacheUsage =
  cache_creation_input_tokens || cache_read_input_tokens;

// … content + tool_calls extraction …

usage: {
  prompt_tokens: input_tokens,
  completion_tokens: output_tokens,
  total_tokens:
    input_tokens +
    output_tokens +
    (cache_creation_input_tokens ?? 0) +
    (cache_read_input_tokens ?? 0),
  prompt_tokens_details: {
    cached_tokens: cache_read_input_tokens ?? 0,
  },
  ...(shouldSendCacheUsage && {
    cache_read_input_tokens: cache_read_input_tokens,
    cache_creation_input_tokens: cache_creation_input_tokens,
  }),
},
```

`total_tokens` here is OpenAI-style (`prompt + completion`); cache
read/creation are **not** rolled into `prompt_tokens` to mirror
Anthropic's `input_tokens` (because Anthropic separately reports them).
The `cache_*_input_tokens` top-level mirrors are emitted only when the
upstream reported at least one.

#### Service tier translation

Portkey translates OpenAI's `service_tier` to Anthropic's `speed`
parameter in the request transform (see docs table):

| `service_tier`        | Anthropic `speed` |
|-----------------------|-------------------|
| `auto`                | `fast`            |
| `standard_only`       | `standard`        |
| `default`             | `standard`        |
| `fast`                | `fast`            |
| `standard`            | `standard`        |
| unknown               | omitted           |

Plus a beta header is sent (`fast-mode-2026-02-01` per LiteLLM's
catalog; Portkey doesn't say which, but at minimum
`anthropic-beta` is the right place for it).

### A.3 Bifrost

**File**: `core/providers/anthropic/anthropic.go` on `main`.

#### Headers

`NewAnthropicProvider` at `core/providers/anthropic/anthropic.go:108-110`:

```go
provider.apiVersion = "2023-06-01"
```

…and `anthropicRequestHeaders` at
`core/providers/anthropic/anthropic.go:181-189`:

```go
func (provider *AnthropicProvider) anthropicRequestHeaders(
    ctx *schemas.BifrostContext, key schemas.Key,
) map[string]string {
    headers := map[string]string{
        "anthropic-version": provider.apiVersion,
    }
    if key.Value.GetValue() != "" && !IsClaudeCodeMaxMode(ctx) {
        headers["x-api-key"] = key.Value.GetValue()
    }
    return headers
}
```

So:

- `anthropic-version` hardcoded to `"2023-06-01"` on the struct field.
  A future version bump means editing the struct literal.
- `x-api-key` set from the resolved key, except in "Claude Code max
  mode", where Bifrost deliberately omits `x-api-key` (Claude Code
  carries its own auth and rejects extra auth headers).
- No OAuth / `Authorization: Bearer` path of its own. OAuth passthrough
  is implemented by `providerUtils.SetPassthroughHeaders` at
  `core/providers/anthropic/anthropic.go:236`, which forwards the
  caller's raw headers when called from a passthrough route.

#### Streaming headers

`ChatCompletionStream` at
`core/providers/anthropic/anthropic.go:600-615` adds the streaming
specifics:

```go
headers := map[string]string{
    "Content-Type":      "application/json",
    "anthropic-version": provider.apiVersion,
    "Accept":            "text/event-stream",
    "Cache-Control":     "no-cache",
}
if key.Value.GetValue() != "" && !IsClaudeCodeMaxMode(ctx) {
    headers["x-api-key"] = key.Value.GetValue()
}
```

Same `x-api-key`-omitted-in-`IsClaudeCodeMaxMode` pattern as the
unary path.

#### System prompt extraction

Bifrost does the OpenAI→Anthropic transform in `chat.go` and
`requestbuilder.go`. The structural pattern matches LiteLLM:
system-role messages are extracted, converted to
`AnthropicContentBlock`s of type `text`, `cache_control` blocks are
preserved (block-level + top-level). Concrete points to verify (when
the repo is cloned) include the conversion in
`core/providers/anthropic/chat.go:chatCompletion`; the file is 78896
bytes and not exhausted during this scrape. The exported shape for the
system block is `AnthropicContent` which has both a `ContentStr` and
a `ContentBlocks` variant; the merger helper at
`core/providers/anthropic/utils.go:appendToSystemContent` shows the
merge logic.

#### max_tokens default

Bifrost does **not** default. The struct copy in `chat.go` propagates
`max_tokens` from the request through unchanged. Clients sending a
request without `max_tokens` get the upstream Anthropic 400.

#### tool_choice mapping

Tool choice is converted in the standard Bifrost pattern (no file
captured here, but the roundtrip and reasoning tests
`core/providers/anthropic/chat_test.go` and `reasoningdialect_test.go`
document the surface). The pattern: `auto`↔`auto`,
`required`/OpenAI `function`↔`any`, named-tool `function`↔
`{type:"tool", name}`, `none`↔`none`. The provider has its own
"AnthropicMessagesToolChoice" type.

#### tool_use_id ↔ tool_call_id

Identity on the wire. Bifrost sanitises tool names against
`^[a-zA-Z0-9_-]{1,128}$`; no id sanitiser exists (Anthropic's id
constraint is met by Anthropic itself).

#### Streaming SSE → OpenAI / Bifrost chunks

`HandleAnthropicChatCompletionStreaming` at
`core/providers/anthropic/anthropic.go:449-820+` (continuation).

Key behaviour (the stream-loop is huge; the points captured from the
excerpt are):

- Hard cap to `max_tokens` for streaming reads via
  `doStreamingRequest` plus a `fasthttp` idle timeout reader
  (`NewIdleTimeoutReader`) wrapped around `resp.BodyStream()`.
- Per-event dispatch on `eventType` + `eventDataBytes` (Bifrost uses
  fasthttp + a hand-rolled `sseReader`, not httpx SSE).
- `usageToProcess` is collected from either `event.Usage` or
  `event.Message.Usage`, depending on where Anthropic emits it:
  `message_start` exposes it nested under `message.usage`,
  `message_delta` exposes it top-level. Bifrost's per-stream
  accumulator at `core/providers/anthropic/anthropic.go:560-720`
  max-merges because Anthropic reports per-request totals split
  across multiple events.
- Cached-token fold-in: `normalizeCachedUsage` at
  `core/providers/anthropic/anthropic.go:478-484` adds
  `CachedReadTokens + CachedWriteTokens` back into `PromptTokens` and
  `TotalTokens` once at stream end, with a `usageNormalized` guard to
  avoid double-counting on mid-stream cancel.
- Web-search count: `WebSearchRequests` carried into
  `OutputTokensDetails.NumSearchQueries` so it survives in the
  terminal chunk.
- Thinking tokens: `OutputTokensDetails.ThinkingTokens` is
  max-merged into `CompletionTokensDetails.ReasoningTokens`.
- Served modifiers: `Speed` and `InferenceGeo` lifted from
  `usageToProcess.Speed` / `usageToProcess.InferenceGeo` and set on
  the final chunk (they're top-level response fields, not usage
  fields).
- `servedFallbackModel` ("server-side fallback boundary") is also
  latched onto the final chunk.
- Streaming large-payload passthrough:
  `providerUtils.SetupStreamingPassthrough(ctx, resp)` returns true
  when the upstream response is above a threshold and Bifrost streams
  SSE raw to the client (preserving Anthropic stream shape
  end-to-end).
- Structured-output interception in the streaming loop:
  when `structuredOutputToolName` is set in context, blocks of that
  tool are converted to content deltas instead of tool-call deltas
  (so the client gets JSON in `delta.content` not
  `delta.tool_calls`).
- `message_delta.delta.stop_reason` mapped via
  `ConvertAnthropicFinishReasonToBifrost` to Bifrost's neutral set
  (then re-mapped to OpenAI by a Bifrost-level transform).
- `Connection: close` is forced on streaming requests to defeat
  fasthttp keep-alive bugs.

#### Stop reason mapping

`anthropicFinishReasonToBifrost` at
`core/providers/anthropic/utils.go:227-237`:

```go
var anthropicFinishReasonToBifrost = map[AnthropicStopReason]string{
    AnthropicStopReasonEndTurn:      "stop",
    AnthropicStopReasonMaxTokens:    "length",
    AnthropicStopReasonStopSequence: "stop",
    AnthropicStopReasonToolUse:      "tool_calls",
    AnthropicStopReasonCompaction:   "compaction",
}
```

`AnthropicStopReasonEndTurn`/`stop_sequence`/`tool_use`/`max_tokens`/
`compaction` are the only Anthropic stop reasons. The
`compaction → compaction` mapping is interesting: Bifrost passes the
Anthropic-specific `compaction` reason through as its own Bifrost
enum value instead of forcing it to `length` like LiteLLM does
(LiteLLM maps it to `length`,
`litellm/litellm_core_utils/core_helpers.py:107`).

#### Error mapping

`ParseAnthropicError` in `core/providers/anthropic/errors.go` reads
the Anthropic error envelope (status + body) and constructs a
`BifrostError`. The HTTP-status→Anthropic-error-type flow follows
Anthropic's own map (400=`invalid_request_error`,
401=`authentication_error`, 403=`permission_error`, 404=`not_found_error`,
413=`request_too_large`, 429=`rate_limit_error`, 500=`api_error`,
529=`overloaded_error` — same shape LiteLLM uses in
`litellm/anthropic_interface/exceptions/exception_mapping_utils.py:27-36`).

### A.4 OpenRouter

**Source**: `openrouter.ai/anthropic` and the standard
OpenRouter docs.

OpenRouter **does not expose an Anthropic-specific shape**. From the
landing page enumeration it lists 48 Anthropic-served models
(`https://openrouter.ai/anthropic` — Claude Opus 5/4.x/3.x plus
batch variants). All access is through OpenRouter's
`https://openrouter.ai/api/v1/chat/completions` endpoint using
OpenAI's shape; the auth header is `Authorization: Bearer <key>`
(no `x-api-key`); OpenRouter routes the request to Anthropic
internally.

- **Headers**: not Anthropic-specific on the OpenAI surface — OpenRouter
  sends an OpenAI-shaped request. Anthropic's `anthropic-version` is
  set inside OpenRouter's backend.
- **Tool choice mapping**: OpenRouter's public chat surface uses
  OpenAI vocabulary unmodified.
- **`system`**: stays as a top-level message when the client sends
  OpenAI's `role: "system"` message. OpenRouter's pass-through
  behaviour matches LiteLLM.
- **Finishing reasons**: stay OpenAI-shape; Anthropic-specific stop
  reasons like `compaction` map to OpenAI's `length` or surface as
  OpenRouter-specific.

In short: OpenRouter's Anthropic exposure is the opposite of the
LiteLLM/Portkey/Bifrost pattern — there's no OpenAI↔Anthropic
translation done by the client; only Anthropic→OpenAI happens
inside OpenRouter. The Anthropic-native `/v1/messages` shape is not
publicly advertised.

### A.5 Cloudflare AI Gateway

**Source**: `developers.cloudflare.com/ai-gateway/providers/anthropic`
(latest update Jul 28, 2026).

Two endpoints:

1. **Anthropic passthrough**:
   `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic/v1/messages`.
   Pure proxy: the caller's `x-api-key`,
   `anthropic-version: 2023-06-01`, and `Content-Type: application/json`
   headers go upstream unchanged. With BYOK, the caller's
   `x-api-key` is omitted and Cloudflare supplies the stored key. Auth
   to the gateway itself is `cf-aig-authorization: Bearer <CF_AIG_TOKEN>`,
   parallel to `Authorization` on the OpenAI side.
   The Anthropic SDK can be pointed at this URL with
   `baseURL: https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic`
   and the Anthropic SDK's `apiKey` becomes a placeholder.

2. **OpenAI-compat**:
   `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1/chat/completions`
   with `model: "anthropic/<model>"` in the body. This is the
   OpenAI-shape surface; Cloudflare performs the OpenAI↔Anthropic
   translation internally.

Net effect: Cloudflare bundles both surfaces (Anthropic passthrough
*and* OpenAI compat) in the same gateway, but the transformations are
proprietary and not published. The published surface is on parity
with LiteLLM and Portkey.

---

## B. Anthropic-compatible surface

| Gateway  | Anthropic-shaped route                                     | Behaviour                                                                                                                  |
|----------|------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------|
| LiteLLM  | `POST /v1/messages` (and beta `POST /anthropic/v1/messages`) | **Beta**: routes via `base_process_llm_request(..., route_type="anthropic_messages")` (`litellm/proxy/anthropic_endpoints/endpoints.py:78-184`). Handles streaming + non-streaming. Strip-anthropic-total-tokens optional via `litellm.strip_anthropic_total_tokens` (default off; see `_strip_total_tokens_from_anthropic_response` at `litellm/proxy/anthropic_endpoints/endpoints.py:40-66`). Custom `/v1/messages/count_tokens` at `litellm/proxy/anthropic_endpoints/endpoints.py:196-279` returns `{"input_tokens": …}` (Anthropic shape). `/api/event_logging/batch` at `litellm/proxy/anthropic_endpoints/endpoints.py:286-289` is a stub for Claude Code telemetry. |
| Portkey  | `POST /v1/messages` and `POST /v1/messages/count_tokens`    | Full Anthropic passthrough — `src/providers/anthropic/messages.ts` just calls `getMessagesConfig({})` from `src/providers/anthropic-base/messages.ts` (no transform). `src/providers/anthropic/api.ts:30-44` routes `/messages` → `https://api.anthropic.com/v1/messages`. `AnthropicMessagesResponseTransform` (`src/providers/anthropic/messages.ts:9-19`) is identity except on error. |
| Bifrost  | Yes — via the Anthropic SDK or any `/v1/messages`-shaped client | `/v1/messages` (chat, stream, batches, count_tokens) implemented in `core/providers/anthropic/anthropic.go`/`chat.go`/`responses.go`/`batch.go`/`count_tokens.go`. |
| OpenRouter | None publicly advertised.                                | n/a |
| Cloudflare | `POST /anthropic/v1/messages` (URL-prefix passthrough)    | Pure proxy to Anthropic. |

### B.1 LiteLLM Anthropic passthrough details

The shape of the Anthropic-compatible surface is essentially "LiteLLM
handles everything from `AnthropicConfig` upward". The route
controller at `litellm/proxy/anthropic_endpoints/endpoints.py:78-115`
simply calls the same `ProxyBaseLLMRequestProcessing` flow as
`/v1/chat/completions`, then optionally strips `usage.total_tokens`
(the OpenAI-flavoured field) so the response matches Anthropic's
specification:

```python
async def anthropic_response(
    fastapi_response: Response,
    request: Request,
    user_api_key_dict: UserAPIKeyAuth = Depends(user_api_key_auth),
):
    ...
    result = await base_llm_response_processor.base_process_llm_request(
        ...,
        route_type="anthropic_messages",
        ...
    )
    if litellm.strip_anthropic_total_tokens:
        _strip_total_tokens_from_anthropic_response(result)
    return result
```

`/v1/messages/count_tokens` at
`litellm/proxy/anthropic_endpoints/endpoints.py:196-279` wraps the
internal LiteLLM token counter and returns Anthropic's
`{"input_tokens": <count>}` shape — the only piece missing is the
cache breakdown Anthropic's API exposes.

### B.2 Portkey Anthropic-compatible surface details

Most useful insight: Portkey's `messages` route is *byte-identical*
to Anthropic's. `src/providers/anthropic/messages.ts:8` is literally:

```ts
export const AnthropicMessagesConfig = getMessagesConfig({});
```

…and `getMessagesConfig` is defined in
`src/providers/anthropic-base/messages.ts:46-77` as a thin wrapper
around the same `ProviderConfig` shape used for OpenAI-shape, but
without transforms. So every input field is forwarded under its
Anthropic name (`model`, `messages`, `system`, `max_tokens`,
`container`, `mcp_servers`, `metadata`, `service_tier`,
`stop_sequences`, `stream`, `temperature`, `thinking`, `tool_choice`,
`tools`, `top_k`, `top_p`).

Response transform `AnthropicMessagesResponseTransform` at
`src/providers/anthropic/messages.ts:9-19` is identity:

```ts
if ('model' in response) return response;
return generateInvalidProviderResponseError(response, ANTHROPIC);
```

So Portkey gives Anthropic-native clients a real passthrough, and
Anthropic-native error envelopes flow back unchanged.

---

## C. Authentication shapes observed

Summary across the five gateways:

| Header                                   | LiteLLM | Portkey | Bifrost | OpenRouter | Cloudflare |
|------------------------------------------|---------|---------|---------|------------|------------|
| `x-api-key` (default)                    | yes     | yes     | yes     | no         | yes (passthrough) |
| `Authorization: Bearer …` (custom base)  | yes (litellm param) | no | yes (passthrough only) | yes (OpenAI shape) | n/a (passthrough) |
| `Authorization: Bearer …` (OAuth)        | yes (auto from `sk-ant-oat*`) | no | yes (passthrough only) | no | no |
| `anthropic-version: "2023-06-01"`        | hardcoded default; override via `anthropic_version` param | hardcoded default; override via `anthropicVersion` SDK option or body `anthropic_version` | hardcoded in struct field `provider.apiVersion` | set inside OpenRouter | required in caller's headers |
| `anthropic-version` overridable?         | yes (`anthropic_version=` kwarg) | yes (per-request) | yes (struct field, future edit needed) | no — hidden upstream | no — caller passes whatever |
| `anthropic-dangerous-direct-browser-access` | set automatically on `sk-ant-oat*` OAuth tokens | not set | not set | not set | not set |
| `anthropic-beta` defaulting              | empty unless features triggered | `messages-2023-12-15` default | empty unless features triggered | not set | not set |

### Why "hardcoded default `2023-06-01`" matters

Anthropic occasionally bumps this date. The current Anthropic API
documents `2023-06-15` (some endpoints), and `messages-2023-12-15`
for `/v1/messages`. LiteLLM and Bifrost use `"2023-06-01"` as the
default; Portkey uses `"messages-2023-12-15"` for `anthropic-beta`
but `"2023-06-01"` for `anthropic-version`. There's no obvious
canonical choice from the documented Anthropic surface — production
gateways should make this overridable.

### `x-api-key` vs `Authorization`

LiteLLM is the most permissive:
- `x-api-key` is sent when the key is an `sk-ant-…` key and
  `api_base` is `api.anthropic.com`.
- `Authorization: Bearer …` is sent when:
  1. `use_bearer_for_custom_base=True` and the base isn't
     `api.anthropic.com`, or
  2. The key starts with `sk-ant-oat*` (OAuth), or
  3. Only `ANTHROPIC_AUTH_TOKEN` is set (no `ANTHROPIC_API_KEY`).

Portkey sends `x-api-key` only. Bifrost sends `x-api-key` unless
`IsClaudeCodeMaxMode(ctx)` is true (in which case it omits the
header entirely so Claude Code's own auth isn't shadowed).

### `anthropic-dangerous-direct-browser-access`

Only LiteLLM sets this automatically, and only when the key is
detected as an OAuth token (`optionally_handle_anthropic_oauth` at
`litellm/llms/anthropic/common_utils.py:69-97`). The trigger is the
`sk-ant-oat*` prefix.

In all other gateways, the caller is responsible for sending it (or
not) themselves, because it's a deliberate "I'm calling from a
browser" signal and shouldn't be silently added.

---

## D. Streaming translation specifics

### D.1 LiteLLM SSE table

Event-by-event, with citations in
`litellm/llms/anthropic/chat/handler.py`:

| Anthropic SSE event                                | LiteLLM OpenAI chunk |
|----------------------------------------------------|-----------------------|
| `message_start` (with `message.usage`)             | First chunk with `delta.role='assistant'`. Usage accumulated into final chunk via stream-state, NOT emitted here. (`handler.py:521-527`) |
| `content_block_start` (`type:text`)                | `delta.content = content_block.text`. (`handler.py:471`) |
| `content_block_start` (`type:tool_use`)            | `delta.tool_calls[i] = {id, type:'function', function:{name, arguments:''}, index: i}`. `i` incremented per tool_use. (`handler.py:479-501`) |
| `content_block_start` (`type:server_tool_use`)     | Same shape; tool name also seeded into `_server_tool_inputs[id]`. (`handler.py:484-501`) |
| `content_block_start` (`type:redacted_thinking`)   | `provider_specific_fields.thinking_blocks = [{type:'redacted_thinking', data}]`. (`handler.py:512-516`) |
| `content_block_start` (`type:compaction`)          | `provider_specific_fields.compaction_blocks`, plus `compaction_start`. (`handler.py:520-528`) |
| `content_block_start` (`type:*_tool_result` of web_search/web_fetch) | Buffered into `web_search_results` so multi-turn reconstruction works. (`handler.py:532-540`) |
| `content_block_start` (`type:code_execution_…_tool_result`) | Buffered into `tool_results`, converted to provider-neutral `code_interpreter_results`. (`handler.py:545-552`) |
| `content_block_delta` (`text_delta`)               | `delta.content = delta.text`. (`handler.py:457`) |
| `content_block_delta` (`input_json_delta`) on `tool_use`/`server_tool_use` | `delta.tool_calls[i].function.arguments = partial_json`. Not emitted for web_search_tool_result blocks (issue 17254). (`handler.py:458-484`) |
| `content_block_delta` (`thinking_delta`)           | `delta.reasoning_content = delta.thinking`, plus `provider_specific_fields.thinking_blocks`. (`handler.py:496-505`) |
| `content_block_delta` (`signature`)                | Finalises `thinking_blocks` with cumulative signature. (`handler.py:506-511`) |
| `content_block_delta` (`compaction_delta`)         | `provider_specific_fields.compaction_delta`. (`handler.py:513-516`) |
| `content_block_stop`                               | For tool blocks, emits empty-args tool call if no input arrived. Resets per-block state. (`handler.py:570-585`) |
| `message_delta` (with `delta.stop_reason` + `usage`) | Final chunk: `finish_reason = map_finish_reason(delta.stop_reason)`, `usage` computed from `delta.usage` via `calculate_usage` (which folds in cache read/write tokens). (`handler.py:519-525`) |
| `error`                                            | Raises `AnthropicError` immediately (does not emit a chunk). (`handler.py:529-535`) |

### D.2 Portkey SSE table

Event-by-event, with citations in
`src/providers/anthropic/chatComplete.ts:388-532`:

| Anthropic SSE event                                | Portkey OpenAI chunk |
|----------------------------------------------------|----------------------|
| `event: ping` line                                 | dropped. (`chatComplete.ts:412-414`) |
| `event: content_block_stop` line                   | dropped. (`chatComplete.ts:415-417`) |
| `event: message_stop` line                         | `data: [DONE]\n\n`. (`chatComplete.ts:419-421`) |
| `event: error` line                                | OpenAI chunk with `finish_reason` set to `parsedChunk.error.type`, followed by `[DONE]`. (`chatComplete.ts:444-460`) |
| `message_start` (`usage`)                          | First chunk: `delta.role='assistant'`, `delta.content=''`, no usage. `usage` is cached in `streamState.usage` to be emitted later. (`chatComplete.ts:465-482`) |
| `message_delta` (`usage`)                          | Final chunk: `delta={}`, `finish_reason = transformFinishReason(delta.stop_reason)`. `usage` is built from `streamState.usage` + `parsedChunk.usage.output_tokens` and includes cache read/creation totals + per-prompt cached_tokens. (`chatComplete.ts:485-513`) |
| `content_block_start` (`type:tool_use`)            | `delta.tool_calls[i] = {id, type:'function', function:{name, arguments:''}, index: i}`, `i` incremented per tool_use. (`chatComplete.ts:520-528`) |
| `content_block_delta` (`input_json_delta`)         | `delta.tool_calls[i].function.arguments = partial_json`. (`chatComplete.ts:529-535`) |
| `content_block_delta` (`text_delta`)               | `delta.content = text`. (`chatComplete.ts:537-538`) |
| Any other `content_block_*`                        | The raw delta is also echoed back into `content_blocks` extension field when `strictOpenAiCompliance=false`. (`chatComplete.ts:540-543`) |

Notable: Portkey uses `event:` regex stripping rather than full SSE
parsing, which is one place where LiteLLM is more robust (LiteLLM
parses `data:` JSON lines, accumulates partial JSON across TCP
fragments via `chunk_type = "accumulated_json"`, see
`handler.py:251-307`).

### D.3 Bifrost SSE table

Bifrost has both an OpenAI-compat transformer downstream and a
native-Anthropic shape preservation path:

- **OpenAI-shape output**: `HandleAnthropicChatCompletionStreaming`
  at `core/providers/anthropic/anthropic.go:449-820+` (per-event
  handler reads from `sseReader.ReadEvent()`), maps Anthropic
  event types into Bifrost shape, which the Bifrost layer then
  translates to OpenAI.
- **Native Anthropic passthrough**: `SetupStreamingPassthrough(ctx,
  resp)` returns true when response is large; raw SSE bytes flow to
  the client verbatim. This is Bifrost's "preserve Anthropic streaming
  format end-to-end" mode (i.e. expose `/v1/messages` SSE verbatim
  from Anthropic).

### D.4 Token usage reporting timing

| Gateway | First usage chunk                                 | Final usage chunk |
|---------|---------------------------------------------------|-------------------|
| LiteLLM | `message_start` → usage accumulated internally; not emitted to client yet. (`handler.py:521-527`) | `message_delta` → emitted on the last chunk. |
| Portkey | `message_start` → cached into `streamState.usage`; not emitted until `message_delta`. (`chatComplete.ts:478-489`) | `message_delta` → emitted with full usage. |
| Bifrost | `message_start` (nested `message.usage`) + `message_delta` (top-level `usage`) → max-merged into a single accumulator; emitted on the terminal event. (`anthropic.go:560-720`) | Same. |
| Cloudflare | Not published; presumed similar. | Same. |
| OpenRouter | Anthropic-only path: usage goes from `message_delta` through OpenRouter's chat-completion translator; only one chunk carries `usage` (matches OpenAI convention). | Same. |

The key invariant: **Anthropic splits usage across two events
(`input_tokens` in `message_start`, `output_tokens` in
`message_delta`); the gateway has to accumulate them and emit one
chunk**. All three source-AVailable gateways do the accumulation
internally and emit on the `message_delta` so the client sees usage
exactly once, on the final chunk — which matches OpenAI's shape.

### D.5 Preserving Anthropic streaming format end-to-end

| Gateway | Preserves Anthropic SSE end-to-end? | Path |
|---------|-------------------------------------|------|
| LiteLLM | yes, when caller hits `/v1/messages` or `/anthropic/v1/messages`; the route is `/v1/messages`-shaped and SSE flows through. The actual transform-to-OpenAI happens only on `/v1/chat/completions`. | `litellm/proxy/anthropic_endpoints/endpoints.py:75-184` |
| Portkey | yes — `AnthropicMessagesResponseTransform` is identity (`src/providers/anthropic/messages.ts:9-19`); the route forwards chunk-for-chunk. | `src/providers/anthropic/messages.ts` |
| Bifrost | yes — `SetupStreamingPassthrough` in `core/providers/anthropic/anthropic.go` returns raw SSE bytes; Anthropic streaming shape is preserved when called from an Anthropic-shape client. | `anthropic.go:535+` |
| OpenRouter | n/a — no Anthropic-shape surface. | n/a |
| Cloudflare | yes — gateway at `/anthropic/v1/messages` is a pure proxy. | `developers.cloudflare.com/ai-gateway/providers/anthropic/` |

---

## E. Models endpoint

### E.1 LiteLLM

`AnthropicModelInfo.get_models` at
`litellm/llms/anthropic/common_utils.py:559-585` hits
`{api_base}/v1/models` with `x-api-key` + `anthropic-version: 2023-06-01`,
parses the OpenAI-shape response, then **prefixes every model id with
`"anthropic/"`** so the returned list matches LiteLLM's
provider-namespaced convention. The Anthropic-side `/v1/models` shape
is OpenAI-compatible (Anthropic's `/v1/models` returns
`{object: "list", data: [{id: "..."}]}` since v2023-06-01, modeled
after OpenAI), so no shape translation is needed — only the
`anthropic/` prefix.

### E.2 Portkey

`Portkey` exposes an OpenAI-shape models endpoint and routes Anthropic
models internally. There's no separate Anthropic-shape `/v1/models`
surface. Per the docs at
`portkey.ai/docs/integrations/llms/anthropic`, Anthropic models appear
in the OpenAI-shape `GET /v1/models` listing under their original ids
(no provider prefix by default).

### E.3 Bifrost

`listModelsByKey` at `core/providers/anthropic/anthropic.go:295-345`
calls Anthropic's native `/v1/models` with
`{api_base}/v1/models?limit={page_size}` and parses the Anthropic
response (`AnthropicListModelsResponse`). It does **not** prefix with
a provider namespace — Bifrost applies its own namespace externally.
Stream and chat completion paths use this for capability gating.

### E.4 OpenRouter / Cloudflare

OpenRouter has its own proprietary models endpoint with OpenAI shape.
Cloudflare routes `/v1/models` through its gateway standard
surface. Neither needs Anthropic-specific translation for the models
endpoint itself.

---

## F. Tool use handling

### F.1 Anthropic `tool_result` blocks ↔ OpenAI `tool: <message>`

| Gateway | OpenAI → Anthropic | Anthropic → OpenAI |
|---------|---------------------|---------------------|
| LiteLLM | OpenAI `{role: 'tool', tool_call_id, content}` becomes an Anthropic user message containing `{type: 'tool_result', tool_use_id, content}`. The conversion is in `anthropic_messages_pt` (factory in `litellm/litellm_core_utils/prompt_templates/factory.py`). | Anthropic `{type: 'tool_use', id, name, input}` becomes OpenAI's `assistant.tool_calls[i] = {id, type: 'function', function: {name, arguments: JSON.stringify(input)}}`. (`litellm/llms/anthropic/chat/transformation.py:294-313`: `convert_tool_use_to_openai_format`) |
| Portkey | Same. `src/providers/anthropic/chatComplete.ts:130-141` `transformToolMessage` produces `{role: 'user', content: [{type:'tool_result', tool_use_id: msg.tool_call_id, content: msg.content}]}`. | Same. `chatComplete.ts:119-127` `transformAssistantMessage` produces `tool_calls[]` from `msg.tool_calls`. `chatComplete.ts:308-313` builds tool_calls on the response side. |
| Bifrost | Same. The tool-message conversion path is in `core/providers/anthropic/chat.go` (file incomplete during fetch). | Same — `tool_use` → OpenAI `tool_calls` in `responses.go`. |

### F.2 Extended-thinking / thinking blocks

| Gateway | OpenAI `reasoning_effort` ↔ Anthropic `thinking` |
|---------|--------------------------------------------------|
| LiteLLM | `reasoning_effort` → `thinking = {type: 'adaptive'}` + `output_config = {effort: <lvl>}`. The mapping table is in the user docs at `docs.litellm.ai/docs/providers/anthropic`: `low/minimal → "low"`, `medium → "medium"`, `high → "high"`, etc.; values land in the inline `REASONING_EFFORT_TO_OUTPUT_CONFIG_EFFORT` dict at `litellm/llms/anthropic/chat/transformation.py:218-226`. Adaptive thinking is required for Claude 4.6+ Opus. Streaming response carries `delta.reasoning_content` plus `provider_specific_fields.thinking_blocks`. |
| Portkey | Accepts native `thinking` parameter verbatim — `thinking: {param: 'thinking', required: false}` at `src/providers/anthropic/chatComplete.ts:404-407`. Docs describe the `claude-3-7-sonnet-latest` extended-thinking use case with `thinking={"type":"enabled","budget_tokens":2030}`. `content_blocks` is populated with the raw Anthropic blocks when `strictOpenAiCompliance=false` so the caller can read extended reasoning. |
| Bifrost | The most complex of the three. `core/providers/anthropic/utils.go` (truncated during fetch) defines `IsAdaptiveOnlyThinkingModel`, `IsOpus47Plus`, `IsSonnet5Plus`, `IsFableFamily`, `SupportsEffortParameter`, `RejectsEnabledThinking`, `RejectsDisabledThinking`. The provider strips `enabled` in favor of `adaptive` on adaptive-only models, drops `budget_tokens` once converted, rewrites `disabled` to `adaptive` on always-on models, etc. |

### F.3 Prompt cache (`cache_control`) pass-through

| Gateway | Cache-control pass-through policy |
|---------|-----------------------------------|
| LiteLLM | Pass-through at every level: top-level request, system blocks, message blocks, tool blocks. `is_cache_control_set` in `AnthropicModelInfo` (`litellm/llms/anthropic/common_utils.py:103-113`) detects presence; no stripping in the standard Anthropic path. The LiteLLM Bedrock override `should_strip_billing_metadata` is metadata-only. |
| Portkey | Pass-through at every level. `cache_control: {type: 'ephemeral'}` is added to text blocks, tool blocks, and system blocks wherever the OpenAI input has a `cache_control` field. (`chatComplete.ts:166-180, 285-311`) |
| Bifrost | Most aggressive. `stripUnsupportedAnthropicFields` (`utils.go:1+`) and `StripUnsupportedFieldsFromRawBody` (`utils.go:1+`) actively strip cache_control `scope` (not `type`) on providers without `PromptCachingScope`. For Anthropic direct, all cache_control is preserved; for Vertex and other providers without that beta, scopes are stripped but `type` + `ttl` are kept. Also: `clampAnthropicCacheBreakpoints` at `utils.go:AnthropicMaxCacheBreakpoints` (`utils.go:1+`) caps breakpoints to 4 (Anthropic's hard limit) and clears the *earliest* when over, because cache is cumulative. |
| OpenRouter | Pass-through (since OpenRouter owns the cache layer downstream of the OpenAI-shape surface). |
| Cloudflare | Unknown. |

---

## G. Concrete blueprint for Iroha

If Iroha needs both surfaces (`/v1/chat/completions` OpenAI-compat
and `/v1/messages` Anthropic-compat), the production pattern used by
LiteLLM and Portkey is to:

1. **Implement `AnthropicConfig` once.** The bidirectional translator
   lives at the *provider* layer, not at the route layer. The route
   layer just decides *which shape* to apply to the request body and
   *which shape* the response should come back as.
2. **Lift `system` to top-level.** Walk `messages`, pull out every
   `role: "system"`, cast to
   `list[{type: "text", text, cache_control?}]`, attach to top-level
   `system`. Pop from `messages`. (`LiteLLM:
   litellm/llms/anthropic/chat/transformation.py:1607-1661`;
   `Portkey: chatComplete.ts:284-316`)
3. **Default `max_tokens`** at config-time to a sane value per model
   (ideally a `get_max_tokens(model)` helper). The failure mode of
   "user sends OpenAI request with no `max_tokens` → Anthropic 400s"
   is a common bug to defend against.
4. **Map `tool_choice` ⇄ Anthropic vocabulary.** See the table in
   §A.1/§A.2 above for the exact mapping.
5. **Translate SSE event-by-event.** Keep a small per-stream state
   object (`tool_index`, accumulated `content_blocks`, current
   `content_block_type`, current `usage`, `model`, last `message_id`)
   so `content_block_delta` deltas know which tool or text block
   they belong to. Use the event-dispatch switch pattern in
   `ModelResponseIterator.chunk_parser` (`handler.py:410-606`).
6. **Accumulate usage from `message_start` AND `message_delta`.**
   Don't emit until `message_delta` — that's how OpenAI clients
   expect usage. Both LiteLLM and Portkey follow this contract.
7. **Inject headers unconditionally**:
   `anthropic-version: "2023-06-01"` and `x-api-key`. Make the
   version overridable because Anthropic occasionally releases new
   dates and Biffrost/LiteLLM cannot hot-reload it.
8. **Map errors:**
   - HTTP status → Anthropic `error.type` (see §A.1 table).
   - Streaming `event: error` → raise `AnthropicError`; do not
     emit a chunk.
   - Don't bother mapping OpenAI-shaped exceptions back to
     Anthropic shape unless you also expose the
     Anthropic-shaped surface — most gateways only do the
     forward mapping.
9. **If exposing `/v1/messages` Anthropic-shape too**, the simplest
   implementation is a passthrough (byte-for-byte). Anthropic's
   surface is well-defined; you only need a translation if you
   want to apply reasoning effort / structured outputs / thinking
   *adaptively* before forwarding. LiteLLM opts in to that via
   `/v1/messages` passthrough + transform; Portkey uses pure
   passthrough by default.
10. **Cache control:** always pass through, validate id format on
    request if you're sanitising tool names, and clamp to
    `AnthropicMaxCacheBreakpoints = 4` (Bifrost hard-codes this —
    it's a server-side limit Anthropic enforces).

---

## H. Source cross-reference (file:line index)

This is the one-place lookup for every direct citation used above.

### LiteLLM
- Header construction: `litellm/llms/anthropic/common_utils.py:289-403`
- OAuth handler: `litellm/llms/anthropic/common_utils.py:69-97`
- Beta-header builder: `litellm/llms/anthropic/common_utils.py:243-275`
- Tool-name sanitiser: `litellm/llms/anthropic/chat/transformation.py:1014-1074`
- Tool-name reverse map (streaming): `litellm/llms/anthropic/chat/handler.py:269-279` (init), `handler.py:434-441` (usage)
- System-message extraction: `litellm/llms/anthropic/chat/transformation.py:1607-1661`
- `max_tokens` default: `litellm/llms/anthropic/chat/transformation.py:269-289`
- `tool_choice` mapper: `litellm/llms/anthropic/chat/transformation.py:615-654`
- Request transform: `litellm/llms/anthropic/chat/transformation.py:1779-1900`
- Non-streaming response transform: `litellm/llms/anthropic/chat/transformation.py:2120-2230` (calculate_usage)
- Tool-use → tool_call converter: `litellm/llms/anthropic/chat/transformation.py:294-313`
- Streaming iterator: `litellm/llms/anthropic/chat/handler.py:266-606`
- Finish reason map: `litellm/litellm_core_utils/core_helpers.py:99-148`
- Anthropic error envelope for passthrough surface: `litellm/anthropic_interface/exceptions/exception_mapping_utils.py:27-36`
- `/v1/messages` route (beta): `litellm/proxy/anthropic_endpoints/endpoints.py:75-184`
- `/v1/messages/count_tokens` route: `litellm/proxy/anthropic_endpoints/endpoints.py:196-279`
- `/api/event_logging/batch` stub: `litellm/proxy/anthropic_endpoints/endpoints.py:286-289`
- `process_anthropic_headers` (rate-limit mapping): `litellm/llms/anthropic/common_utils.py:1049-1063`
- Models endpoint: `litellm/llms/anthropic/common_utils.py:559-585`
- User-facing docs: `docs.litellm.ai/docs/providers/anthropic` and `docs.litellm.ai/docs/providers/anthropic` paragraphs on `max_tokens`, structured outputs, prompt caching.

### Portkey
- Router glue: `src/providers/anthropic/index.ts`
- Chat completions → Anthropic transform: `src/providers/anthropic/chatComplete.ts:243-410`
- System prompt extraction: `src/providers/anthropic/chatComplete.ts:284-316`
- Tool transform (request): `src/providers/anthropic/chatComplete.ts:327-339`
- Tool-choice mapping: `src/providers/anthropic/chatComplete.ts:341-362`
- max_tokens requirement: `src/providers/anthropic/chatComplete.ts:382-387`
- Non-streaming response transform: `src/providers/anthropic/chatComplete.ts:317-385`
- Streaming chunk transform: `src/providers/anthropic/chatComplete.ts:388-532`
- Headers: `src/providers/anthropic/api.ts:11-39`
- Endpoint map: `src/providers/anthropic/api.ts:41-52`
- Anthropic-native messages config: `src/providers/anthropic-base/messages.ts:1-77` (used verbatim by `src/providers/anthropic/messages.ts:8`)
- Anthropic-native messages route: `src/providers/anthropic/messages.ts`
- Anthropic error transform: `src/providers/anthropic/utils.ts:5-13`
- Generic finish-reason dispatcher: `src/providers/utils.ts:66-83`
- Finish-reason map (Anthropic→OpenAI): `src/providers/utils/finishReasonMap.ts:23-30`
- Finish-reason map (OpenAI→Anthropic, for completeness): `src/providers/utils/finishReasonMap.ts:90-104`
- User-facing docs: `portkey.ai/docs/integrations/llms/anthropic`

### Bifrost
- Header construction (unary + streaming): `core/providers/anthropic/anthropic.go:181-189`, `core/providers/anthropic/anthropic.go:600-615`
- Unary request: `core/providers/anthropic/anthropic.go:HandleAnthropicChatCompletionRequest:248-326`
- Streaming dispatcher: `core/providers/anthropic/anthropic.go:HandleAnthropicChatCompletionStreaming:449-820+`
- Provider capability gating: `core/providers/anthropic/utils.go:isAnthropicServerToolSupported:71-85`, `ValidateChatToolsForProvider:96-127`, `ValidateToolsForProvider:166-237`
- Strip unsupported fields (typed): `core/providers/anthropic/utils.go:stripUnsupportedAnthropicFields:243-410`
- Strip unsupported fields (raw JSON): `core/providers/anthropic/utils.go:StripUnsupportedFieldsFromRawBody:412-660`
- Cache-control breakpoint clamp: `core/providers/anthropic/utils.go:clampAnthropicCacheBreakpoints:760+`
- Finish-reason map: `core/providers/anthropic/utils.go:anthropicFinishReasonToBifrost:227-237`
- Mid-conversation system reminder: `core/providers/anthropic/utils.go:inlineMidConversationSystem` (description only; code truncated in fetch)
- Web-search count accumulation: `core/providers/anthropic/anthropic.go:accumulateAnthropicResponsesUsage:330-410` and in-stream `anthropic.go:560-720`
- Cached-token fold-in: `core/providers/anthropic/anthropic.go:normalizeCachedUsage:478-484`
- Chat completion request body: `core/providers/anthropic/anthropic.go:ChatCompletion:430-460`
- List models: `core/providers/anthropic/anthropic.go:listModelsByKey:295-345`
- Streaming large-payload passthrough: `core/providers/anthropic/anthropic.go:` (around `SetupStreamingPassthrough` invocation at line 535+)
- User-facing docs: `docs.getbifrost.ai`

### OpenRouter
- Anthropic page: `https://openrouter.ai/anthropic` (lists 48 Anthropic models with OpenAI-shape access only)

### Cloudflare
- Provider docs: `https://developers.cloudflare.com/ai-gateway/providers/anthropic`
- Both Anthropic-shaped and OpenAI-shaped surfaces documented; transform logic proprietary.

---

## I. Pinch points (differences that have caused real bugs)

These are the spots where the gateways disagree, and where Iroha's
implementation will need to pick a side.

1. **`stop_reason` mapping for `compaction`**:
   - LiteLLM: `compaction` → `length`
     (`litellm/litellm_core_utils/core_helpers.py:107`).
   - Portkey: doesn't list `compaction` in its map (defaults to
     `stop`).
   - Bifrost: `compaction` → `compaction` (its own enum value
     different from OpenAI's).
   No consensus. LiteLLM's choice (`length`) is the most pragmatic
   for OpenAI-clients, since `length` corresponds to Anthropic's
   `compaction` is a kind of context limit.

2. **`total_tokens` in usage**:
   - LiteLLM strips it on the Anthropic passthrough surface
     (`litellm/proxy/anthropic_endpoints/endpoints.py:40-66`), gated
     by `litellm.strip_anthropic_total_tokens`, default off.
   - Portkey includes it on OpenAI-shape output (`chatComplete.ts:347-352`).
   - Bifrost computes it as `input_tokens + output_tokens` and also
     folds cache in (`anthropic.go:anthropic.go:300-310` and
     `normalizeCachedUsage`).
   Anthropic's `/v1/messages` API does not document
   `total_tokens`; OpenAI does. Don't include it on
   Anthropic-shape responses.

3. **System block schema**:
   - LiteLLM uses `AnthropicSystemMessageContent` typed dict
     (`type: "text", text: str, cache_control?: {...}`).
   - Portkey flattens to inline `{text, type, cache_control}`
     (`chatComplete.ts:296-310`).
   - Bifrost uses `AnthropicContent{ContentStr, ContentBlocks}`
     (`utils.go:appendToSystemContent`).
   These are wire-compatible because they all serialize to the same
   JSON shape, but they differ in how the request is constructed.

4. **Tools-as-OpenAI-content-blocks flag**:
   - LiteLLM only emits `tool_calls` (not text-based content blocks).
   - Portkey emits both via the `content_blocks` extension field
     when `strictOpenAiCompliance=false`
     (`chatComplete.ts:519-543`).
   - Bifrost emits the Bifrost-shaped response which carries
     `BifrostResponseChoice` and is then translated upstream.
   The `strict_open_ai_compliance` flag (Portkey) and
   `strict_open_ai_compliance` (LiteLLM has a similar
   `strict_open_ai_compliance` parameter on its Anthropic SDK
   integration) are an emerging convention.

5. **`extended-thinking` budget vs adaptive**:
   - LiteLLM detects per-model capability (`_is_adaptive_thinking_model`)
     and rewrites the request body to use
     `{thinking: {type: "adaptive"}, output_config: {effort: <lvl>}}`
     for Claude 4.6+ and Opus 4.5+
     (`litellm/llms/anthropic/chat/transformation.py:177-227, 1819-1824`).
   - Bifrost has the most aggressive version: it *rewrites*
     `thinking: {type: "enabled", budget_tokens: N}` to
     `thinking: {type: "adaptive"}` on adaptive-only models
     (`utils.go:stripUnsupportedAnthropicFields` and
     `RejectsEnabledThinking`).
   - Portkey forwards `thinking` verbatim
     (`chatComplete.ts:404-407`).
   For Anthropic 4.6/4.7+ the `budget_tokens` knob is deprecated and
   only `effort` is valid, so any gateway that touches 4.6+ needs
   this rewrite.

6. **Streaming tool-call fragment stitching**:
   - LiteLLM is the most defensive: it tracks
     `current_content_block_type` and only emits `tool_calls[]` deltas
     when that block type is `tool_use` or `server_tool_use`
     (`handler.py:513-522`). Reason: web_search blocks also produce
     `input_json_delta` events that should not be turned into tool
     calls.
   - Portkey checks
     `parsedChunk.delta?.partial_json != undefined` on
     `content_block_delta`, but doesn't filter by current block type
     (it relies on `content_block_start` to set
     `streamState.toolIndex++` only for `tool_use` blocks, so
     `streamState.toolIndex` is monotonic only across tool blocks).
   - Bifrost's per-stream state `NewAnthropicStreamState()` tracks the
     same invariants but in Go.

---

## J. Closing notes

- **Anthropic → OpenAI streaming is harder than OpenAI → Anthropic.**
  Anthropic emits a non-trivial per-block protocol; OpenAI's chunk
  shape is comparatively flat. The LiteLLM streaming iterator
  (`ModelResponseIterator.chunk_parser`) is the most thorough
  implementation available in the wild.
- **Both surfaces should share provider-level code.** LiteLLM's
  `AnthropicConfig` is reused by the Anthropic passthrough route
  (`/v1/messages`) AND the OpenAI-compat route
  (`/v1/chat/completions`); only the request-shape and
  response-shape transforms differ. Same architecture in Portkey
  (`src/providers/anthropic/*` powers both surfaces; the only
  difference is the transform applied on entry/exit).
- **Tool-name sanitisation is the most surprising bug source.**
  Both LiteLLM and Bifrost carry forward/reverse maps to keep
  rewrites lossless; Anthropic's hard requirement
  `^[a-zA-Z0-9_-]{1,128}$` on tool names is the most common
  rejection reason for callers coming from MCP / OpenAPI-driven
  tool catalogs.
- **`anthropic-version` date is a moving target.** Treat as
  overridable in any user-facing config; LiteLLM and Portkey do.
