# 07 — Call global Anthropic Messages with Qualified Model IDs

**What to build:** Let Anthropic-compatible applications call the global Messages surface with deterministic Qualified Model IDs, whether the selected Provider uses Anthropic shape directly or an Inference Adapter translates the round trip.

**Blocked by:** 05 — Call global Chat Completions with Qualified Model IDs.

**Status:** complete

- [x] Global `POST /v1/messages` supports non-streaming and Anthropic SSE streaming through the shared global inference seam.
- [x] The Provider prefix is removed before either passthrough or translation and the exact remaining Upstream Model ID is preserved.
- [x] Caller-visible response and stream model fields qualify the upstream-reported model and fall back to the requested Qualified Model ID only when absent.
- [x] Invalid IDs and authorization failures occur before upstream traffic and follow the agreed privacy contract in Anthropic-compatible error shape where required.
- [x] Direct Anthropic-shaped and translated OpenAI-shaped Providers retain tools, structured output, usage, retry, cancellation, and observability behavior.
- [x] Provider-scoped Messages behavior remains unchanged.
- [x] Assembled HTTP coverage proves both adapter directions, non-streaming, streaming, nested IDs, served-model reporting, privacy, and error envelopes.

## Comments

- 2026-08-17: Implemented global Messages as an additive branch of the shared global inference factory. Qualified authorization is captured once, only the first Provider prefix is removed, and the existing Anthropic/OpenAI adapter pipeline retains retries, tools, structured output, usage, history, streaming, and cancellation. The focused global plus provider-scoped Anthropic gate passed 80 tests with no failures; typecheck and diff validation passed.
