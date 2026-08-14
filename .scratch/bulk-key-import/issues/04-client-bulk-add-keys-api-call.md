# 04 — `bulkAddKeys` API call in `ui/src/lib/providers.ts`

**What to build:** A new `bulkAddKeys(providerId, entries, csrfToken)` function in `ui/src/lib/providers.ts` that POSTs the parsed entries to the new `POST /providers/:id/keys/bulk` endpoint (ticket 02) and returns the typed per-entry result.

**Blocked by:** 02 (the route must exist).

**Status:** done

- [x] Function `bulkAddKeys(providerId: string, entries: readonly { upstreamKey: string; baseUrl?: string }[], csrfToken: string): Promise<BulkAddKeysResult>` is exported from `ui/src/lib/providers.ts`.
- [x] `BulkAddKeysResult` is exported as a type with shape `{ added: readonly { index: number; keyId: string }[]; failed: readonly { index: number; problems: readonly FieldProblem[] }[] }`.
- [x] The function builds the request body as `{ keys: entries.map((e) => ({ upstreamKey: e.upstreamKey, ...(e.baseUrl !== undefined ? { baseUrl: e.baseUrl } : {}) })) }`, omitting `baseUrl` when undefined to match the existing `createProvider` / `addKey` shape at `ui/src/lib/providers.ts:186-197` and `ui/src/lib/providers.ts:302-308`.
- [x] The function uses the existing `request<...>(...)` helper at `ui/src/lib/providers.ts:389-424`, passing the CSRF token and JSON content-type headers.
- [x] On `400 validation_failed` (whole-batch error from the server), the function throws the resulting `ManagementError` so the existing error-toast plumbing in the dialog handles it.
- [x] On `200` with any `failed` entries, the function **resolves** with the partial-success result (does not throw) — the caller decides how to surface the per-entry failures. This matches OmniRoute's "always returns 200 with per-entry results" precedent.
- [x] On `404` / `409` / `401` / `request_failed` / `unreachable`, the function throws the corresponding `ManagementError` (existing behavior from `request`).
- [x] The function does not call `fetchProviders()` afterwards — the caller is responsible for re-reading the Provider so the UI's loading state is owned by the caller.
