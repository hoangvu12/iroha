# 02 — `POST /providers/:id/keys/bulk` admin route

**What to build:** A new admin route `POST /providers/:id/keys/bulk` in `src/http/admin.ts` that accepts `{ keys: [{upstreamKey, baseUrl?}, ...] }`, calls `providers.bulkAddKeys(...)` (ticket 01), and returns per-entry results. The route reuses the existing CSRF guard pattern (`requireOwner({...}, { csrf: true })`) and Elysia schema decorations.

**Blocked by:** 01 (the registry method must exist first).

**Status:** done

- [x] Route `POST /providers/:id/keys/bulk` is registered on the admin app in `src/http/admin.ts`, alongside the existing `POST /providers/:id/keys` at `src/http/admin.ts:474-509`.
- [x] The route requires Owner authentication and CSRF, identical to the existing `POST /providers/:id/keys`.
- [x] Request body schema: `{ keys: t.Array(t.Object({ upstreamKey: t.String(), baseUrl: t.Optional(t.String()) }), { min: 1, max: 200 }) }`. The `200` cap matches the ADR's chosen batch size. (Note: the schema lives only as a documented shape; the route validates by hand to avoid echoing key material in the validator's error report — see the route's inline comment and the file-level doc at `admin.ts:33-40`.)
- [x] Whole-batch errors return `400 validation_failed` with `problems: [{field: 'keys', message: '...'}]`:
  - `keys` missing or not an array
  - `keys` empty
  - `keys` length > 200
  - `keys[i]` not an object
  - `keys[i].upstreamKey` not a string
  - `keys[i].baseUrl` not a string (when present)
- [x] Per-entry errors returned by the registry are passed through unchanged in the response body's `failed[]` (the registry's `FieldProblem[]` is the source of truth).
- [x] Successful response shape: `{ added: [{ index: number; keyId: string }]; failed: [{ index: number; problems: readonly { field: string; message: string }[] }] }`, returned with status `200`.
- [x] The `providerResponse` schema is **not** reused for the bulk endpoint — the response is the per-entry result, not the full Provider view (the Owner UI refetches the Provider separately via the existing `GET /providers` route).
- [x] Standard error responses (`provider_not_found` → 404, `provider_archived` → 409, `authentication_required` → 401) match the existing `POST /providers/:id/keys` route via the shared `errorResponses` map.
- [x] Route documentation in the OpenAPI summary explains partial-success semantics, the 200-entry cap, and that per-key `allowedModels` / `deniedModels` / `accountId` are not honored (Owner configures them later via `PATCH /providers/:id/keys/:keyId`).
- [x] Elysia schema validation errors (wrong body shape) surface through the existing `validation_failed` path so the UI's existing error toast works without changes.

## Comments

- Whole-batch validation is hand-rolled in `validateBulkKeysBody` (admin.ts) rather than declared as an Elysia `body` schema. An Elysia schema would route the validator's error report through the parent's `onError` and surface as `invalid_request` — and the validator echoes the offending value, which on these routes can be an Upstream Key. Hand-rolling keeps the secret out of the error envelope and matches the file-level doc at `admin.ts:33-40`.
- The previous implementation did declare `body: bulkKeysBody` plus a route-level `error` handler that tried to translate Elysia `VALIDATION` into `validation_failed`. That scoped `error` handler is unreachable because the parent's `onError` was registered first and short-circuits the chain with `invalid_request`. Removing the body schema and validating inline is the smallest fix that both meets the bullet and matches the project pattern.
