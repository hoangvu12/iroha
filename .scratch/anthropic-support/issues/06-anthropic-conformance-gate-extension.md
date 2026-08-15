# 06 — Conformance gate extension with Anthropic SDK conformance tests

**What to build:** The v1 conformance gate at `.scratch/iroha-v1/issues/18` extends to cover Anthropic. The official Anthropic TypeScript SDK (`anthropics/anthropic-sdk-typescript`) exercises against iroha with mock upstream. Mock upstream scenarios cover the full set of Anthropic-specific failure modes. The conformance gate closes on SQLite and PostgreSQL with the Anthropic Provider Template loaded.

**Blocked by:** 04 (`/v1/messages` public surface), 05 (`/v1/responses` → `/v1/messages` with structured output).

**Status:** ready-for-agent

- [ ] Mock upstream scenarios in `test/http/anthropic-mock-scenarios.test.ts` cover Anthropic-specific success, malformed responses, delayed headers, stalled streams, disconnects, timeouts, cancellation, `400`, `401`, ambiguous `403`, confirmed quota exhaustion (`402`), key/account/unknown `429`, retryable `5xx`, redirects, and secret-bearing upstream messages — mirroring the v1 conformance gate's existing scenario set (`issues/18`).
- [ ] Official Anthropic TypeScript SDK (`anthropics/anthropic-sdk-typescript`) calls `/v1/messages` against iroha with mock upstream; SDK accepts the response without modification. The SDK's `client.messages.create()` and `client.messages.stream()` paths are both exercised. Mirrors the existing OpenAI JavaScript SDK conformance test pattern (`test/http/openai-sdk-*.test.ts`).
- [ ] Official OpenAI JavaScript SDK conformance tests pass unchanged for the existing OpenAI surface against an OpenAI Provider, and extend to cover an Anthropic Provider target end-to-end (chat completions, responses, streaming, tools, structured output).
- [ ] Repository conformance suite (`test/persistence/repository-conformance.test.ts`) passes unchanged against SQLite and PostgreSQL with the Anthropic Provider Template loaded; new connection records using the `anthropic` template round-trip through create/list/test/reveal/archive/purge without divergence.
- [ ] Redaction tests prove that Anthropic-shaped secrets (the `x-api-key` header value, the `Authorization` header value for OAuth tokens) do not enter persistence, audit, metrics, or public errors. Mirrors the v1 redaction gate items.
- [ ] Anthropic-specific key health transitions are exercised end-to-end: `401` demotes the Upstream Key to `invalid_authentication`; `402` demotes to `exhausted`; `429` with a known scope cools the affected scope; controlled-trial after cooldown expiry restores an Active key.
- [ ] The Anthropic-shape version of the conformance checklist (this ticket) marks these items as done. `.scratch/iroha-v1/issues/18` is amended to reference the Anthropic conformance items.