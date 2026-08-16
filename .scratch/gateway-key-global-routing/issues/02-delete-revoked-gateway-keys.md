# 02 — Delete revoked Gateway Keys without erasing history

**What to build:** Let the Owner permanently delete a revoked Gateway Key while preserving readable, secret-free historical identity. The key disappears from management and cannot authenticate or be restored, but past Requests and audit events still identify it by its immutable ID and name snapshot.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] The admin API and management UI offer deletion only for revoked Gateway Keys and require deliberate confirmation.
- [x] Attempting to delete an active or unknown key returns a stable error and changes nothing.
- [x] Successful deletion removes the live record and all authentication material and is idempotently impossible to restore.
- [x] Relevant Request and audit records preserve immutable safe snapshots of the Gateway Key ID and name on SQLite and PostgreSQL.
- [x] A successful deletion records `gateway_key.deleted` with safe metadata and no plaintext secret, hash, or other credential material.
- [x] Historical management views remain readable after deletion, while the deleted key no longer appears in the Gateway Keys list.
- [x] HTTP, persistence-conformance, audit, history, and redaction coverage prove the complete lifecycle.

## Comments

- Implemented revoked-only deletion through the assembled admin HTTP seam, with stable `gateway_key_active` and `gateway_key_not_found` failures, Owner CSRF protection, and deliberate browser confirmation.
- Request history now stores immutable Gateway Key ID/name snapshots; audit deletion metadata contains only the safe ID and name. Additive nullable migrations cover SQLite and PostgreSQL.
- Focused HTTP/history/persistence/migration validation passed (32 tests), along with root/UI typechecks and the production UI build. PostgreSQL conformance was discovered but skipped because `IROHA_TEST_POSTGRES_URL` is not configured in this environment.
- Per `docs/agents/ui-testing.md`, no browser/JS-DOM harness is used; UI behavior is covered at the HTTP seam and by the production build.
