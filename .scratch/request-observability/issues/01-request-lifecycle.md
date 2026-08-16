# Terminal-only Request history

Status: Complete
Blocked by: —

Persist an internal Request before its Attempts, expose it only after terminal finalization, distinguish the final caller-visible outcome from Attempt outcomes, and surface recovery metadata.

## Acceptance

- [x] Placeholder Requests never appear in list, detail, or analytics reads.
- [x] `401 -> 200` is a successful Request with two independently visible Attempts.
- [x] Requests abandoned for at least one hour remain outside normal history.
- [x] SQLite and PostgreSQL contracts match.

## Comments

PostgreSQL schema, repository, and migration changes mirror SQLite. Runtime PostgreSQL conformance remains skipped unless `IROHA_TEST_POSTGRES_URL` points to a disposable database.
