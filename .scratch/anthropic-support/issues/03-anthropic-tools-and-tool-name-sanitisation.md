# 03 — Tools and tool-name sanitisation for an Anthropic Provider

**What to build:** An OpenAI client sends tool definitions and tool results to an Anthropic Provider and receives `tool_calls` back. Tool names that violate Anthropic's `^[a-zA-Z0-9_-]{1,128}$` regex (common for MCP-generated or OpenAPI-generated tool catalogs) are sanitized for upstream and restored for the response, so the caller sees the names they sent. Streaming partial-JSON tool arguments accumulate into the OpenAI `tool_calls[].function.arguments` field.

**Blocked by:** 01 — Anthropic Provider Template + non-streaming Chat Completions skeleton.

**Status:** ready-for-agent

- [ ] `tool_choice` mapping implemented: OpenAI `"auto"` → Anthropic `{type: "auto"}`; `"required"` → `{type: "any"}`; `"none"` → `{type: "none"}`; `{type: "function", function: {name: ...}}` → `{type: "tool", name: ...}`. OpenAI `parallel_tool_calls: true` inverts to Anthropic `disable_parallel_tool_use: false`; the inverse flag for `parallel_tool_calls: false`.
- [ ] Tool-name sanitiser walks every `tools[].function.name` in the request; names violating `^[a-zA-Z0-9_-]{1,128}$` are rewritten to a sanitized form (e.g. `get.weather` → `get_weather`, `ns:method` → `ns_method`, `tool name with space` → `tool_name_with_space`); a per-request forward map records each transformation.
- [ ] Tool results from the caller (`role: "tool"` messages with `tool_call_id` and `content`) translate to Anthropic user-message `tool_result` blocks with the matching `tool_use_id`.
- [ ] Tool calls from the model (Anthropic `tool_use` content blocks with `id`, `name`, `input`) translate back to OpenAI `tool_calls[]` with `id`, `type: "function"`, `function: {name, arguments}`. The reverse map restores the original tool name (the caller sees the name they sent).
- [ ] Tool IDs (`tool_call_id` ↔ `tool_use_id`) pass through unchanged on the wire. The character sets are compatible.
- [ ] Streaming `input_json_delta` events accumulate into the OpenAI tool call's `arguments` field; the final `content_block_stop` closes the tool call and (if Anthropic emitted a tool_use with empty input) emits an empty-args tool call so the caller never sees a half-formed tool definition.
- [ ] Conformance test in `test/http/inference-anthropic-tools.test.ts` with fixtures covering clean tool names, three sanitisation cases (`dot`, `colon`, `space`), tool result round-trip, streaming tool-call accumulation, and empty-args tool_use proves the round-trip end-to-end.