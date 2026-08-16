# 01 — Create unrestricted Gateway Keys

**What to build:** Let the Owner create an All Providers Gateway Key through the admin API and management UI. Its unrestricted Key Scope dynamically covers every active Provider and model, including Providers created or restored later, while selected policies and every existing Gateway Key retain exactly their prior authority.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] Create and read contracts expose explicit `all` and `selected` access modes while accepting legacy scope-based create requests as selected access.
- [x] Existing persisted scopes migrate compatibly on SQLite and PostgreSQL; an existing empty scope still denies all access.
- [x] The UI offers an explicit All Providers option and permits creating it when no Provider exists.
- [x] Unrestricted keys gain enabled, unarchived Providers upon creation or restoration and lose them upon disablement or archival.
- [x] Provider-scoped inference and model discovery enforce both access modes, including exact selected-model restrictions and unknown-but-permitted model IDs.
- [x] The authenticated Provider Directory retains its existing response shape and filters Providers correctly under both access modes.
- [x] Creation and policy representation are covered at the repository and assembled HTTP seams without weakening secret, CORS, or audit protections.

## Comments

- 2026-08-17: Implementation started at the assembled HTTP and cross-dialect repository seams. Existing `scope` requests and rows will remain selected access; explicit `access.mode: all` is additive.
- 2026-08-17: Complete. Added an `access_mode` column defaulting legacy rows to `selected` in both dialect migrations, explicit admin/UI access contracts, dynamic active-Provider authorization and discovery, catalog enumeration, and Provider restoration. Focused HTTP/persistence/migration suites passed (119 tests after the final tracer fix), typecheck and UI production build passed. PostgreSQL runtime conformance was unavailable because `IROHA_TEST_POSTGRES_URL` is not set; its generated migration is the same additive non-null/default conversion verified structurally.
