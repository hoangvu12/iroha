# 04 — `/v1/messages` Anthropic-compatible public surface

**What to build:** An Anthropic SDK calls `POST /providers/{connection_id}/v1/messages` against any Provider. Against an Anthropic Provider: passthrough (request body and SSE events forwarded verbatim). Against an OpenAI-shaped Provider: request body translated to OpenAI-shape using the inverse of the same round-trip, response translated back to Anthropic-shape, SSE event translation preserved. Error envelope shape follows the caller.

**Blocked by:** 01 (adapter skeleton), 02 (streaming transform).

**Status:** ready-for-agent

- [ ] `POST /providers/{connection_id}/v1/messages` route registered in `src/http/inference.ts`; the connection id resolves to a Provider Connection; Gateway Key authentication, CORS handling, request metadata, and rate-limit behaviour match the existing `/v1/chat/completions` route.
- [ ] When the Provider Connection's adapter is `AnthropicInferenceAdapter` (i.e. the `anthropic` template): the request body is forwarded verbatim to the upstream `/v1/messages` URL; SSE events are forwarded verbatim; the error envelope is preserved as Anthropic-shape.
- [ ] When the Provider Connection's adapter is the generic OpenAI adapter (any other built-in template): the request body is translated from Anthropic-shape to OpenAI-shape using the inverse of the round-trip defined in tickets 01–03 (top-level `system` → system message, `tool_use` → `assistant.tool_calls`, `tool_result` blocks → `tool` messages, `output_config.format` → `response_format`, `cache_control` and `thinking` blocks preserved as unknown JSON passthrough); the upstream is called with OpenAI-shape; the OpenAI-shape response is translated back to Anthropic-shape.
- [ ] SSE event translation preserves Anthropic event ordering: `message_start` first, `content_block_*` per block, `message_delta` carrying final `stop_reason` and usage, `message_stop` last; `ping` events dropped; mid-stream errors surface as `event: error` with the Anthropic envelope.
- [ ] Error envelope shape follows the caller: Anthropic-shape caller gets `{type: "error", error: {type, message}, request_id}` with the upstream status preserved; OpenAI-shape caller (when routed to an OpenAI Provider) gets the OpenAI envelope.
- [ ] Conformance tests in `test/http/inference-anthropic-v1-messages.test.ts` for both directions: (a) Anthropic Provider passthrough, including streaming; (b) OpenAI Provider translation, including streaming and a tool-calling round-trip; (c) error envelope propagation.