# 02 — Route provider-scoped inference by Handle

**What to build:** Let applications select a Provider with its readable Handle on every provider-scoped discovery and inference surface, while the Gateway resolves that public identity to the existing internal Provider identity before authorization and execution.

**Blocked by:** 01 — Create Providers with immutable Handles.

**Status:** complete

- [x] Provider-scoped model discovery, Chat Completions, Responses, and Anthropic Messages accept `/providers/{provider_handle}/v1/*` and preserve exact unqualified Upstream Model IDs.
- [x] Generated scoped code snippets and copyable inference URLs use the Provider Handle.
- [x] The application-facing Provider Directory returns both `id` and `handle`, and its inference URL uses the Handle.
- [x] Gateway Key authorization continues evaluating internal Provider IDs after Handle resolution without changing selected or unrestricted access semantics.
- [x] Syntactically invalid Handles fail with `400 invalid_provider_handle` before lookup or upstream traffic.
- [x] Nonexistent, inaccessible, archived, and disabled Handles remain indistinguishable as sanitized `403 provider_not_allowed` responses.
- [x] Generated Provider IDs are no longer accepted as provider-scoped public inference selectors.
- [x] HTTP-seam coverage exercises discovery and every supported caller shape, including streaming, cancellation, authorization, privacy, exact-model forwarding, and rejection of legacy ID selectors.

## Comments

- Implemented Handle resolution at the provider-scoped inference boundary. The resolver validates the exact Handle, resolves only active Providers, and returns the internal Provider ID used by existing Gateway Key authorization, model discovery, forwarding, retries, streaming, cancellation, and history code.
- Added HTTP-seam coverage for all scoped caller shapes, nested exact model forwarding, streaming cancellation, directory output, internal-ID scope authorization, legacy-ID rejection, and indistinguishable inaccessible Provider states.
- Updated scoped code snippets and the Provider Directory to emit Handle-based URLs. No DOM harness was added per `docs/agents/ui-testing.md`.
- Verification: focused HTTP suite, server/UI type checking, and UI production build pass. PostgreSQL conformance was not run because `IROHA_TEST_POSTGRES_URL` is not configured; Ticket 02 has no schema changes.
