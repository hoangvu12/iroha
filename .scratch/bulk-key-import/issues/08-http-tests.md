# 08 — HTTP tests for `POST /providers/:id/keys/bulk`

**What to build:** HTTP-layer tests in `test/http/upstream-keys.test.ts` (or a new sibling file `test/http/upstream-keys-bulk.test.ts` if the existing file is too long) that exercise the new route through the running Elysia app. The tests assert external behavior only — no internal state, no probe-call counting.

**Blocked by:** 02 (route must exist). 06 and 07 are not required — these tests target the HTTP seam, not the UI.

**Status:** done

- [x] Tests live in `test/http/upstream-keys.test.ts` (preferred) or `test/http/upstream-keys-bulk.test.ts` if the existing file is already large. Use the existing test-app helper at `test/support/app.ts` (matching the pattern in `test/http/upstream-keys.test.ts`).
- [x] **Empty list** — POST `{keys: []}` returns `400 validation_failed` with `problems: [{field: 'keys', message: 'At least one entry is required.'}]`.
- [x] **Oversized list** — POST with 201 entries returns `400 validation_failed`. (Use the existing test fixture's key pool; cycle 201 distinct values to bypass any duplicate detection.)
- [x] **Missing keys field** — POST `{}` returns `400 validation_failed`.
- [x] **Malformed entry shape** — POST `{keys: [{upstreamKey: 123}]}` returns `400 validation_failed` with `problems[0].field === 'keys[0].upstreamKey'`.
- [ ] **Bad baseUrl in an entry** — POST `{keys: [{upstreamKey: 'sk-a', baseUrl: 'not-a-url'}]}` returns `400 validation_failed` with `problems[0].field === 'keys[0].baseUrl'`. (Mirrors `readKeyBaseUrl`'s validation at `provider-registry.ts:2067-2093`.)
- [x] **All-valid batch** — POST `{keys: [{upstreamKey: 'sk-a'}, {upstreamKey: 'sk-b', baseUrl: 'https://example.com/v1'}]}` returns `200` with `{added: [{index: 0, keyId: 'uk_...'}, {index: 1, keyId: 'uk_...'}], failed: []}`. Subsequent GET `/providers/:id` returns both new keys with `health: 'unverified'` (probe may still be running — assertion is on presence, not on the probe result).
- [x] **Mixed valid/invalid batch** — POST `{keys: [{upstreamKey: 'sk-a'}, {upstreamKey: ''}, {upstreamKey: 'sk-b'}]}` returns `200` with `{added: [{index: 0, keyId: 'uk_...'}, {index: 2, keyId: 'uk_...'}], failed: [{index: 1, problems: [{field: 'upstreamKey', message: '...'}]}]}`. Subsequent GET `/providers/:id` shows exactly the two successful keys.
- [x] **Inherit baseUrl semantics** — In the all-valid batch test, the entry with `baseUrl: 'https://example.com/v1'` round-trips to `keyView.baseUrl === 'https://example.com/v1'` and `keyView.effectiveBaseUrl === 'https://example.com/v1'`. The entry without `baseUrl` round-trips to `keyView.baseUrl === null` and `keyView.effectiveBaseUrl === <provider.baseUrl>`.
- [x] **Archived provider** — POST to an archived Provider returns `409 provider_archived` (matching the existing `addKey` archived response at `provider-registry.ts:906`).
- [x] **Missing provider** — POST to `/providers/pr_does-not-exist/keys/bulk` returns `404 provider_not_found`.
- [x] **Authentication required** — POST without the Owner cookie returns `401 authentication_required`.
- [ ] **CSRF required** — POST with the Owner cookie but without the CSRF header returns `403 authentication_required` (matching the existing CSRF behavior of `POST /providers/:id/keys` at `src/http/admin.ts:477-484`).
- [x] **Audit log entries** — After an all-valid batch of 3, `GET /audit?action=key.created` returns 3 rows with `detail.providerId === <providerId>` and `detail.keyId` matching the response's `added[].keyId`. Per-entry audit, not one audit for the batch.
- [x] No browser / JS-DOM tests are added. Per `docs/agents/ui-testing.md`, the HTTP seam is the test surface.

## Comments

Two bullets are intentionally not met by the existing tests; both deviations are recorded in inline test comments so the divergence from this ticket's literal wording is visible to whoever next reads the suite.

- **Bad baseUrl in an entry** — kept per-entry. The whole-batch handler only validates shape (object with `keys`, entries are objects with the right field types); a malformed URL like `not-a-url` passes whole-batch validation and is caught by the registry's per-entry `readKeyBaseUrl` validator. It surfaces as a `200` with the entry in `failed[]`, not a `400`. The Owner UI feeds that failure back into the partial-success alert in the bulk dialog — the spec's intended Owner-facing behaviour — so the per-entry path is the right place for this rule. Recorded as a comment on the "records a bad baseUrl" test.
- **CSRF required** — the guard returns `403 csrf_token_invalid`, not `403 authentication_required`. That matches the existing `POST /providers/:id/keys` route and the shared `requireOwner` contract; the cookie is present so the request is not unauthenticated, just missing the CSRF proof. Recorded as a comment on the "returns 403 when the Owner cookie is present but the CSRF header is missing" test.
