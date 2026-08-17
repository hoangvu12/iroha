# 03 — Tools and tool-name sanitisation for an Anthropic Provider

**What to build:** An OpenAI client sends tool definitions and tool results to an Anthropic Provider and receives `tool_calls` back. Tool names that violate Anthropic's `^[a-zA-Z0-9_-]{1,128}$` regex (common for MCP-generated or OpenAPI-generated tool catalogs) are sanitized for upstream and restored for the response, so the caller sees the names they sent. Streaming partial-JSON tool arguments accumulate into the OpenAI `tool_calls[].function.arguments` field.

**Blocked by:** 01 — Anthropic Provider Template + non-streaming Chat Completions skeleton.

**Status:** done

- [x] `tool_choice` mapping implemented: OpenAI `"auto"` → Anthropic `{type: "auto"}`; `"required"` → `{type: "any"}`; `"none"` → `{type: "none"}`; `{type: "function", function: {name: ...}}` → `{type: "tool", name: ...}`. OpenAI `parallel_tool_calls: true` inverts to Anthropic `disable_parallel_tool_use: false`; the inverse flag for `parallel_tool_calls: false`.
- [x] Tool-name sanitiser walks every `tools[].function.name` in the request; names violating `^[a-zA-Z0-9_-]{1,128}$` are rewritten to a sanitized form (e.g. `get.weather` → `get_weather`, `ns:method` → `ns_method`, `tool name with space` → `tool_name_with_space`); a per-request forward map records each transformation.
- [x] Tool results from the caller (`role: "tool"` messages with `tool_call_id` and `content`) translate to Anthropic user-message `tool_result` blocks with the matching `tool_use_id`.
- [x] Tool calls from the model (Anthropic `tool_use` content blocks with `id`, `name`, `input`) translate back to OpenAI `tool_calls[]` with `id`, `type: "function"`, `function: {name, arguments}`. The reverse map restores the original tool name (the caller sees the name they sent).
- [x] Tool IDs (`tool_call_id` ↔ `tool_use_id`) pass through unchanged on the wire. The character sets are compatible.
- [x] Streaming `input_json_delta` events accumulate into the OpenAI tool call's `arguments` field; the final `content_block_stop` closes the tool call and (if Anthropic emitted a tool_use with empty input) emits an empty-args tool call so the caller never sees a half-formed tool definition.
- [x] Conformance test in `test/http/inference-anthropic-tools.test.ts` with fixtures covering clean tool names, three sanitisation cases (`dot`, `colon`, `space`), tool result round-trip, streaming tool-call accumulation, and empty-args tool_use proves the round-trip end-to-end.

## Comments

- The forward map (original → sanitized) is computed by
  `sanitizeToolsList`; the adapter inverts it once per request and passes
  the reverse map to both the buffered and streaming response paths.
- `tool_choice` is nested under its own key on Anthropic's side, while
  `disable_parallel_tool_use` is a top-level field on the Messages
  request body. Both shapes are accepted by Anthropic; the adapter
  matches Anthropic's contract rather than OpenAI's.
- `finish_reason` is forced to `tool_calls` when the response carries
  one or more `tool_use` blocks even when the upstream reported
  `stop_reason: end_turn`, so an OpenAI SDK treats the response as a
  tool call and not as a normal stop.
- The assistant message's `tool_calls` field is intentionally dropped
  today (the adapter copies only `role` and `content`); translating
  `assistant.tool_calls` → Anthropic's `assistant.tool_use` blocks is
  deferred to a later ticket so this one stays narrowly scoped.