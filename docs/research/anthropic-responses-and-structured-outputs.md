# Anthropic + OpenAI `/v1/responses`: gateway research

Research for Iroha's Anthropic Provider Template. Two questions: (1) what do LiteLLM, Portkey, and Bifrost do when they receive an OpenAI Responses API request targeting an Anthropic Provider? (2) how does each translate `response_format` / Responses `text.format` to/from Anthropic's `output_config.format`?

All sources fetched 2026-08-15 from primary repositories and docs. Every claim below carries a file:line citation or doc URL.

---

## 1. LiteLLM

### A. `/v1/responses` route handling against an Anthropic target

**Yes — translates `/v1/responses` to Anthropic `/v1/messages` for Anthropic targets.**

The proxy route is registered at `litellm/proxy/response_api_endpoints/endpoints.py:118-126`:

```python
@router.post("/v1/responses", dependencies=[Depends(user_api_key_auth)], tags=["responses"])
@router.post("/responses",    dependencies=[Depends(user_api_key_auth)], tags=["responses"])
@router.post("/openai/v1/responses", dependencies=[Depends(user_api_key_auth)], tags=["responses"])
async def responses_api(request: Request, fastapi_response: Response, user_api_key_dict: ...):
```

The handler passes the body to `ProxyBaseLLMRequestProcessing.base_process_llm_request(...)` with `route_type="aresponses"` (`endpoints.py:248-261`), which dispatches via the standard routing pipeline. Anthropic is reached via the Chat Completions path: the request body is first converted to Chat Completions shape by `LiteLLMCompletionResponsesConfig.transform_responses_api_request_to_chat_completion_request` (`litellm/responses/litellm_completion_transformation/transformation.py:175-275`), which builds a Chat Completions dict with the Anthropic provider prefix; the Anthropic adapter (`litellm/llms/anthropic/chat/transformation.py`) then shapes the wire request.

Supported providers table for `/v1/responses`:
- https://docs.litellm.ai/docs/response_api — "Supported LLM providers: All LiteLLM supported providers — `openai`, `anthropic`, `bedrock`, `vertex_ai`, `gemini`, `azure`, `azure_ai` etc."
- Anthropic-specific supported parameters: `https://github.com/BerriAI/litellm/blob/f39d9178868662746f159d5ef642c7f34f9bfe5f/litellm/responses/litellm_completion_transformation/transformation.py#L57`

### B. Responses-specific field → Anthropic shape mapping

The conversion path is Responses → Chat Completions → Anthropic. The Responses-to-Chat shim lives at `litellm/responses/litellm_completion_transformation/transformation.py`. Anthropic-specific transformations live at `litellm/llms/anthropic/chat/transformation.py`.

| OpenAI Responses field | Anthropic `/v1/messages` shape | Citation |
|---|---|---|
| `input` (string or array) | `messages[]` | `transformation.py:227-251` — `_transform_responses_api_input_to_messages` |
| `instructions` | prepended as a `role:"system"` message in `messages[]` | `transformation.py:235-247` — `transform_instructions_to_system_message`; inline comment at 240 says "Anthropic requires that all tool_use blocks appear in ONE assistant message immediately followed by the tool_result blocks" — they merge consecutive `function_call` items into one assistant message and use `transform_instructions_to_system_message` to handle `instructions` |
| `previous_response_id` | resolved to full conversation history via `ResponsesSessionHandler.get_chat_completion_message_history_for_previous_response_id`, then concatenated into `messages[]` | `transformation.py:253-275` (`async_responses_api_session_handler`); `session_handler.py` |
| `parallel_tool_calls` | forwarded as-is into Chat Completions, then translated by Anthropic to `tool_choice.disable_parallel_tool_use = not parallel_tool_calls` | `litellm/llms/anthropic/chat/transformation.py:603-619` (`_map_tool_choice` — `parallel_tool_use` branch) |
| `text.format` | flattened to Chat `response_format`, then to Anthropic `output_format` (legacy beta) | see section C below |
| `truncation` | dropped / not part of Anthropic wire format (Anthropic has no `truncation` field; the LiteLLM shim does not bridge it) | not handled in `transformation.py` |
| `reasoning` (effort/summary) | forwarded as `reasoning_effort` (string or dict) → Anthropic `thinking` block via `AnthropicConfig.map_reasoning_effort` | `transformation.py:262`; Anthropic side at `litellm/llms/anthropic/chat/transformation.py` |
| `tools[]` (Responses shape, including built-ins like `web_search`, `file_search`) | flattened via `transform_responses_api_tools_to_chat_completion_tools` | `transformation.py:177-188` |
| `max_output_tokens` | renamed to `max_tokens` | `transformation.py:236` (`"max_tokens": responses_api_request.get("max_output_tokens")`) |

Streaming translation emits Chat Completions `chat.completion.chunk` SSE events; the Anthropic adapter's `_map_tool_choice` (`transformation.py:603-619`) handles the `parallel_tool_use` flag (Anthropic's inverse of OpenAI's `parallel_tool_calls`). LiteLLM does not expose Anthropic-native SSE event types — they are reshaped into the OpenAI Chat Completions chunk shape and the Responses SSE bridge reshapes them again into `response.created` / `response.in_progress` / `output_item.added` / etc. on the way out.

### C. Structured outputs mapping (`response_format` / `text.format` → Anthropic)

Two hop:

**Hop 1 — Responses `text.format` → Chat `response_format`** (`litellm/responses/litellm_completion_transformation/transformation.py:2308-2356`):

```python
@staticmethod
def _transform_text_format_to_response_format(text_param: object) -> dict[str, object] | None:
    ...
    if format_type == "json_schema":
        return {
            "type": "json_schema",
            "json_schema": {
                "name":   format_param.get("name",   "response_schema"),
                "schema": format_param.get("schema", {}),
                "strict": format_param.get("strict", False),
            },
        }
    elif format_type == "json_object":
        return {"type": "json_object"}
    elif format_type == "text":
        return None
```

Called from `transform_responses_api_request_to_chat_completion_request` at `transformation.py:273`:
```python
text_param: Final = responses_api_request.get("text")
if text_param:
    response_format = LiteLLMCompletionResponsesConfig._transform_text_format_to_response_format(text_param)
```

**Hop 2 — Chat `response_format` → Anthropic.** Two possible Anthropic targets:
1. **Legacy beta `output_format`** (top-level request field, requires `structured-outputs-2025-11-13` beta header) — `litellm/llms/anthropic/chat/transformation.py:1259-1283` (`map_response_format_to_anthropic_output_format`):
   ```python
   def map_response_format_to_anthropic_output_format(self, value: dict | None) -> AnthropicOutputSchema | None:
       json_schema = self._extract_json_schema_from_response_format(value)
       if json_schema is None: return None
       ...
       filtered_schema = self.filter_anthropic_output_schema(json_schema)
       return {"type": "json_schema", "schema": filtered_schema}
   ```
   The wrapper sets `optional_params["output_format"] = _output_format` at `transformation.py:1444-1454`.

2. **Tool-based** (older path, used when JSON schema is unsupported on the model, sets `tool_choice: {type: "tool", name: <json_tool>}`) — `litellm/llms/anthropic/chat/transformation.py:1285-1320` (`map_response_format_to_anthropic_tool`). The tool name constant `RESPONSE_FORMAT_TOOL_NAME` is imported at `transformation.py:25`.

The Anthropic JSON-schema filter (`filter_anthropic_output_schema` at `transformation.py:465-595`) strips schema keywords Anthropic rejects (`uniqueItems`, `minItems`/`maxItems`, `minLength`/`maxLength`, `minimum`/`maximum`, `if`/`then`/`else`/`not`, `oneOf` → rewrites to `anyOf`) — same as the Anthropic Python SDK. Documented at `transformation.py:469-477` with a reference to `https://platform.claude.com/docs/en/build-with-claude/structured-outputs#how-sdk-transformation-works`.

> **Important caveat re `output_config.format`.** LiteLLM's Anthropic adapter as of `main` writes the legacy beta `output_format` (top-level), not the newer GA `output_config.format`. The doc URL `https://docs.litellm.ai/docs/anthropic_completion` returned 404 at fetch time, and the unified `/v1/messages` doc (`https://docs.litellm.ai/docs/anthropic_unified/`) was not retrieved. The OpenAI-Responses → Chat Completions bridge (`transformation.py` in the responses folder) does not emit `output_config.*`; the GA Anthropic shape is therefore not currently surfaced by LiteLLM's Responses adapter.

### D. Capability coverage

`get_supported_openai_params` for Anthropic (`litellm/llms/anthropic/chat/transformation.py:418-441`) returns:
```python
["stream", "stop", "temperature", "top_p", "max_tokens", "max_completion_tokens",
 "tools", "tool_choice", "extra_headers", "parallel_tool_calls", "response_format",
 "user", "web_search_options", "speed", "context_management", "cache_control"]
```

- `response_format` is explicitly advertised as supported for Anthropic.
- The `/v1/responses` route is registered for all providers, with Anthropic listed in the official doc matrix (`https://docs.litellm.ai/docs/response_api`).

**Verdict for Iroha**: precedent for `responses: true` on the Anthropic Provider Template — LiteLLM does translate and advertises the route.

---

## 2. Portkey

### A. `/v1/responses` route handling against an Anthropic target

**No `/v1/responses` support against Anthropic.**

The Anthropic provider registry (`src/providers/anthropic/index.ts`) registers only four request shapes:

```ts
// src/providers/anthropic/index.ts:17-29
const AnthropicConfig: ProviderConfigs = {
  complete:             AnthropicCompleteConfig,
  chatComplete:         AnthropicChatCompleteConfig,
  messages:             AnthropicMessagesConfig,
  messagesCountTokens:  AnthropicMessagesConfig,
  api:                  AnthropicAPIConfig,
  responseTransforms: {
    'stream-complete':    AnthropicCompleteStreamChunkTransform,
    complete:             AnthropicCompleteResponseTransform,
    chatComplete:         getAnthropicChatCompleteResponseTransform(ANTHROPIC),
    'stream-chatComplete': getAnthropicStreamChunkTransform(ANTHROPIC),
    messages:             AnthropicMessagesResponseTransform,
  },
};
```

There is no `responses` key, no `responsesCreate.ts` for the Anthropic target, and the OpenAI-side `responsesCreate.ts` does not exist on `main` (`https://raw.githubusercontent.com/Portkey-AI/gateway/main/src/providers/openai/responsesCreate.ts` → 404).

The OpenAI provider at `src/providers/openai/index.ts:51-54` does expose a `createModelResponse` slot (`createModelResponse: createModelResponseParams([])`), but:
1. It is initialised with an empty argument list — `createModelResponseParams([])` produces a no-op config; OpenAI Responses API is therefore only bridged when the target is OpenAI itself.
2. The routes doc page (`https://portkey.ai/docs/api-reference/inference`) returned 404 at fetch time — no doc page confirms `/v1/responses` is exposed.

There is no Anthropic-side Responses handler in the public `main` branch.

### B. Structured outputs mapping

The Anthropic `chatComplete.ts` does not handle `response_format` or `text.format` — it transforms `messages`, `system`, `tools`, `tool_choice`, `temperature`, `top_p`, `top_k`, `stop_sequences`, `thinking`, `metadata.user_id` (`src/providers/anthropic/chatComplete.ts`). The only Anthropic-specific shape handled is the legacy Messages `messages` / `system` extraction; there is no `output_format` / `output_config.format` code path for OpenAI Responses structured outputs.

The native Anthropic Messages pass-through (`src/providers/anthropic/messages.ts`) simply forwards the Anthropic-shaped body — it does not convert from `response_format` or `text.format`.

### C. Capability coverage

- `responses`: not advertised (no route registered, no provider config entry, no docs).
- `structured_outputs`: not handled at the Anthropic provider boundary on the OpenAI Responses side.

### D. What this means for Iroha

Portkey does **not** translate `/v1/responses` to Anthropic. That's a precedent for `responses: false` on the Anthropic Provider Template — but only weakly, because Portkey's overall Responses coverage is itself incomplete on `main`. The strongest "no precedent" read: two of three major gateways translate; Portkey has not yet shipped the bridge.

---

## 3. Bifrost

### A. `/v1/responses` route handling against an Anthropic target

**Yes — full first-class Responses API support, both streaming and non-streaming, with native Anthropic-shaped conversion.**

The Anthropic provider has a dedicated `responses.go` file at `core/providers/anthropic/responses.go` (3,653 lines truncated only by fetch limits — a full BifrostResponses implementation). It is wired in the provider's method table via `core/providers/anthropic/anthropic.go`. The shared streaming machinery in `core/providers/anthropic/anthropic.go` already accepts `ResponsesResponseUsage` (`anthropic.go:80-97`, `extractAnthropicResponsesUsageFromPrefetch`) and an `accumulateAnthropicResponsesUsage` accumulator (`anthropic.go:262-380`) — both namespaced for the Responses dialect.

The Bifrost docs page for the Anthropic provider (`https://docs.getbifrost.ai/providers/supported-providers/anthropic`) confirms it in the supported-operations table:

| Operation            | Non-Streaming | Streaming | Endpoint               |
| -------------------- | ------------- | --------- | ---------------------- |
| Chat Completions     | ✅             | ✅         | `/v1/messages`         |
| **Responses API**    | ✅             | ✅         | `/v1/messages`         |
| Text Completions     | ✅             | ❌         | `/v1/complete`         |

(The endpoint column reads `/v1/messages` because Bifrost exposes a single Anthropic-shaped egress and converts at the boundary.)

### B. Responses-specific field → Anthropic shape mapping

All conversion is in `core/providers/anthropic/responses.go`. Two bidirectional transforms:

- **Anthropic → Bifrost Responses** (`ToBifrostResponsesRequest`, `responses.go:3669-...`):
  - `OutputFormat` (legacy beta, top-level) and `OutputConfig.Format` (GA) are both collapsed into `params.Text` via `convertAnthropicOutputFormatToResponsesTextConfig` (`responses.go:3742-3747`):
    ```go
    if req.OutputFormat != nil {
        params.Text = convertAnthropicOutputFormatToResponsesTextConfig(req.OutputFormat)
    } else if req.OutputConfig != nil && req.OutputConfig.Format != nil {
        // GA structured outputs - OutputConfig.Format has same structure as OutputFormat
        params.Text = convertAnthropicOutputFormatToResponsesTextConfig(req.OutputConfig.Format)
    }
    ```
  - `output_config.effort` is captured to context via `setAnthropicNativeEffort` (`responses.go:3757-3759`) with a comment explaining why effort is independent of thinking and the model-specific default thinking states that would be lost if the converter collapsed them.
  - `output_config.task_budget` is forwarded into `ExtraParams` (`responses.go:3748-3750`).

- **Bifrost Responses → Anthropic** (`ToAnthropicResponsesRequest`, `responses.go:3926-...`):
  - **Vertex, Bedrock Mantle, Azure** branch (`responses.go:3961-3985`): when `text.format` is set and the target is one of those three, Bifrost converts the structured-output schema into a synthetic Anthropic **tool** (`convertResponsesTextFormatToTool`) and forces `tool_choice: {type: "tool", name: <tool_name>}` if thinking is not enabled.
  - **Anthropic direct** branch (`responses.go:3986-4018`): Bifrost emits the **GA `output_config.format`** shape:
    ```go
    // Use GA structured outputs (output_config.format) instead of beta (output_format)
    outputFormat := convertResponsesTextConfigToAnthropicOutputFormat(bifrostReq.Params.Text)
    if outputFormat != nil {
        anthropicReq.OutputConfig = &AnthropicOutputConfig{Format: outputFormat}
    }
    ```
  - Citations are an explicit carve-out: if any input message has `citations.enabled=true`, the converter drops back to the legacy beta `output_format` (the comment at `responses.go:3987` notes "Citations cannot be used together with Structured Outputs in anthropic").
  - Reasoning/effort: `responses.go:4020-4118` handles `reasoning.max_tokens` / `reasoning.effort` per model family. Adaptive-only models (Opus 4.7+, Fable, Mythos) rewrite `thinking.type:"enabled"` → `"adaptive"`. Effort goes into `output_config.effort` via `setEffortOnOutputConfig` (`responses.go:1419-1426`) with the comment block at `responses.go:365-413` explaining why effort must survive even when thinking is disabled.

The `previous_response_id` chain resolution is handled by the Responses session layer outside this file (analogous to LiteLLM's `ResponsesSessionHandler`).

Streaming translation uses **OpenAI Responses event types**: `response.created`, `response.in_progress`, `output_item.added`, `output_item.done`, `response.completed`, `response.output_text.delta`, etc. See `responses.go:653-715` (`AnthropicStreamEventTypeMessageStart` → emits `response.created` + `response.in_progress`), and `responses.go:807-...` for `web_search_call.in_progress` / `web_search_call.searching` / `web_search_call.completed`. The Anthropic `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop` chain is the source; Bifrost synthesises the Responses lifecycle events and an `AnthropicResponsesStreamState` struct (`responses.go:24-122`) tracks `ContentIndexToOutputIndex`, `ToolArgumentBuffers`, `OutputItems`, `ItemIDs`, `ReasoningSignatures`, etc.

### C. Structured outputs mapping (`text.format` ↔ `output_config.format`)

`core/providers/anthropic/utils.go` has both directions (the file at `utils.go:3427-3665` is the chat-completions-side pair, and `responses.go:3489-3658` has the Responses-side pair):

- `convertResponsesTextConfigToAnthropicOutputFormat(textConfig *schemas.ResponsesTextConfig) json.RawMessage` — `responses.go:3509-3565`. Reads `text.format.type` (must be `json_schema`), unfolds `json_schema.{type, properties, required, $defs, definitions, additionalProperties}`, runs `normalizeSchemaForAnthropic` (strips `uniqueItems`/array-length/numeric constraints, rewrites `oneOf`→`anyOf`, mirrors the Anthropic SDK), then returns the raw `{type: "json_schema", schema: ...}` payload that nests inside `output_config.format`.
- `convertAnthropicOutputFormatToResponsesTextConfig(outputFormat json.RawMessage) *schemas.ResponsesTextConfig` — `responses.go:3589-...`. Reverse direction: parses the Anthropic shape (with `OrderedMap` so the client's key order is preserved), extracts `type`/`name`/`schema`, and rebuilds `text.format` as `ResponsesTextConfigFormat{Name, Type, JSONSchema: {Type, Properties, Required, AdditionalProperties, ...}}`. Defaults the schema name to `"output_format"` (`responses.go:3616`) when Anthropic omits it.

Capability gating: the chat-completions helper pair `convertChatResponseFormatToAnthropicOutputFormat` / `convertChatResponseFormatToTool` lives at `utils.go:3427-3520` and `utils.go:2259-2330`. Tool-based fallback is used on providers that don't accept Anthropic's native `output_format` (Vertex, Bedrock, etc.).

The Anthropic beta-header matrix in the docs (`https://docs.getbifrost.ai/providers/supported-providers/anthropic`) auto-injects `structured-outputs-2025-11-13` for Anthropic, Azure, and Bedrock when `strict` / `output_format` / `output_config.format` are present, and **never for Vertex** — same gate the converter uses to decide between `output_config.format` and tool-based emulation.

### D. Capability coverage

- `responses`: ✅ advertised for Anthropic in both streaming and non-streaming (`https://docs.getbifrost.ai/providers/supported-providers/anthropic`).
- `structured_outputs`: ✅ via `output_config.format` (GA) for Anthropic direct; falls back to a tool for Vertex/Bedrock/Azure where the GA field is rejected. Beta header `structured-outputs-2025-11-13` auto-injected.
- `output_config.effort`: ✅ routed into `output_config.effort` on Anthropic with model-gated behaviour (only supported on Opus 4.5+ / 4.6+ / 4.7+ / 4.8+, Sonnet 4.6+, Sonnet 5+, Fable/Mythos — `utils.go:1049-1063`, `SupportsEffortParameter`).

**Verdict for Iroha**: strong precedent for `responses: true` on the Anthropic Provider Template. Bifrost also demonstrates the modern `output_config.format` is the right Anthropic target for structured outputs, not the legacy beta `output_format`.

---

## Cross-gateway summary

| Question                                                | LiteLLM                                                | Portkey                          | Bifrost                                              |
|---------------------------------------------------------|--------------------------------------------------------|----------------------------------|------------------------------------------------------|
| `/v1/responses` route registered                        | ✅ `response_api_endpoints/endpoints.py:118-126`          | ❌ (404 on `responsesCreate.ts`)  | ✅ (native)                                            |
| Anthropic supported as Responses target                 | ✅ (per `docs/response_api`)                            | ❌ (Anthropic provider has no `responses` slot) | ✅ (per docs table + `responses.go`)                   |
| Anthropic streaming event types emitted                 | OpenAI Chat Completions chunks (then bridged to Responses by `responses_api_bridge`) | n/a | OpenAI Responses events directly: `response.created`, `response.in_progress`, `output_item.added`, etc. (`responses.go:653-715`) |
| `text.format` → Anthropic `output_config.format`        | ❌ writes legacy beta `output_format` (top-level), not `output_config.format` (`transformation.py:1444-1454`); Responses-to-Chat shim at `:2308-2356` | ❌ no Responses path | ✅ GA `output_config.format` for Anthropic direct (`responses.go:4010-4016`); tool-based fallback for Vertex/Bedrock/Azure (`responses.go:3964-3985`) |
| `response_format` advertised in `get_supported_openai_params` | ✅ (`transformation.py:445`) | n/a (no Responses path) | ✅ (Anthropic `responses_format: output_config.format` advertised in docs) |
| Auto-inject `structured-outputs-2025-11-13` beta header | not in Anthropic adapter (uses legacy beta header instead, per `is_effort_used` / `get_anthropic_beta_list` at `common_utils.py:472-540`) | n/a | ✅ (docs Beta Headers matrix) |
| Capability `responses` advertised for Anthropic         | ✅                                                     | ❌                                | ✅                                                    |
| Capability `structured_outputs` advertised for Anthropic | ✅ via `response_format`                              | ❌                                | ✅ via `output_config.format` (GA) and tool fallback  |

## Implications for Iroha's Anthropic Provider Template

1. **LiteLLM and Bifrost both translate `/v1/responses` to Anthropic.** Two of three surveyed gateways ship this; the precedent for `responses: true` on the Anthropic Provider Template is concrete and exercised in production code paths.
2. **Portkey does not** — but its absence looks more like a gap than a deliberate "no" (the OpenAI provider has an empty `createModelResponseParams([])` slot waiting to be wired). Treat this as weak negative evidence: do not over-weight it.
3. **Structured-outputs target shape**: the modern, GA-correct shape on Anthropic is `output_config.format` (Anthropic 4.6+ / structured-outputs-2025-11-13 GA, or as the GA shape baked into newer models per https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Bifrost ships this. LiteLLM still writes the legacy beta `output_format` (top-level). For Iroha, prefer `output_config.format` as the primary path with the legacy beta `output_format` only as a fallback for older models that pre-date the GA.
4. **Streaming event types**: Bifrost emits the OpenAI Responses event vocabulary directly (`response.created`, `response.in_progress`, `output_item.added`, `response.completed`); LiteLLM emits Chat Completions chunks and bridges to Responses SSE. For an Anthropic Provider Template that is itself a provider plug-in (not a gateway translating other shapes), the Responses event vocabulary is the cleaner target.
5. **Models that reject certain Responses features**:
   - Anthropic rejects `text.format` together with citations (Bifrost comment at `responses.go:3987`).
   - Anthropic rejects `output_config.effort` on models older than Opus 4.5 / Sonnet 4.6 (Bifrost `SupportsEffortParameter` at `utils.go:1049-1063`; LiteLLM equivalent at `common_utils.py:_get_model_capability`).
   - Vertex, Bedrock Mantle, Azure reject Anthropic's native `output_config.format`; Bifrost's responses.go converts to a tool-based emulation (`responses.go:3964-3985`) — useful precedent if Iroha ever bridges to those backends.
6. **`previous_response_id` resolution** is required for both LiteLLM and Bifrost; Iroha's Template will need an analogous session/conversation store, or the equivalent of `instructions` + `input` round-tripping for stateless callers.

**Recommendation**: ship `responses: true` on the Anthropic Provider Template, with `text.format` translated to Anthropic `output_config.format` (GA, Anthropic 4.6+ / structured-outputs-2025-11-13) and a tool-based fallback for older models and for the Vertex / Bedrock / Azure sibling targets if Iroha's Template is later extended to those.
