# 01 — Generic Anthropic-compatible provider template

**What to build:** Add a new `Generic Anthropic-compatible` entry to `BUILT_IN_PROVIDER_TEMPLATES` in `src/providers/templates.ts`. The template uses `x-api-key` authentication (Anthropic's native scheme), points at the `ANTHROPIC_INFERENCE_ADAPTER_ID`, and has no known models or capability defaults (matching the `Generic OpenAI-compatible` pattern).

**Blocked by:** None — can start immediately.

**Status:** done

- [x] Add `generic-anthropic-compatible` entry to `BUILT_IN_PROVIDER_TEMPLATES` with:
  - `id: 'generic-anthropic-compatible'`
  - `displayName: 'Generic Anthropic-compatible'`
  - `description: 'A safe default for any Anthropic-shaped service Iroha does not know by brand. x-api-key authentication, no inferred capability defaults, and reactive-only entitlement visibility.'`
  - `baseUrl: 'https://api.example.com/v1'`
  - `authHeader: 'x-api-key'`
  - `authPrefix: ''`
  - `capabilities: { chat: false, streaming: false, tools: false, structuredOutput: false, responses: false }`
  - `knownModels: []`
  - `inferenceAdapterId: ANTHROPIC_INFERENCE_ADAPTER_ID`
  - `usageAdapterId: REACTIVE_ONLY_USAGE_ADAPTER_ID`
  - `brand: null`
- [x] Add the template to the picker order (after `Generic OpenAI-compatible`, before branded templates)
- [x] Update `test/providers/templates.test.ts` to assert the new template exists with correct defaults
- [x] Verify existing template tests still pass (no regressions)

## Comments

- The template uses `ANTHROPIC_INFERENCE_ADAPTER_ID` so users can call both `/v1/chat/completions` (OpenAI-shaped, translated to Anthropic) and `/v1/messages` (Anthropic-shaped, passthrough) against the same provider.
- The `authHeader: 'x-api-key'` default matches Anthropic's native API. Users with proxies that use different auth (e.g., LiteLLM using `Authorization: Bearer`) can override in the UI (see issue 02).
- The template has `brand: null` because it's a generic template, not a branded service.
