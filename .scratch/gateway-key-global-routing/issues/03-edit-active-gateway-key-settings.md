# 03 — Edit active Gateway Key settings safely

**What to build:** Let the Owner atomically edit an active Gateway Key's name, access policy, and CORS origins without rotating its secret. Concurrent browser tabs cannot silently overwrite newer permissions, revoked keys remain immutable, and already-admitted Requests are not interrupted.

**Blocked by:** 01 — Create unrestricted Gateway Keys.

**Status:** complete

- [x] One admin mutation validates and atomically updates name, access policy, and CORS origins for an active key.
- [x] The edit contract carries a revision or equivalent modification precondition and rejects stale saves with a stable conflict response.
- [x] Revoked and unknown keys cannot be edited, and failed validation or conflicts leave every field unchanged.
- [x] The management UI loads current values, supports switching between all and selected access, and explains stale-save conflicts.
- [x] Successful edits record one secret-free audit event with safe before/after policy metadata.
- [x] New Requests observe the saved policy immediately while a Request admitted before the save may complete normally.
- [x] SQLite, PostgreSQL, assembled HTTP, CORS, authorization, UI HTTP-seam, audit, and concurrency behavior are covered.

## Comments

- 2026-08-17: Started at the assembled admin HTTP seam and dialect repository boundary. The edit uses an integer revision precondition and one compare-and-swap persistence operation.
- 2026-08-17: Complete. Added atomic `PATCH /api/v1/admin/gateway-keys/:id`, monotonic revisions with compatible SQLite/PostgreSQL migrations, conflict/revoked handling, safe audit metadata, and an edit UI with explicit stale-save guidance. Focused HTTP, CORS, admitted-Request, persistence, and migration validation passed (138 tests), as did typecheck and the UI production build. PostgreSQL runtime tests were unavailable because `IROHA_TEST_POSTGRES_URL` is unset; the PostgreSQL migration was generated and dialect adapter compiles.
