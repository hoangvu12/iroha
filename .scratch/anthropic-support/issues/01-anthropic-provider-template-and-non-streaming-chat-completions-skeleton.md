# 01 — Anthropic Provider Template + non-streaming Chat Completions skeleton

**What to build:** The Owner picks the `anthropic` Provider Template from the templates picker, configures one Upstream Key, and an OpenAI client calling `POST /v1/chat/completions` against the resulting Provider with a text-only message receives an OpenAI-shaped response. The adapter translates the OpenAI-shape request to Anthropic-shape, calls the upstream, translates the Anthropic-shape response back to OpenAI-shape, and emits the OpenAI-shape response. The rest of the adapter surface (streaming, tools, `/v1/messages`, `/v1/responses`) is added by later tickets.

**Blocked by:** None — can start immediately.

**Status:** done

- [x] `anthropic` entry added to `src/providers/templates.ts` with all five capabilities (`chat`, `streaming`, `tools`, `structuredOutput`, `responses`) set to `true`, base URL `https://api.anthropic.com/v1`, auth header `x-api-key` with empty prefix, and a `knownModels` list covering the current Anthropic Model enum.
- [x] `AnthropicInferenceAdapter` exported from `src/inference/anthropic-adapter.ts` and registered in `AdapterRegistry` at a stable id (`anthropic-inference-adapter`), bound to the `anthropic` template's `inferenceAdapterId`.
- [x] `AnthropicInferenceAdapter.forward()` handles non-streaming text-only Chat Completions: hoists `system` messages to the top-level `system` field, defaults `max_tokens` via a per-model table with a `DEFAULT_ANTHROPIC_MAX_TOKENS = 4096` fallback, injects `x-api-key: <key>` and `anthropic-version: 2023-06-01` (or the caller's `anthropic-version` header value if present) headers, builds the Anthropic `/v1/messages` request body, calls the upstream, parses the Anthropic response, and emits an OpenAI-shape response with `id`, `choices[]`, `usage`.
- [x] Stop reason mapping: Anthropic `end_turn` / `stop_sequence` → OpenAI `stop`; `max_tokens` → `length`; `refusal` → `content_filter`.
- [x] Usage field translation: Anthropic `input_tokens` → OpenAI `prompt_tokens`; `output_tokens` → OpenAI `completion_tokens`; `cache_creation_input_tokens` + `cache_read_input_tokens` → `prompt_tokens_details.cached_tokens` plus the `cache_creation_input_tokens` / `cache_read_input_tokens` mirrors; `output_tokens_details.thinking_tokens` → `completion_tokens_details.reasoning_tokens`.
- [x] Error envelope mapping: Anthropic `{type, error: {type, message}, request_id}` → OpenAI `{error: {message, type, code, param}}` with the upstream status preserved and the existing Iroha error envelope wrapping.
- [x] Conformance test in `test/http/inference-anthropic-non-streaming.test.ts` using the assembled HTTP seam with a mock Anthropic upstream proves the non-streaming text-only round-trip (request translation, headers, response translation, usage fields, stop reason).
- [x] Existing tests (`test/http/inference-*.test.ts`) still pass; no Generic OpenAI provider test regressions.

## Comments

- The HTTP route now picks the per-Provider Inference Adapter by consulting
  the Adapter Registry against the connection's `templateId`. The dispatch
  falls back to the single `inference` option the route was assembled with
  when no registry is supplied (preserves single-adapter callers), and to the
  generic adapter when a template names an unknown id.
- The two pre-existing streaming tests in `test/http/inference-streaming-
  chat-completions.test.ts` (lines 196 and 276) fail on `main` without
  these changes; the failure is unrelated to this ticket.