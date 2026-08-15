Status: ready-for-agent

# Anthropic support in Iroha

## Problem Statement

The Owner uses OpenAI-shaped AI clients and Anthropic-shaped AI clients against the same Provider pool. Today Iroha only exposes OpenAI-shaped routes, so an Anthropic SDK target cannot reach an Iroha-routed Provider at all, and an OpenAI-shaped client cannot reach an Anthropic Provider without the Owner wiring a translation proxy in front.

The Owner wants one self-hosted gateway that handles both shapes. An OpenAI client with `base_url: https://iroha/providers/{id}/v1` should be able to reach an Anthropic Provider transparently — Iroha translates OpenAI-shape to Anthropic-shape on the way upstream and back on the way down. An Anthropic client with `base_url: https://iroha/providers/{id}/v1` should reach an Anthropic Provider without translation, and an OpenAI-shaped Provider with the same adapter inverting the round-trip. The Owner should not have to maintain a separate proxy for either shape.

The current v1 spec at `.scratch/iroha-v1/spec.md` (previously line 191) lists "Anthropic-compatible public endpoints or automatic translation from Anthropic requests" as out of scope. This feature lifts that exclusion. Provider-as-Anthropic was not explicitly excluded; only the Anthropic-shape public surface was.

## Solution

Add Anthropic as a first-class Provider in Iroha: a typed `AnthropicInferenceAdapter` that owns the OpenAI ↔ Anthropic round-trip, a built-in `anthropic` Provider Template that ships with sane defaults, and a new `POST /providers/{connection_id}/v1/messages` public surface that allows Anthropic-native SDKs to call Iroha.

The new adapter is the only place that knows Anthropic's wire format. The HTTP route layer decides which caller shape it received and asks the adapter to translate in the matching direction. The generic Inference Adapter stays unchanged.

The OpenAI-compatible surface, the model catalog, the capability matrix, the Inference Adapter contract, the round-robin key selector, and the retry/Key Health pipeline all stay as they are. The new adapter plugs into the existing pipe at the same seam as the generic adapter.

The Provider Template file (`src/providers/templates.ts`) gains one entry. The Adapter Registry (`src/providers/adapter-registry.ts`) gains one typed Inference Adapter. The HTTP route map (`src/http/inference.ts`) gains one new address. The conformance gate (`.scratch/iroha-v1/issues/18`) extends to cover the new surface.

## User Stories

1. As the Owner, I want to create an Anthropic Provider Connection from a built-in template, so that I can configure my Anthropic API key without filling advanced fields.
2. As the Owner, I want my OpenAI-shaped client to reach an Anthropic Provider via Iroha transparently, so that I do not run a separate translation proxy.
3. As the Owner, I want my Anthropic-shaped SDK to reach an Anthropic Provider via Iroha, so that I keep using my existing Claude Code and Anthropic SDK workflows.
4. As the Owner, I want my Anthropic-shaped SDK to reach an OpenAI-shaped Provider via Iroha, so that I can mix Anthropic-formatted clients with non-Anthropic Providers.
5. As an application developer, I want streaming responses preserved end-to-end when the target is Anthropic and the caller is Anthropic, so that I see the same SSE events I would see calling Anthropic directly.
6. As an application developer, I want streaming responses translated to OpenAI's chunk shape when the target is Anthropic and the caller is OpenAI, so that my OpenAI SDK accepts every event.
7. As an application developer, I want tool calls and tool results to round-trip between OpenAI and Anthropic shapes, so that tool-using agents work the same way against either Provider.
8. As an application developer, I want extended-thinking blocks and Anthropic `cache_control` blocks preserved through Iroha, so that I can use Anthropic's reasoning and caching features.
9. As the Owner, I want invalid-tool-name errors from Anthropic to be caught and the name rewritten for upstream, so that MCP-generated and OpenAPI-generated tool catalogs work without my pre-cleaning every name.
10. As the Owner, I want the round-trip to log the actual upstream latency and status, so that I can diagnose Anthropic Provider failures the same way I diagnose OpenAI ones.
11. As the Owner, I want the Anthropic Provider's key test to remain a low-cost HTTP call, so that adding keys stays fast and free.
12. As the Owner, I want the existing five capability flags (`chat`, `streaming`, `tools`, `structuredOutput`, `responses`) to advertise truthfully on the Anthropic template, so that I do not have to discover which routes work at first call time.
13. As the Owner, I want Iroha's per-connection timeouts to apply to Anthropic Provider calls, so that I do not silently retry past Anthropic's capacity cutoff.
14. As the Owner, I want Anthropic 4xx errors translated to OpenAI-shaped envelopes when the caller is OpenAI, and Anthropic-shaped envelopes when the caller is Anthropic, so that my client's error handler does the right thing.
15. As the Owner, I want the same rate-limit scope classification (key, account, model, provider, unknown) to apply to Anthropic responses, so that rotation and cooldown behavior is consistent.

## Implementation Decisions

- **Anthropic Inference Adapter owns the round-trip.** A new typed `AnthropicInferenceAdapter` at `src/inference/anthropic-adapter.ts` is the single source of truth for Anthropic-specific behavior. It implements the existing `InferenceAdapter` contract (`src/inference/adapter.ts:87-91`). The generic Inference Adapter, the `InferenceAdapterCapabilities` shape, and the HTTP route layer (`src/http/inference.ts`) stay unchanged. We rejected a separate translator module (duplicates streaming and tool-translation logic across modules), extending the Inference Adapter contract (every future adapter would have to declare which caller shapes it accepts), and reusing the generic adapter (it cannot speak Anthropic). Full architectural decision at `docs/adr/0010-anthropic-inference-adapter-owns-round-trip.md`.

- **`/v1/messages` is an Anthropic-compatible public surface.** `POST /providers/{connection_id}/v1/messages` accepts Anthropic-shape bodies, streams Anthropic SSE events, and returns Anthropic-shape errors. When the Provider Connection points at Anthropic, the adapter passes the body through to the upstream URL and streams the response back. When the Provider Connection points at an OpenAI-shaped Provider, the adapter translates the Anthropic-shape request to OpenAI-shape using the inverse of the same round-trip, calls the upstream with OpenAI-shape, and translates the response back to Anthropic-shape. The route is `Provider`-scoped, never unscoped, matching ADR-0001. We rejected refusing `/v1/messages` against non-Anthropic Providers (makes the route useless for Owners with OpenAI-compatible Providers), per-Provider opt-in (adds configuration surface for no benefit), and unscoped `/v1/messages` (collides with ADR-0001's provider-scoped addressing). Full architectural decision at `docs/adr/0011-anthropic-compatible-v1-messages-surface.md`.

- **Anthropic Provider Template ships with all five capabilities.** The new `anthropic` entry in `src/providers/templates.ts` sets `chat`, `streaming`, `tools`, `structuredOutput`, and `responses` to `true`. The adapter translates OpenAI `request_format` / `text.format` to Anthropic's `output_config.format` (GA, modeled on Bifrost's `responses.go:4010-4016`); the legacy beta `output_format` is the fallback for older models. We rejected conservative defaults (`responses: false` because Anthropic lacks a Responses endpoint — but the adapter translates at the boundary, so the route is reachable), extending the capability matrix with Anthropic-specific fields (deferred — unknown JSON fields are already preserved at the passthrough boundary per `docs/capability-matrix.md:20`), and matching the OpenAI template by accident (the precedent is identical surface area, not coincidence). Full architectural decision at `docs/adr/0012-anthropic-provider-template-mirrors-openai.md`.

- **System hoisting: OpenAI `role: "system"` → Anthropic top-level `system`.** The adapter walks `messages[]`, pulls every entry with `role: "system"` and converts each to a `[{type: "text", text, cache_control?}]` block in the top-level `system` array. Empty text blocks are skipped (Anthropic rejects them). The original `messages[]` is left contiguous after the pops. Mirrors LiteLLM (`litellm/llms/anthropic/chat/transformation.py:1607-1661`) and Portkey (`src/providers/anthropic/chatComplete.ts:284-316`).

- **`max_tokens` defaulting: per-model with a 4096 fallback.** A `getMaxTokensForModel(model)` function returns the model's published maximum from a hardcoded table covering Claude 4.5/4.6/4.7/4.8, Opus 5, Sonnet 5, Haiku 4.5, and Fable/Mythos models. Unknown models fall back to a `DEFAULT_ANTHROPIC_MAX_TOKENS = 4096` constant. Mirrors LiteLLM (`litellm/llms/anthropic/chat/transformation.py:269-274`).

- **Tool ID reconciliation: identity on the wire.** `tool_use_id` and `tool_call_id` are passed through unchanged. Both ID character sets satisfy Anthropic's `^[a-zA-Z0-9_-]+$` constraint, so no transform is needed. Mirrors LiteLLM, Portkey, and Bifrost.

- **Tool-name sanitisation with forward/reverse map.** Tool names that violate `^[a-zA-Z0-9_-]{1,128}$` are sanitized to a transformed name (e.g. `get.weather` → `get_weather`) on the request side; a per-request forward map records the transformation. On the response side (Anthropic `tool_use` → OpenAI `tool_calls`), the reverse map restores the original name so the caller sees the tool they sent. Mirrors LiteLLM (`litellm/llms/anthropic/chat/transformation.py:1014-1074`) and Bifrost.

- **`tool_choice` mapping: OpenAI ⇄ Anthropic vocabulary.** OpenAI `"auto"` → Anthropic `{type: "auto"}`; OpenAI `"required"` → Anthropic `{type: "any"}`; OpenAI `"none"` → Anthropic `{type: "none"}`; OpenAI `{type: "function", function: {name: ...}}` → Anthropic `{type: "tool", name: ...}`. OpenAI `parallel_tool_calls: true` is inverted to Anthropic `disable_parallel_tool_use: false`. Mirrors LiteLLM (`litellm/llms/anthropic/chat/transformation.py:615-654`).

- **Streaming: SSE event-by-event translation.** The adapter parses Anthropic's named SSE events (`message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error`) and emits OpenAI Chat Completions chunks. The per-stream state object tracks `currentContentBlockType`, `currentContentBlockIndex`, `currentToolIndex`, `currentToolName`, accumulated `text`, `toolInputJson`, and `usage`. The `message_start` usage and the `message_delta` usage are merged at stream end; OpenAI clients see usage exactly once, on the final chunk. Mirrors LiteLLM's `ModelResponseIterator.chunk_parser` (`litellm/llms/anthropic/chat/handler.py:410-606`).

- **Stop reason mapping.** Anthropic `end_turn` / `stop_sequence` → OpenAI `stop`; Anthropic `max_tokens` → OpenAI `length`; Anthropic `tool_use` → OpenAI `tool_calls`; Anthropic `refusal` → OpenAI `content_filter`; Anthropic `compaction` → OpenAI `length` (LiteLLM convention). Mirrors `litellm/litellm_core_utils/core_helpers.py:99-141`.

- **Usage field translation.** Anthropic `input_tokens` → OpenAI `prompt_tokens`; Anthropic `output_tokens` → OpenAI `completion_tokens`; Anthropic `cache_creation_input_tokens` + `cache_read_input_tokens` → OpenAI `prompt_tokens_details.cached_tokens` (with `cache_creation_input_tokens` and `cache_read_input_tokens` surfaced as the Iroha-specific `cache_creation_input_tokens` / `cache_read_input_tokens` mirrors for parity). Anthropic `output_tokens_details.thinking_tokens` → OpenAI `completion_tokens_details.reasoning_tokens`. Mirrors LiteLLM (`litellm/llms/anthropic/chat/transformation.py:2120-2230`) and Portkey (`src/providers/anthropic/chatComplete.ts:317-385`).

- **Error envelope shape by caller.** When the caller's request is OpenAI-shape, errors are returned in the OpenAI envelope (`{error: {message, type, code, param}}`). When the caller's request is Anthropic-shape, errors are returned in the Anthropic envelope (`{type: "error", error: {type, message}, request_id}`). Mid-stream Anthropic `error` events are surfaced as a final OpenAI chunk with `finish_reason: error.type` followed by `data: [DONE]`. Mirrors Portkey's `AnthropicErrorResponseTransform` (`src/providers/anthropic/utils.ts:5-13`) and LiteLLM's `ANTHROPIC_ERROR_TYPE_MAP` (`litellm/anthropic_interface/exceptions/exception_mapping_utils.py:27-36`).

- **`anthropic-version` from caller, fall back to `2023-06-01`.** Anthropic SDKs send `anthropic-version: <date>` on every request. The adapter prefers the caller's header when present (caller's intent is authoritative); otherwise it injects the hardcoded `2023-06-01` default. Same logic for `anthropic-beta`: comma-join with the caller's value if present, else omit. No Provider Connection field, no UI exposure. Mirrors LiteLLM's per-request override (`anthropic_version=` kwarg in `litellm/llms/anthropic/common_utils.py:368`).

- **Authentication: `x-api-key` for Anthropic-native keys, `Authorization: Bearer` for OAuth.** Anthropic Console keys (`sk-ant-...`) are sent as `x-api-key: <key>`. OAuth tokens (`sk-ant-oat...`) are sent as `Authorization: Bearer <token>` plus the `oa-2025-04-20` beta header. Mirrors LiteLLM's `optionally_handle_anthropic_oauth` (`litellm/llms/anthropic/common_utils.py:69-97`).

- **Cache breakpoints clamped to 4.** Anthropic enforces a hard limit of 4 cache breakpoints per request. The adapter walks the request and clears the earliest breakpoint when the cap is exceeded. Mirrors Bifrost's `clampAnthropicCacheBreakpoints` (`core/providers/anthropic/utils.go`).

- **Unknown JSON fields forwarded at the passthrough boundary.** Both `cache_control` and `thinking` blocks (and every other Anthropic-specific field not actively translated) are preserved end-to-end. The existing commitment at `docs/capability-matrix.md:20` ("unknown JSON fields are preserved at the passthrough boundary") is upheld by the Anthropic adapter.

- **The model catalog for an Anthropic Provider uses `GET /v1/models` with `x-api-key` + `anthropic-version`.** Anthropic's models endpoint is OpenAI-shaped (`{data: [{id, ...}, ...]}`), so the generic catalog sync works as-is. The build-known-models list includes the current `Model` enum from the Anthropic TypeScript SDK (`anthropic-opus-5`, `anthropic-sonnet-5`, `anthropic-fable-5`, `anthropic-mythos-5`, `anthropic-opus-4-8`, `anthropic-opus-4-7`, `anthropic-mythos-preview`, `anthropic-opus-4-6`, `anthropic-sonnet-4-6`, `anthropic-haiku-4-5`, `anthropic-haiku-4-5-20251001`, `anthropic-opus-4-5`, `anthropic-opus-4-5-20251101`, `anthropic-sonnet-4-5`, `anthropic-sonnet-4-5-20250929`).

- **The Provider key test uses the generic OpenAI-compatible probe.** `/v1/models` is OpenAI-shaped on Anthropic's side, so the existing `createGenericKeyProbe` (`src/providers/key-probe.ts`) works. The key test sends `x-api-key: <key>` plus `anthropic-version: 2023-06-01`. The verdict classification is unchanged: 2xx = usable, 401 = rejected, anything else = inconclusive.

- **The capability graph is not extended.** New slots such as `thinking`, `cache_control`, `documents`, `image_input`, `pdf_input`, `structured_outputs` (Anthropic name), and `effort` are not added to the matrix. The matrix stays at the existing six flags. The Anthropic adapter forwards these fields as unknown JSON passthrough. A future spec (v2) can extend the matrix when there is evidence that Owners need first-class visibility into which Anthropic features are supported.

- **No new Pure Adapter-shared logic.** The Anthropic adapter does not extract `translateSystemMessage`, `mapToolChoice`, `mapStopReason`, or any other helper into a shared module. OpenAI-shape ↔ Anthropic-shape translation is monotone (Anthropic has its own vocabulary) and reusing helpers across adapters invites accidental coupling. The round-trip belongs in one file.

- **No new database migrations.** The Anthropic Provider uses the existing `providers` table; no new column. The capability defaults are encoded in the `anthropic` template entry, not in the schema.

- **The implementation lives in iroha, not in nyanis.** Provider-specific knowledge may be implemented separately (per `PRODUCT.md:39`); iroha does not read nyanis's database or reuse nyanis-discovered credentials.

## Testing Decisions

- The Anthropic adapter is exercised through the assembled Elysia `fetch` interface. The primary seam is the same HTTP seam used by every existing conformance test (`test/http/inference-*.test.ts`).
- Mock upstream scenarios cover the full Anthropic surface: success, malformed responses, delayed headers, stalled streams, disconnects, timeouts, cancellation, `400`, `401`, ambiguous `403`, confirmed quota exhaustion, key/account/unknown `429`, retryable `5xx`, redirects, and secret-bearing upstream messages — exactly the set already covered by the v1 conformance gate (`issues/18`).
- Streaming tests assert the OpenAI chunk shape against a mock Anthropic SSE stream. The four event-order invariants (one `message_start`, one `content_block_stop` per block, one `message_delta` before `message_stop`, terminating `message_stop`) are explicit test cases.
- Tool-name sanitisation has a dedicated test fixture covering `get.weather`, `ns:method`, `tool name with space`, and a clean pass-through case.
- The `/v1/messages` route has symmetric tests for both directions: (1) Anthropic Provider → Anthropic-shape response, (2) OpenAI Provider → Anthropic-shape response translated from OpenAI-shape.
- The conformance gate (`.scratch/iroha-v1/issues/18`) extends to include Anthropic-specific items; the new gate is recorded as `.scratch/anthropic-support/issues/07-anthropic-conformance-tests.md`.
- The official Anthropic TypeScript SDK (`anthropics/anthropic-sdk-typescript`) is exercised against iroha's `/v1/messages` route with a mock upstream, matching the existing OpenAI SDK conformance test pattern.
- All transport, time, randomness, and cryptography are injected at the composition boundary. Production defaults are not patched globally in tests.
- No required test calls a real Provider or uses a real Provider credential.

## Out of Scope

- Embeddings, images, audio, moderation, files, batches, vector stores, and other OpenAI or Anthropic endpoints beyond Models, Chat Completions, Responses, and Messages.
- Tool-search, code-execution, web-search, web-fetch, bash, and text-editor Anthropic built-in tools. The adapter forwards the input shape but does not synthesize content for these tools.
- Extended-thinking `output_config.effort` translation. The adapter passes `output_config` through; per-model effort gating is deferred.
- Computer-use, prompt-caching Anthropic beta headers beyond `structured-outputs-2025-11-13` (auto-injected when `output_config.format` is present). The adapter forwards other `anthropic-beta` headers from the caller.
- Anthropic Converse API (AWS Bedrock Mantle). The Anthropic Provider targets Anthropic's first-party `/v1/messages` endpoint only.
- Per-Provider `anthropic-version` and `anthropic-beta` configuration fields. The hardcoded `2023-06-01` default and the caller's header are the only sources.
- Anthropic usage polling. The Anthropic Provider has no Usage Adapter in v1; balance is reported as Unknown (reactive-only).
- A capability extension for Anthropic-specific features (thinking, cache_control, documents, image_input, pdf_input, structured_outputs, effort). The capability matrix stays at the existing six flags.
- Migrating from a v1 install that does not have Anthropic support. The Anthropic Provider Template is added to the built-in set; no migration is required.

## Further Notes

- `CONTEXT.md` is updated so the **Gateway** term describes the two surface shapes under the provider-scoped prefix. The existing Inference Adapter and Provider Template concepts absorb the new `Anthropic` instances.
- Three ADRs govern the architectural decisions: `0010-anthropic-inference-adapter-owns-round-trip.md`, `0011-anthropic-compatible-v1-messages-surface.md`, `0012-anthropic-provider-template-mirrors-openai.md`.
- The implementation work is broken into seven issues under `.scratch/anthropic-support/issues/`, ordered for the conformance gate to pass in dependency order: 01 the typed adapter file, 02 the streaming translate, 03 the tool-name sanitiser, 04 the `/v1/messages` route, 05 the `response_format` ↔ `output_config.format` bridge, 06 the built-in Provider Template, 07 the conformance tests.
- Research records at `docs/research/anthropic-api.md` (Anthropic API reference), `docs/research/anthropic-gateway-implementations.md` (LiteLLM / Portkey / Bifrost / OpenRouter / Cloudflare behaviour with file:line citations), and `docs/research/anthropic-responses-and-structured-outputs.md` (`/v1/responses` target behaviour and structured-outputs mapping) are the working evidence for this spec.
- The Owner UI gains one new template entry in the Provider Connection picker. The form defaults are taken from the template; existing fields cover everything Anthropic needs today. No new Provider fields are added.
