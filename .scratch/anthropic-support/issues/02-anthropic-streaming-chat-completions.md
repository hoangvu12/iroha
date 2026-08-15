# 02 — Streaming Chat Completions against an Anthropic Provider

**What to build:** An OpenAI client calling `POST /v1/chat/completions` against an Anthropic Provider with `stream: true` receives OpenAI SSE chunks (`chat.completion.chunk` events with a `data: [DONE]` sentinel). The adapter parses Anthropic's named SSE events and emits OpenAI-shaped chunks one-for-one. Non-streaming behaviour from ticket 01 is unchanged.

**Blocked by:** 01 — Anthropic Provider Template + non-streaming Chat Completions skeleton.

**Status:** ready-for-agent

- [ ] `AnthropicInferenceAdapter.forward()` returns an `InferenceStreamResult` (a `ReadableStream<Uint8Array>` plus the upstream status and headers) when the caller sets `stream: true`; non-streaming behaviour remains as in ticket 01.
- [ ] Adapter parses Anthropic named SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`) and emits OpenAI `chat.completion.chunk` SSE chunks with `data: {…}` lines per OpenAI SDK expectation, terminating with `data: [DONE]`.
- [ ] Per-stream state object tracks `currentContentBlockType`, `currentContentBlockIndex`, `currentToolIndex`, accumulated text, accumulated tool input JSON, model id, message id, and usage. State is keyed by request id so concurrent streams do not cross-contaminate.
- [ ] Usage from `message.message.usage` (in `message_start`) and `message_delta.usage` are merged and emitted exactly once, on the final chunk's `usage` field. No double-emission on retry or finalisation.
- [ ] Anthropic `error` event surfaces as an OpenAI chunk with `finish_reason` set to the Anthropic `error.type`, followed by `[DONE]`.
- [ ] `ping` events are dropped; `content_block_stop` events are dropped (no OpenAI-shape equivalent).
- [ ] Streaming conformance test in `test/http/inference-anthropic-streaming.test.ts` with a mock Anthropic SSE stream (full event chain: text-only, tool-call, multi-block, refusal, mid-stream `error`) proves the event translation, the per-event chunk ordering, the final `[DONE]` sentinel, and the single-emit usage invariant.
- [ ] Existing non-streaming tests from ticket 01 still pass.