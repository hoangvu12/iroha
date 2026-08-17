# Anthropic Messages API — research reference

Research date: 2026-08-15. Sources are the first-party docs at `platform.claude.com/docs/en/...` (the canonical Messages reference lives there; the `docs.anthropic.com` mirror URL Anthropic publishes in older docs returns 404 and resolves to the same page) and the current main branch of `anthropics/anthropic-sdk-typescript` and `anthropics/anthropic-sdk-python`. WebFetch snapshots taken 2026-08-15.

This is a non-normative research record. Where Anthropic ships the same fact in both docs and SDK source, the SDK line number is cited so we can keep the spec implementation honest even if the docs trim an edge case.

## Executive summary

- Base URL: `https://api.anthropic.com`. Endpoint for chat-style generation: `POST /v1/messages`. [`/api/messages`](https://platform.claude.com/docs/en/api/messages)
- Auth headers: `x-api-key: <key>` is the primary form; `Authorization: Bearer <oauth-token>` is the alternate. Both work; the API overview says "One of `x-api-key` or `Authorization`". [`/api/overview`](https://platform.claude.com/docs/en/api/overview)
- Version header: `anthropic-version: 2023-06-01`. This is still the only documented version and is the literal default both SDKs inject. [`/api/versioning`](https://platform.claude.com/docs/en/api/versioning); [`client.ts:1506`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts#L1506); [`_client.py`](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_client.py) (`default_headers` returns `"anthropic-version": "2023-06-01"` for both sync and async clients).
- Request envelope is JSON, content-type `application/json`. SDK uses `Accept: application/json` on requests ([`client.ts:1498`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts#L1498)).
- Three required fields: `model`, `messages`, `max_tokens`. [`/api/messages`](https://platform.claude.com/docs/en/api/messages)
- System prompt is **top-level**, not inside `messages`. The Messages API has no `"system"` role for input messages; sending `{"role": "system", ...}` is a deliberate omission. [`/api/messages`](https://platform.claude.com/docs/en/api/messages)
- Tools are passed as an array of `{name, description, input_schema}` where `input_schema` is a JSON Schema (`type: "object"`). [`/api/messages`](https://platform.claude.com/docs/en/api/messages)
- Streaming uses named SSE events with **no `[DONE]` sentinel**; the sentinel was removed in `2023-06-01`. Events carry a `type` field and a payload `data:` line; the SSE line `event:` carries the same name. [`/api/streaming`](https://platform.claude.com/docs/en/build-with-claude/streaming); [`/api/versioning`](https://platform.claude.com/docs/en/api/versioning)
- Response `id` starts with `msg_`. `Message.id` is documented as `msg_01...`, `msg_014p7gG3wDgGV9EUtLvnow3U`, etc. (TypeScript SDK type just says `id: string` — the `msg_` prefix is an API contract, not a type-level guarantee.) [`messages.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)
- Errors return JSON `{"type": "error", "error": {"type": "<name>", "message": "<text>"}, "request_id": "req_..."}`. Status codes are 400 / 401 / 402 / 403 / 404 / 409 / 413 / 429 / 500 / 504 / 529. [`/api/errors`](https://platform.claude.com/docs/en/api/errors)
- Models endpoint: `GET /v1/models` and `GET /v1/models/{model_id}`, auth-required, cursor pagination by `after_id`/`before_id`/`limit`. Response carries `{data, first_id, last_id, has_more}`. [`/api/models`](https://platform.claude.com/docs/en/api/models)

## A. Endpoint and headers

| Concern | Value | Source |
| --- | --- | --- |
| Base URL | `https://api.anthropic.com` | [`/api/overview`](https://platform.claude.com/docs/en/api/overview) ("The Claude API is a RESTful API at `https://api.anthropic.com`") |
| Messages endpoint | `POST /v1/messages` | [`/api/messages`](https://platform.claude.com/docs/en/api/messages) |
| Models list | `GET /v1/models` | [`/api/models`](https://platform.claude.com/docs/en/api/models) |
| Models get | `GET /v1/models/{model_id}` | [`/api/models`](https://platform.claude.com/docs/en/api/models) |
| Token counting | `POST /v1/messages/count_tokens` | [`/api/overview`](https://platform.claude.com/docs/en/api/overview) |
| Batches | `POST /v1/messages/batches` | [`/api/overview`](https://platform.claude.com/docs/en/api/overview) |
| Content type | `application/json` (request body); `Accept: application/json` | [`/api/overview`](https://platform.claude.com/docs/en/api/overview); [`client.ts:1498`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts#L1498) |

### Required request headers

| Header | Required? | Value | Source |
| --- | --- | --- | --- |
| `x-api-key` | One of this or `Authorization` | Anthropic Console API key | [`/api/overview`](https://platform.claude.com/docs/en/api/overview) |
| `Authorization` | One of this or `x-api-key` | `Bearer <short-lived access token>` from `/v1/oauth/token` via Workload Identity Federation | [`/api/overview`](https://platform.claude.com/docs/en/api/overview) |
| `anthropic-version` | Yes | `2023-06-01` (current; SDK default) | [`/api/versioning`](https://platform.claude.com/docs/en/api/versioning); [`client.ts:1506`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts#L1506) |
| `content-type` | Yes | `application/json` | [`/api/overview`](https://platform.claude.com/docs/en/api/overview) |

### Optional / situational headers

| Header | When | Source |
| --- | --- | --- |
| `anthropic-beta` | One or more comma-separated beta names (e.g. `prompt-caching-2024-07-31`, `computer-use-2025-01-24`, `output-128k-2025-02-19`, `context-1m-2025-08-07`, `interleaved-thinking-2025-05-14`, `structured-outputs-2025-11-13`). The list of betas is enumerated in [`/api/models`](https://platform.claude.com/docs/en/api/models) under the `anthropic-beta` query parameter type. | [`/api/models`](https://platform.claude.com/docs/en/api/models) |
| `anthropic-user-profile-id` | Per-request header parameter on `POST /v1/messages`; required to attribute the request to a third party under the `user-profiles` beta | [`/api/messages`](https://platform.claude.com/docs/en/api/messages) |
| `anthropic-dangerous-direct-browser-access` | Only set by the SDK when the caller opts into browser use with `dangerouslyAllowBrowser: true`. The TypeScript SDK injects `{ 'anthropic-dangerous-direct-browser-access': 'true' }` exactly when that option is true ([`client.ts:1503`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts#L1503)). The Python SDK guards against browser use differently and does not emit this header (see notes). Treat this as an opt-in confirmation header, not a primary auth path. | [`client.ts:1503`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts#L1503) |

The `anthropic-dangerous-direct-browser-access` header is not in Anthropic's public reference docs at the URLs above; the only first-party mention we have is the SDK source. A request that sets it without the SDK guarding it is still valid HTTP, but Anthropic's docs do not describe the server-side behavior. For Iroha's purposes: do not send this header from server code; it is a browser-only acknowledgement that the caller is knowingly shipping an API key to a browser.

### Response headers

The full list of HTTP response headers the API returns (relevant to adapters and proxies):

| Header | Description | Source |
| --- | --- | --- |
| `request-id` | Globally unique ID, e.g. `req_018EeWyXxfu5pfWkrYcMdjWG`. Same value also appears in error bodies as `request_id`. | [`/api/errors`](https://platform.claude.com/docs/en/api/errors) |
| `anthropic-organization-id` | ID of the org the credential belongs to. | [`/api/overview`](https://platform.claude.com/docs/en/api/overview) |
| `anthropic-workspace-id` | `wrkspc_`-prefixed workspace ID resolved from the credential. | [`/api/overview`](https://platform.claude.com/docs/en/api/overview) |
| `x-amzn-requestid` | AWS request ID on Claude Platform on AWS. | [`/api/errors`](https://platform.claude.com/docs/en/api/errors); [`/api/overview`](https://platform.claude.com/docs/en/api/overview) |
| `retry-after` | Seconds until the next request can succeed (rate-limit/overload cases). | [`/api/rate-limits`](https://platform.claude.com/docs/en/api/rate-limits) |
| `anthropic-ratelimit-requests-limit/remaining/reset` | RPM ceiling, remaining, RFC 3339 reset time. | [`/api/rate-limits`](https://platform.claude.com/docs/en/api/rate-limits) |
| `anthropic-ratelimit-tokens-limit/remaining/reset` | Tokens/min ceiling for the most restrictive current limit. | [`/api/rate-limits`](https://platform.claude.com/docs/en/api/rate-limits) |
| `anthropic-ratelimit-input-tokens-limit/remaining/reset` | Input-tokens/min ceiling. | [`/api/rate-limits`](https://platform.claude.com/docs/en/api/rate-limits) |
| `anthropic-ratelimit-output-tokens-limit/remaining/reset` | Output-tokens/min ceiling. | [`/api/rate-limits`](https://platform.claude.com/docs/en/api/rate-limits) |
| `anthropic-priority-input-tokens-*` / `anthropic-priority-output-tokens-*` | Priority tier variants. | [`/api/rate-limits`](https://platform.claude.com/docs/en/api/rate-limits) |
| `anthropic-fast-*` | Fast-mode rate-limit status. | [`/api/rate-limits`](https://platform.claude.com/docs/en/api/rate-limits) |

## B. Request shape

Top-level keys of the `POST /v1/messages` body, grouped by required-ness. All fields are JSON unless noted. Source for every field: [`/api/messages`](https://platform.claude.com/docs/en/api/messages) (the SDK `MessageCreateParamsBase` type is the same surface).

### Required

| Field | Type | Notes |
| --- | --- | --- |
| `model` | string | e.g. `claude-opus-5`, `claude-sonnet-4-5-20250929`. The full enum is in [section F](#f-models-endpoint). |
| `messages` | array of `MessageParam` | `MessageParam = {role: "user" \| "assistant" \| "system", content: string \| ContentBlock[]}`. The `"system"` role is not documented for input messages (system prompts must go through the top-level `system` field). |
| `max_tokens` | integer | The absolute maximum tokens the model will generate before stopping. Models stop earlier naturally; the docs note `Set to 0 to populate the prompt cache without generating a response`. |

### Top-level optional but commonly used

| Field | Type | Notes |
| --- | --- | --- |
| `system` | string \| array of `TextBlockParam` | System prompt. Either a plain string or a structured array (lets you set `cache_control`, `citations`, etc. on the prompt). |
| `tools` | array of `ToolUnion` | Each entry is either a custom `Tool` (`{name, description?, input_schema, type?: "custom", cache_control?, defer_loading?, eager_input_streaming?, input_examples?, strict?} | {cache_control?, defer_loading?, strict?, input_examples?, eager_input_streaming?, allowed_callers?}`), or a built-in tool variant (`web_search_20250305`, `web_fetch_20250910`, `code_execution_20250522`, `code_execution_20250825`, `code_execution_20260120`, `code_execution_20260521`, `bash_20250124`, `text_editor_20250124`, `text_editor_20250429`, `text_editor_20250728`, `memory_20250818`, `web_search_20260209`, `web_fetch_20260209`, `web_fetch_20260309`, `web_search_20260318`, `web_fetch_20260318`, `tool_search_tool_regex_20251119`, `tool_search_tool_bm25_20251119`). |
| `tool_choice` | object | `{type: "auto" \| "any" \| "tool" \| "none", disable_parallel_tool_use?: boolean, name?: string}`. `name` is required only when `type: "tool"`. |
| `stream` | boolean | When true, response is SSE instead of a single JSON body. |
| `temperature` | number (0.0–1.0) | Defaults to `1.0`. The docs explicitly note that 0.0 is **not** fully deterministic. |
| `stop_sequences` | array of string | Custom stop strings; if one fires, `stop_reason = "stop_sequence"` and the matching string is in `stop_sequence`. |
| `thinking` | `ThinkingConfigParam` | `{type: "enabled", budget_tokens: number, display?: "summarized" \| "omitted"}` \| `{type: "disabled"}` \| `{type: "adaptive", display?: "summarized" \| "omitted"}`. `budget_tokens` must be `>= 1024` and `< max_tokens` when `type: "enabled"`. Models ≥ 4.7 require `adaptive` rather than `enabled`; Fable 5 / Mythos 5 / Mythos Preview reject `disabled`. |
| `cache_control` | `CacheControlEphemeral` \| null | Top-level convenience for automatic caching. `{type: "ephemeral", ttl?: "5m" \| "1h"}`. `ttl` defaults to `"5m"`. |
| `output_config` | `OutputConfig` | `{effort?: "low" \| "medium" \| "high" \| "xhigh" \| "max", format?: JSONOutputFormat}`. `effort` selects a reasoning-effort level. `format` is Anthropic's structured-outputs mechanism: `{type: "json_schema", schema: {...}}`. |
| `metadata` | `{user_id?: string}` | Opaque external user identifier. Must not contain PII (name, email, phone). |
| `service_tier` | `"auto" \| "standard_only"` | `"auto"` lets Anthropic use priority capacity when available; `"standard_only"` skips it. |
| `container` | string \| null | Container identifier for code-execution reuse across requests. |
| `inference_geo` | string | Region for inference (e.g. `"us"`, `"global"`). Defaults to workspace `default_inference_geo`. |
| `anthropic_user-profile-id` | string | Sent as a header (see [section A](#a-endpoint-and-headers)), not in the body. |

### `messages[]` content block shapes (input side)

From `ContentBlockParam` in `messages.ts` and [`/api/messages`](https://platform.claude.com/docs/en/api/messages):

| `type` | Required fields | Optional fields | Purpose |
| --- | --- | --- | --- |
| `text` | `text` | `cache_control`, `citations` | Plain text inside a message. |
| `image` | `source` (`{type: "base64", media_type: "image/jpeg"\|"image/png"\|"image/gif"\|"image/webp", data}` or `{type: "url", url}`) | `cache_control` | Image input. |
| `document` | `source` (`{type: "base64", media_type: "application/pdf", data}` \| `{type: "text", media_type: "text/plain", data}` \| `{type: "content", content: string \| ContentBlock[]}` \| `{type: "url", url}`) | `cache_control`, `citations`, `context`, `title` | PDF / plaintext / structured-text document input. Citations can be enabled per-document. |
| `search_result` | `source`, `title`, `content[]` | `cache_control`, `citations` | A search-result block for the search-results tool. |
| `thinking` | `thinking`, `signature` | — | Pass back a thinking block unchanged; modified thinking blocks return 400 `invalid_request_error`. |
| `redacted_thinking` | `data` | — | Opaque, encrypted thinking block; pass back unchanged. |
| `tool_use` | `id`, `name`, `input` | `cache_control`, `caller` | Sent on an assistant message to surface Claude's tool call back through history. |
| `tool_result` | `tool_use_id`, `content` (string or array) | `cache_control`, `is_error` | Sent on a user message to return a tool result. |
| `server_tool_use` | `id`, `name`, `input` | `cache_control`, `caller` | Echo of a server-side tool call. Names are constrained to `"web_search"\|"web_fetch"\|"code_execution"\|"bash_code_execution"\|"text_editor_code_execution"\|"tool_search_tool_regex"\|"tool_search_tool_bm25"`. |
| `web_search_tool_result` | `tool_use_id`, `content` | `cache_control`, `caller` | Echo of web_search tool result. |
| `web_fetch_tool_result` | `tool_use_id`, `content` | `cache_control`, `caller` | Echo of web_fetch tool result. |
| `code_execution_tool_result` | `tool_use_id`, `content` | `cache_control` | Code-execution result; stdout may be encrypted (`encrypted_code_execution_result`). |
| `bash_code_execution_tool_result` | `tool_use_id`, `content` | `cache_control` | Bash code-execution result. |
| `text_editor_code_execution_tool_result` | `tool_use_id`, `content` | `cache_control` | Text-editor code-execution result. |
| `tool_search_tool_result` | `tool_use_id`, `content` | `cache_control` | Tool-search tool result. |
| `container_upload` | `file_id` | `cache_control` | Upload a file into a code-execution container. |
| `mid_conv_system` | `content` | `cache_control` | Mid-conversation system-instruction block (Fable 5, Mythos 5, Opus 4.8/5, Sonnet 5). |

### `Tool.input_schema` shape

`Tool.InputSchema` is a JSON Schema object with at least `{type: "object"}`. The TypeScript definition uses an index signature so any extra JSON-Schema keywords pass through ([`messages.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)):

```ts
export interface InputSchema {
  type: 'object';
  properties?: unknown | null;
  required?: Array<string> | null;
  [k: string]: unknown;
}
```

The docs recommend the [JSON Schema draft 2020-12](https://json-schema.org/draft/2020-12) dialect.

### Tool choice

| `tool_choice` value | Effect |
| --- | --- |
| `{type: "auto"}` (default) | Model decides whether to call a tool. `disable_parallel_tool_use` defaults to false. |
| `{type: "any"}` | Model must call at least one tool. With `disable_parallel_tool_use: true`, exactly one tool call. |
| `{type: "tool", name: "<name>"}` | Model must call the named tool. |
| `{type: "none"}` | Model cannot call any tools. |

### Extended thinking

`thinking.type: "enabled"` requires `budget_tokens: number` (`>= 1024` and `< max_tokens`). The TypeScript SDK also tracks `MODELS_TO_WARN_WITH_THINKING_ENABLED` to warn on Opus 4.6 and Mythos Preview: `thinking.type: "enabled"` is deprecated in favor of `adaptive`. `adaptive` is the default mode for Fable 5 / Mythos 5 / Mythos Preview and is rejected on models that only support extended thinking (≤ Claude 4.5). [`/api/messages`](https://platform.claude.com/docs/en/api/messages); [`messages.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) (`MODELS_TO_WARN_WITH_THINKING_ENABLED`); [`/api/errors`](https://platform.claude.com/docs/en/api/errors) ("Extended thinking not supported" / "Adaptive thinking not supported" / "Thinking cannot be disabled" sections).

### Prompt caching

Two mechanisms. Both use `CacheControlEphemeral = {type: "ephemeral", ttl?: "5m" | "1h"}`:

1. **Top-level `cache_control`** — Anthropic auto-places the breakpoint on the last cacheable block (the system / tool / message order is `tools` → `system` → `messages`).
2. **Per-block `cache_control`** — placed on individual content blocks, up to 4 breakpoints per request.

A request can mix both. Cache hits require an exact-prefix match; the lookback window is 20 blocks per breakpoint. Minimum cacheable lengths are model-specific (e.g. 1,024 tokens for Opus 4.8 / Sonnet 4.x; 4,096 tokens for Opus 4.5/4.6, Haiku 4.5). [`/build-with-claude/prompt-caching`](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

### Structured outputs (Anthropic's `response_format` equivalent)

`output_config.format: {type: "json_schema", schema: <JSON Schema object>}` is the structured-outputs mechanism. The schema is constrained-decoded, so the response text block is guaranteed to validate. For tool schemas, set `strict: true` on the tool definition to guarantee schema validation on inputs. Source: [`/build-with-claude/structured-outputs`](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

There is no native ZDR / parallel-configs flag — structured outputs is a constrained-decode feature gated per-model (`structured_outputs.supported` in [`/api/models`](https://platform.claude.com/docs/en/api/models)).

### Stop sequences

`stop_sequences: string[]` is an optional array. When the model emits any of them, the response `stop_reason` is `"stop_sequence"` and the matched string is exposed as `stop_sequence` (the message-level field).

## C. Response shape

A successful non-streaming `POST /v1/messages` response is a single JSON object of the `Message` shape (defined in [`messages.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) and [`message.py`](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/message.py)):

```json
{
  "id": "msg_014p7gG3wDgGV9EUtLvnow3U",
  "type": "message",
  "role": "assistant",
  "model": "claude-opus-5",
  "content": [
    { "type": "text", "text": "Here's the current weather...", "citations": null }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "stop_details": null,
  "container": null,
  "usage": {
    "input_tokens": 472,
    "output_tokens": 89,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "cache_creation": { "ephemeral_1h_input_tokens": 0, "ephemeral_5m_input_tokens": 0 },
    "output_tokens_details": { "thinking_tokens": 0 },
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "inference_geo": null,
    "service_tier": "standard"
  }
}
```

### Top-level fields (always present)

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Format `msg_<id>`. The SDK types this as bare `string`; the `msg_` prefix is an API contract observed in every example and explicit in the API reference. |
| `type` | `"message"` | Literal. |
| `role` | `"assistant"` | Always `"assistant"` on response objects. |
| `model` | `Model` | The exact model that produced the response (echo). |
| `content` | `ContentBlock[]` | One or more blocks. See below. |
| `stop_reason` | `StopReason \| null` | Documented values: `"end_turn"`, `"max_tokens"`, `"stop_sequence"`, `"tool_use"`, `"pause_turn"`, `"refusal"`, `"model_context_window_exceeded"`. Always non-null in non-streaming responses; in streaming, null in `message_start`, non-null thereafter. |
| `stop_sequence` | `string \| null` | Matched custom stop sequence, if `stop_reason = "stop_sequence"`. |
| `stop_details` | `RefusalStopDetails \| null` | Present on refusal. `{category: "cyber"\|"bio"\|"frontier_llm"\|"reasoning_extraction"\|"general_harms"\|null, explanation: string \| null, type: "refusal"}`. |
| `container` | `Container \| null` | `{id, expires_at}` for code-execution container reuse. |
| `usage` | `Usage` | See below. |

### `content[]` block types (response)

`ContentBlock = TextBlock | ThinkingBlock | RedactedThinkingBlock | ToolUseBlock | ServerToolUseBlock | WebSearchToolResultBlock | WebFetchToolResultBlock | CodeExecutionToolResultBlock | BashCodeExecutionToolResultBlock | TextEditorCodeExecutionToolResultBlock | ToolSearchToolResultBlock | ContainerUploadBlock` ([`messages.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)).

| `type` | Fields | Notes |
| --- | --- | --- |
| `text` | `text`, `citations \| null` | Final answer text. `citations` only populated when the request enabled document citations. |
| `thinking` | `thinking`, `signature` | Extended-thinking content. Pass back unchanged for multi-turn continuity. |
| `redacted_thinking` | `data` | Opaque encrypted block; pass back unchanged. |
| `tool_use` | `id`, `name`, `input` | Client-tool call. `id` looks like `toolu_01T1x1fJ34qAmk2tNTrN7Up6`. |
| `server_tool_use` | `id`, `name`, `input`, `caller` | Server-tool call. `name` constrained to the same set as input `ServerToolUseBlockParam`. |
| `web_search_tool_result`, `web_fetch_tool_result` | `tool_use_id`, `content`, optional `caller` | Server-tool results. |
| `code_execution_tool_result` (and bash / text-editor / tool_search variants) | `tool_use_id`, `content` | Server-execution results. |
| `container_upload` | `file_id` | Echo of a container upload. |

### `usage` shape

```ts
interface Usage {
  input_tokens: number;                       // tokens after the last cache breakpoint
  output_tokens: number;                      // total billed output tokens
  cache_creation_input_tokens: number | null; // tokens written to cache this request
  cache_read_input_tokens: number | null;    // tokens read from cache this request
  cache_creation: { ephemeral_1h_input_tokens: number;
                    ephemeral_5m_input_tokens: number } | null;
  output_tokens_details: { thinking_tokens: number } | null; // reasoning portion of output_tokens
  server_tool_use: { web_search_requests: number;
                     web_fetch_requests: number } | null;
  inference_geo: string | null;
  service_tier: "standard" | "priority" | "batch" | null;
}
```

Field naming per the Python SDK `Usage` model ([`usage.py`](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/usage.py)); the TypeScript SDK has the same shape.

The total input is `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`. [`/build-with-claude/prompt-caching`](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) calls out that the per-request rate limits (`ITPM`) include `input_tokens + cache_creation_input_tokens` but not `cache_read_input_tokens` for most models.

## D. Streaming event shape

Set `stream: true` to switch to SSE. The TypeScript SDK types the stream as `Stream<RawMessageStreamEvent>`; the Python SDK exposes raw events via `client.messages.stream(...)`. Source: [`/api/streaming`](https://platform.claude.com/docs/en/build-with-claude/streaming); [`messages.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) (`RawMessageStreamEvent`).

### Event flow

1. One `message_start`.
2. Zero or more content blocks. Each block produces:
   - one `content_block_start`
   - one or more `content_block_delta`
   - one `content_block_stop`
3. One or more `message_delta` (top-level message updates; carries final `stop_reason`/`stop_sequence` and updated usage).
4. One `message_stop`.
5. Any number of `ping` events may appear anywhere.

A complete non-tool-use streamed response (from the docs, simplified):

```sse
event: message_start
data: {"type":"message_start","message":{"id":"msg_01...","type":"message","role":"assistant","content":[],"model":"claude-opus-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":25,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"container":null},"usage":{"output_tokens":15,"input_tokens":null,"cache_creation_input_tokens":null,"cache_read_input_tokens":null,"output_tokens_details":null,"server_tool_use":null}}

event: message_stop
data: {"type":"message_stop"}
```

### Event types

| Event | Direction | `data` payload |
| --- | --- | --- |
| `message_start` | first | `RawMessageStartEvent` = `{type: "message_start", message: Message}` — message has `content: []`, `stop_reason: null`. |
| `content_block_start` | per block | `RawContentBlockStartEvent` = `{type: "content_block_start", index: number, content_block: ContentBlock}` — `index` is the block's position in the eventual `content` array. |
| `content_block_delta` | per block | `RawContentBlockDeltaEvent` = `{type: "content_block_delta", index: number, delta: RawContentBlockDelta}`. |
| `content_block_stop` | per block | `RawContentBlockStopEvent` = `{type: "content_block_stop", index: number}`. |
| `message_delta` | one or more | `RawMessageDeltaEvent` = `{type: "message_delta", delta: {stop_reason, stop_sequence, stop_details, container}, usage: MessageDeltaUsage}`. |
| `message_stop` | last | `RawMessageStopEvent` = `{type: "message_stop"}`. |
| `ping` | anywhere | `{type: "ping"}`. Keep-alive. |
| `error` | anywhere | `{type: "error", error: {type: <error_type>, message: <text>}}` — same shape as non-streaming errors. |

### Delta types (`RawContentBlockDelta`)

| Delta | When | Payload |
| --- | --- | --- |
| `text_delta` | text block | `{type: "text_delta", text: string}` |
| `input_json_delta` | `tool_use` block | `{type: "input_json_delta", partial_json: string}` — partial JSON; concatenate until `content_block_stop`, then parse. |
| `citations_delta` | text block w/ citations | `{type: "citations_delta", citation: <one of the Citation... variants>}` |
| `thinking_delta` | thinking block | `{type: "thinking_delta", thinking: string}` |
| `signature_delta` | thinking block, just before `content_block_stop` | `{type: "signature_delta", signature: string}` — opaque signature for verifying the thinking block. With `display: "omitted"`, only this event arrives (no `thinking_delta`). |

### `message_delta` usage updates

`MessageDeltaUsage` is the cumulative token usage at the moment the delta is emitted. The docs warn: "The token counts shown in the `usage` field of the `message_delta` event are cumulative." [`/api/streaming`](https://platform.claude.com/docs/en/build-with-claude/streaming)

```ts
interface MessageDeltaUsage {
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  input_tokens: number | null;
  output_tokens: number;
  output_tokens_details: { thinking_tokens: number } | null;
  server_tool_use: { web_search_requests: number; web_fetch_requests: number } | null;
}
```

Only `output_tokens` is non-null until `message_delta` runs; the other fields are populated as they become known.

### SSE wire format

- **Named events**: each event has an SSE `event:` line whose name matches the JSON `type` field. The docs explicitly say "All events are named events, rather than data-only events." [`/api/versioning`](https://platform.claude.com/docs/en/api/versioning) (the `2023-06-01` changelog records this).
- **No `[DONE]` sentinel**: the `2023-06-01` changelog says "Removed unnecessary `data: [DONE]` event." [`/api/versioning`](https://platform.claude.com/docs/en/api/versioning) The terminal event is `message_stop`.
- **Line endings**: standard SSE — each event is two lines (`event: <name>\ndata: <json>`) followed by a blank line (`\n\n`). The data line may itself be multi-line JSON but the JSON itself is single-line in practice (e.g. `"data: {...}\n\n"`).
- **Incremental**: text deltas are cumulative substrings of the eventual full text, not full-prefix rewrites (this is what the `2023-06-01` changelog calls out: "Completions are incremental. For example, `\" Hello\"`, `\" my\"`, `\" name\"`, `\" is\"`, `\" Claude.\"` instead of `\" Hello\"`, `\" Hello my\"`, `\" Hello my name\"`, `\" Hello my name is\"`, `\" Hello my name is Claude.\"`").
- **Mid-stream errors**: when the API sends an `error` event after a 200, the docs direct callers to handle it separately from HTTP error handling; the example event is `{"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}}`. [`/api/streaming`](https://platform.claude.com/docs/en/build-with-claude/streaming)
- **Unknown event types**: clients must handle unknown events gracefully. [`/api/streaming`](https://platform.claude.com/docs/en/build-with-claude/streaming)

### `message_stop` vs `content_block_stop`

`content_block_stop` is the close of one content block (one per block index). `message_stop` is the close of the whole message. `message_delta` arrives between the last `content_block_stop` and `message_stop`, carrying the final `stop_reason` and `stop_sequence` (and final usage).

## E. Errors

Anthropic's error envelope: [`/api/errors`](https://platform.claude.com/docs/en/api/errors)

```json
{
  "type": "error",
  "error": {
    "type": "not_found_error",
    "message": "The requested resource could not be found."
  },
  "request_id": "req_011CSHoEeqs5C35K2UUqR7Fy"
}
```

`request_id` mirrors the `request-id` HTTP response header.

### HTTP status → error type

| Status | `error.type` | Notes |
| --- | --- | --- |
| 400 | `invalid_request_error` | Generic catch-all for 4xx other than the codes below. |
| 401 | `authentication_error` | Bad key, revoked key, expired key; on AWS: SigV4 problem. |
| 402 | `billing_error` | Payment or credit issue. |
| 403 | `permission_error` | Key does not have permission for the resource. |
| 404 | `not_found_error` | Bad URL or bad resource ID. |
| 409 | `conflict_error` | Concurrent modification or duplicate. |
| 413 | `request_too_large` | Exceeds the 32 MB Messages-API limit (256 MB Batches, 500 MB Files). |
| 429 | `rate_limit_error` | Rate limit hit. Returns `retry-after` header. |
| 500 | `api_error` | Internal Anthropic error. Retry with exponential backoff. |
| 504 | `timeout_error` | Processing timeout. Use streaming for long requests. |
| 529 | `overloaded_error` | Temporary capacity overload. |

### Rate-limit headers

(See [section A](#a-endpoint-and-headers) above for the full header table.) These are returned on every response, not only on 429:

- `retry-after`
- `anthropic-ratelimit-requests-{limit,remaining,reset}`
- `anthropic-ratelimit-tokens-{limit,remaining,reset}` (most restrictive current limit)
- `anthropic-ratelimit-input-tokens-{limit,remaining,reset}`
- `anthropic-ratelimit-output-tokens-{limit,remaining,reset}`
- `anthropic-priority-{input,output}-tokens-{limit,remaining,reset}` (priority tier only)
- `anthropic-fast-*` (fast-mode status)

`reset` is RFC 3339, not a delta.

### SDK error classes

Each official SDK maps HTTP statuses to typed exceptions; the canonical mapping in Python ([`_client.py`](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_client.py), `_make_status_error`) is:

| Status | Python exception |
| --- | --- |
| 400 | `BadRequestError` |
| 401 | `AuthenticationError` |
| 403 | `PermissionDeniedError` |
| 404 | `NotFoundError` |
| 409 | `ConflictError` |
| 413 | `RequestTooLargeError` |
| 422 | `UnprocessableEntityError` |
| 429 | `RateLimitError` |
| 529 | `OverloadedError` |
| ≥500 | `InternalServerError` |

(`422` is in the Python SDK's typed exceptions but not in Anthropic's public error docs.)

## F. Models endpoint

Source: [`/api/models`](https://platform.claude.com/docs/en/api/models).

### `GET /v1/models`

- Auth required: yes (the example shows `x-api-key: $ANTHROPIC_API_KEY` plus `anthropic-version: 2023-06-01`). Both are required for the SDK source.
- Query parameters:
  - `after_id` — cursor; returns the page immediately after this object.
  - `before_id` — cursor; returns the page immediately before this object.
  - `limit` — 1–1000, default 20.
  - `anthropic-beta` — repeated header parameter; optional.
- Response:

```json
{
  "data": [
    {
      "id": "claude-opus-4-6",
      "capabilities": {
        "batch":          { "supported": true },
        "citations":      { "supported": true },
        "code_execution": { "supported": true },
        "context_management": {
          "clear_thinking_20251015": { "supported": true },
          "clear_tool_uses_20250919": { "supported": true },
          "compact_20260112":         { "supported": true },
          "supported": true
        },
        "effort": {
          "low": { "supported": true }, "medium": { "supported": true },
          "high": { "supported": true }, "max":  { "supported": true },
          "xhigh": { "supported": true }, "supported": true
        },
        "image_input":      { "supported": true },
        "pdf_input":        { "supported": true },
        "structured_outputs": { "supported": true },
        "thinking": { "supported": true, "types": {
          "adaptive": { "supported": true }, "enabled": { "supported": true }
        } }
      },
      "created_at": "2026-02-04T00:00:00Z",
      "display_name": "Claude Opus 4.6",
      "max_input_tokens": 0,
      "max_tokens": 0,
      "type": "model"
    }
  ],
  "first_id": "...",
  "last_id": "...",
  "has_more": true
}
```

This is a different cursor scheme from the `page`/`next_page` form used elsewhere in the API: the API overview explicitly calls out that the Models endpoint is one of "Some list endpoints" that uses `after_id`/`before_id` and returns `has_more`/`first_id`/`last_id`. [`/api/overview`](https://platform.claude.com/docs/en/api/overview)

### `GET /v1/models/{model_id}`

- Same auth and headers.
- Returns a single `ModelInfo` object.

### Current model IDs

The `Model` enum in the TypeScript SDK ([`messages.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)) is the authoritative string list as of 2026-08-15:

| ID | Notes |
| --- | --- |
| `claude-sonnet-5` | Current Sonnet 5. |
| `claude-fable-5` | Limited availability. |
| `claude-mythos-5` | Limited availability (Anthropic Glasswing program). |
| `claude-opus-5` | Current Opus 5. |
| `claude-opus-4-8` | Newest Opus 4.x. |
| `claude-opus-4-7` | |
| `claude-mythos-preview` | Limited availability (Glasswing). |
| `claude-opus-4-6` | |
| `claude-sonnet-4-6` | |
| `claude-haiku-4-5` | Alias. |
| `claude-haiku-4-5-20251001` | Dated alias for `claude-haiku-4-5`. |
| `claude-opus-4-5` | Alias. |
| `claude-opus-4-5-20251101` | Dated alias. |
| `claude-sonnet-4-5` | Alias. |
| `claude-sonnet-4-5-20250929` | Dated alias. |

The `Model` type is also `(string & {})`, so any string is accepted (Anthropic adds dated aliases over time without changing the type). For Iroha, use the alias IDs (no date) where possible, since Anthropic retires dated aliases as documented in [`/about-claude/model-deprecations`](https://platform.claude.com/docs/en/about-claude/model-deprecations).

Deprecated/retired entries shown elsewhere in the docs (for reference): `claude-opus-4-1`, `claude-opus-4`, `claude-sonnet-4`, `claude-haiku-3.5`. None of these are in the SDK `Model` enum.

### `ModelCapabilities`

```ts
interface ModelCapabilities {
  batch:               { supported: boolean };
  citations:           { supported: boolean };
  code_execution:      { supported: boolean };
  context_management:  { clear_thinking_20251015?, clear_tool_uses_20250919?,
                         compact_20260112?, supported: boolean };
  effort:              { low, medium, high, max: { supported: boolean };
                         xhigh?: { supported: boolean };
                         supported: boolean };
  image_input:         { supported: boolean };
  pdf_input:           { supported: boolean };
  structured_outputs:  { supported: boolean };
  thinking:            { supported: boolean,
                         types: { adaptive, enabled: { supported: boolean } } };
}
```

## G. Notable differences vs OpenAI

Captured here as the design checklist for both an Anthropic Inference Adapter and an Anthropic-compatible public surface.

| Concern | OpenAI | Anthropic |
| --- | --- | --- |
| Auth header | `Authorization: Bearer <key>` | `x-api-key: <key>` (primary); `Authorization: Bearer <oauth-token>` is the alternate for WIF. |
| System prompt location | Either top-level `messages: [{role: "system", ...}]` or no system role; `developer` role on some endpoints. | Top-level `system` field. There is intentionally no `system` role on input `messages` — sending one is a contract violation. |
| Required body fields | `model`, `messages`. `max_tokens` optional (and default behavior depends on model). | `model`, `messages`, `max_tokens`. `max_tokens` is mandatory and must be ≤ the model's published maximum. |
| Multiple completions | `n: number` (1–128) | Not supported. One assistant turn per request. |
| Tool-call payload | Assistant message has `tool_calls: [{id, type: "function", function: {name, arguments}}]`; user message has separate `role: "tool"` entries with `tool_call_id`. | Assistant message has `content: [{type: "tool_use", id, name, input}, ...]`; user message has `content: [{type: "tool_result", tool_use_id, content, is_error?}, ...]`. Tools and tool results are blocks on a `content` array, not top-level fields on the message. |
| Tool schema | JSON Schema passed inside `function.parameters` (top-level `tools[].function.parameters`). | JSON Schema passed directly as `tools[].input_schema` (no `function:` wrapper). |
| Tool choice | `tool_choice: "auto"\|"none"\|"required"\|{type:"function", function:{name}}`. | `tool_choice: {type: "auto"\|"any"\|"tool"\|"none", name?, disable_parallel_tool_use?}`. `"any"` is Anthropic's analog of `"required"`; `"auto"` is the default. |
| Structured outputs | `response_format: {type: "json_schema", json_schema: {...}}` (Chat Completions) or `text.format` (Responses). | `output_config.format: {type: "json_schema", schema: {...}}`. Plus `tools[].strict: true` for strict tool-schema validation. The shapes are similar but the field names differ (`response_format` vs `output_config.format`, `json_schema.schema` vs `schema`). |
| Streaming events | `data: {...}` only (no named `event:` line); `delta` keyed by `choices[0].delta`; final event has `[DONE]` sentinel. | Named SSE `event:` lines; events keyed by content block (`content_block_*`); delta shape is a discriminated union of `text_delta`/`input_json_delta`/`thinking_delta`/`signature_delta`/`citations_delta`; **no `[DONE]` sentinel** — terminal is `message_stop`. |
| Usage fields | `prompt_tokens`, `completion_tokens`, `total_tokens`, plus optional `prompt_tokens_details.cached_tokens`. | `input_tokens` + `output_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` + `output_tokens_details.thinking_tokens` + `server_tool_use.{web_search_requests, web_fetch_requests}`. Total input is the sum. The names are different and Anthropic exposes per-direction cache tokens, not a single `cached_tokens`. |
| `temperature` / `top_p` | Both supported, mutually exclusive. | Only `temperature` (0.0–1.0). `top_p` is not exposed. |
| Multimodal input | `content: [{type: "image_url", image_url: {url, detail}}]` | `content: [{type: "image", source: {type: "base64", media_type, data} | {type: "url", url}}]` |
| Documents | Not native; some endpoints accept base64 file inputs. | First-class `document` content blocks; supports PDF base64, plaintext, structured-content, and PDF URL sources. |
| Stop reasons | `stop`, `length`, `tool_calls`, `content_filter`, `function_call` (legacy). | `end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn`, `refusal`, `model_context_window_exceeded`. |
| Response `id` prefix | `chatcmpl-...` | `msg_...` |
| Request timeout guidance | `stream` recommended for >1 minute. | SDK enforces non-streaming requests are not expected to exceed 10 minutes; for >10 minutes, use streaming or Message Batches. [`/api/errors`](https://platform.claude.com/docs/en/api/errors) |

## Open questions / not yet confirmed from primary docs

- The Python SDK does not appear to emit `anthropic-dangerous-direct-browser-access` at all; it detects browsers via user-agent only and doesn't guard the way the TypeScript SDK does. The header is genuinely a TS-SDK-only construct, not a server-side contract documented at `platform.claude.com`.
- `inference_geo` accepted values: docs mention `"us"` and `"global"` as examples but do not enumerate the full set. Treat the docs' examples as authoritative for now and pass values through unchanged.
- Some streaming deltas seen in the wild (`input_json_delta` keys ordering, server-side fallback `content_block_start`/`content_block_stop` pairs with no deltas) are described in the docs but not in the SDK union — the SDK's `RawContentBlockDelta` covers the common case. A robust adapter should treat unknown delta types as no-op and keep accumulating, as the docs instruct.
- `RefusalStopDetails.category` may grow over time per Anthropic's versioning policy. Adapters should default to `null`/`unknown` rather than refuse unknown categories.

## Where to put citations in Iroha's design docs

When the Anthropic Inference Adapter or Anthropic-compatible surface references one of these facts, cite the URL inline so a maintainer can re-verify against the live docs:

- Headers and body envelope → [`/api/messages`](https://platform.claude.com/docs/en/api/messages)
- Streaming event names and deltas → [`/build-with-claude/streaming`](https://platform.claude.com/docs/en/build-with-claude/streaming)
- Authentication → [`/api/overview`](https://platform.claude.com/docs/en/api/overview) (the dedicated `/api/authentication` URL returns 404; the auth table is on the overview page)
- Errors and statuses → [`/api/errors`](https://platform.claude.com/docs/en/api/errors)
- Rate-limit headers → [`/api/rate-limits`](https://platform.claude.com/docs/en/api/rate-limits)
- Models → [`/api/models`](https://platform.claude.com/docs/en/api/models)
- Versioning → [`/api/versioning`](https://platform.claude.com/docs/en/api/versioning)
- Stop reasons → [`/build-with-claude/handling-stop-reasons`](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)
- Structured outputs → [`/build-with-claude/structured-outputs`](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- Prompt caching → [`/build-with-claude/prompt-caching`](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- SDK type definitions → [`anthropic-sdk-typescript messages.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) and [`anthropic-sdk-typescript client.ts`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)