# 05 — Call global Chat Completions with Qualified Model IDs

**What to build:** Let OpenAI-compatible applications call global Chat Completions with a Qualified Model ID. Iroha deterministically selects the named Provider, forwards the exact upstream model remainder, and presents the actual served model in the global namespace without changing provider-scoped behavior.

**Blocked by:** 04 — Discover Qualified Model IDs through the global API.

**Status:** complete

- [x] Global `POST /v1/chat/completions` supports non-streaming and streaming calls through the existing inference, retry, cancellation, usage, and observability behavior.
- [x] The Provider prefix is removed before forwarding and all later slashes in the Upstream Model ID remain unchanged.
- [x] Non-streaming responses and streaming chunks expose `<provider_id>/<upstream-reported-model>`; when upstream omits a model they use the requested Qualified Model ID.
- [x] Invalid keys, malformed IDs, inaccessible Providers, denied models, and authorized upstream failures follow the agreed error and privacy contract.
- [x] No global request searches Providers, substitutes a model, or falls back across Providers.
- [x] Existing provider-scoped Chat Completions responses and exact model forwarding remain unchanged.
- [x] Official OpenAI client and assembled HTTP coverage prove ordinary, streaming, nested-ID, alias-resolution, error, retry, cancellation, and no-upstream-on-rejection cases.

## Comments

- Global Chat Completions performs one Qualified Model authorization decision, strips only the Provider prefix, and delegates to the existing provider-scoped inference pipeline. Successful JSON and SSE responses qualify the actual served model, with requested-ID fallback when upstream omits it.
- Focused global tests cover official OpenAI buffered/streaming clients, nested IDs, aliases, fallback, retries, request history, cancellation, privacy, and rejection before upstream traffic. The wider provider-scoped/retry/stream/history compatibility run passed 89 tests; the final global suite passed 7 tests, and root/UI typechecks passed.
- PostgreSQL conformance was discovered but skipped because `IROHA_TEST_POSTGRES_URL` is not configured.
