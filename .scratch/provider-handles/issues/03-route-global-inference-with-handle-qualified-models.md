# 03 — Route global inference with Handle-qualified models

**What to build:** Let applications use readable Handle-qualified model IDs on the conventional global API while preserving deterministic Provider selection and the exact Upstream Model suffix.

**Blocked by:** 01 — Create Providers with immutable Handles.

**Status:** complete

- [x] Global model discovery returns sorted, deduplicated `<provider_handle>/<model_id>` values allowed by the calling Gateway Key.
- [x] Global Chat Completions, Responses, and Anthropic Messages resolve the Handle prefix and forward every character after the first slash as the exact Upstream Model ID.
- [x] Buffered responses and every applicable streaming model field use the selected Provider Handle plus the actual upstream-reported model.
- [x] When upstream omits its model, global responses fall back to the requested Handle-qualified model ID.
- [x] Generated global code snippets and copyable model values use Provider Handles.
- [x] Authorization continues evaluating internal Provider IDs after Handle resolution, including exact-model restrictions and unknown-but-permitted catalog models.
- [x] Malformed Qualified Model IDs retain `400 invalid_model_id`; inaccessible Provider states retain sanitized `403 provider_not_allowed`; model restrictions retain `403 model_not_allowed`.
- [x] Provider-ID-qualified model values are no longer accepted as global public inference selectors.
- [x] HTTP-seam coverage exercises discovery and all global caller shapes, including buffered and streaming responses, nested model IDs, retries, cancellation, privacy, authorization, and rejection of legacy ID prefixes.

## Comments

- Implemented Handle-qualified global discovery and inference for Chat Completions, Responses, and Anthropic Messages. The routing seam resolves an immutable Handle to a Provider record once, then performs Provider and exact-model authorization with the internal Provider ID. Response qualification and generated global snippet model values retain the public Handle.
- Verification: `bun test test/http/qualified-model.test.ts test/http/global-models.test.ts test/http/global-chat-completions.test.ts test/http/global-responses.test.ts test/http/global-anthropic-messages.test.ts` (27 pass); `bun run typecheck` (pass); `bun run build` (pass, existing Vite chunk-size warning). The unconstrained full `bun test` run reached 719 pass / 1 skip before a broad 307-test cascade dominated by timeouts and unrelated ProviderRegistry/Usage suites; focused changed-area tests remained green.
