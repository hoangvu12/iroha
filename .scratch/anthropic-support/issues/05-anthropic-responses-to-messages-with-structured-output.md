# 05 — `/v1/responses` → `/v1/messages` with structured output

**What to build:** An OpenAI Responses client calls `POST /v1/responses` against an Anthropic Provider. Structured output (`response_format` or `text.format`) translates to Anthropic's `output_config.format` (GA, with the legacy beta `output_format` as the fallback for older models). Streaming emits OpenAI Responses SSE events (`response.created`, `response.in_progress`, `output_item.added`, `response.output_text.delta`, `response.completed`, etc.).

**Blocked by:** 01 (adapter skeleton), 03 (tools handling).

**Status:** ready-for-agent

- [ ] OpenAI Responses request body translates to Anthropic `messages` shape: `instructions` becomes the top-level `system` field; `input` (string or `Message[]` array) becomes `messages[]`; `parallel_tool_calls` inverts to `disable_parallel_tool_use`.
- [ ] `previous_response_id` surfaces as a documented `previous_response_id_unsupported` 400 error in v1; resolving to conversation history is out of scope until a session layer ships.
- [ ] OpenAI `text.format` (Responses) and `response_format` (Chat Completions) translate to Anthropic `output_config.format: {type: "json_schema", schema: {...}}` for Claude 4.6+ / Opus 4.5+ / Sonnet 5+ models and any model with the `structured-outputs-2025-11-13` GA shape. The legacy beta `output_format` (top-level) is the fallback for older models. The beta header is auto-injected when either is in use.
- [ ] Schema keywords Anthropic rejects (`uniqueItems`, `minItems`/`maxItems`, `minLength`/`maxLength`, `minimum`/`maximum`, `if`/`then`/`else`/`not`, `oneOf` rewritten to `anyOf`) are stripped or rewritten before upstream, mirroring Anthropic's documented JSON-Schema subset.
- [ ] Anthropic response translates back to OpenAI Responses response shape with `output` items (`output_text`, `function_call` items), `usage` (with cache token mirrors), and `status` derived from `stop_reason`.
- [ ] Streaming emits OpenAI Responses SSE events: `response.created`, `response.in_progress`, `output_item.added`, `response.output_text.delta`, `response.completed`. The Anthropic SSE chain (`message_start` → `content_block_*` → `message_delta` → `message_stop`) is the source; per-stream state maps Anthropic content-block indices to OpenAI Responses output-item indices.
- [ ] Conformance tests in `test/http/inference-anthropic-responses.test.ts` with structured-output fixtures covering: chat completions `response_format` (json_schema, with strict and without), responses `text.format` (json_schema), non-streaming and streaming modes, schema-keyword sanitisation, and the legacy-beta fallback path for an older mock model.