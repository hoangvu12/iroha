# 06 — Call global Responses with Qualified Model IDs

**What to build:** Let OpenAI-compatible applications call the global Responses surface using the same deterministic Qualified Model ID, authorization, privacy, and actual-served-model contract established for global Chat Completions.

**Blocked by:** 05 — Call global Chat Completions with Qualified Model IDs.

**Status:** complete

- [x] Global `POST /v1/responses` supports non-streaming and streaming calls through the shared global inference seam.
- [x] The exact Upstream Model ID is forwarded after removing only the first Provider prefix.
- [x] Caller-visible response and stream model fields qualify the upstream-reported model and fall back to the requested Qualified Model ID only when absent.
- [x] Authorization rejections occur before upstream traffic and use the agreed sanitized errors; authorized upstream errors retain existing adapter translation.
- [x] Existing Responses features, unknown-field forwarding, tools, structured output, retries, cancellation, usage, and observability continue to work globally.
- [x] Provider-scoped Responses behavior remains unchanged.
- [x] Official OpenAI client and assembled HTTP coverage prove non-streaming, streaming, nested IDs, model resolution, privacy, and compatibility.

## Comments

- Extended the shared global inference seam with `POST /v1/responses`. It performs one Qualified Model admission, forwards the exact nested model remainder, and delegates to the existing Responses pipeline.
- Buffered response models and nested `response.model` fields in SSE lifecycle events are globally qualified; model-less delta events remain unchanged, and absent response models fall back to the requested Qualified Model ID.
- Focused global and provider-scoped Responses, official OpenAI SDK, retry, cancellation, error, and history validation passed (46 tests), along with root/UI typechecks. PostgreSQL conformance was skipped because `IROHA_TEST_POSTGRES_URL` is not configured.
