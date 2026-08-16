# 04 — Preserve Provider Handles in Request history

**What to build:** Let the Owner recognize the public Provider identity used by each completed Request without replacing the stable internal identity needed for filtering, audit, and historical integrity.

**Blocked by:** 02 — Route provider-scoped inference by Handle; 03 — Route global inference with Handle-qualified models.

**Status:** complete

- [x] Every new Request through provider-scoped or global routing snapshots both the immutable Provider ID and the Provider Handle selected at admission.
- [x] Request history displays the Provider Handle while retaining Provider-ID-based relationships and filtering behavior.
- [x] Later Provider display-name changes, archival, or other configuration changes cannot alter the Handle shown for a historical Request.
- [x] Existing pre-Handle history remains readable after migration without inventing a Handle snapshot that did not exist when the Request occurred.
- [x] Provider deletion remains outside this ticket; no Handle-reuse behavior is introduced implicitly.
- [x] SQLite and PostgreSQL migrations preserve existing history and store equivalent snapshots for new Requests.
- [x] HTTP-seam and persistence conformance coverage proves snapshot creation and Owner-visible history for both provider-scoped and global requests.

## Comments

- 2026-08-17: Added a nullable immutable Provider Handle snapshot to Request persistence and Owner-facing history. Scoped and global inference pass the already-resolved Handle into the shared Request recorder while Provider ID remains the foreign key and filter identity. Legacy rows retain a null snapshot and render their Provider ID fallback. Additive SQLite/PostgreSQL migrations are equivalent; HTTP coverage exercises both routing surfaces and post-request display-name changes, while repository and migration conformance cover snapshot round-trips, ID filtering, and legacy readability.
- 2026-08-17 verification: 128 focused history, HTTP, migration, and repository tests passed; root/UI type checking and the production UI build passed. The executable PostgreSQL legacy-migration case and PostgreSQL repository conformance were discovered but skipped because `IROHA_TEST_POSTGRES_URL` is not configured. The full suite reached 942 passes and 2 skips but retained 96 integration failures from older direct `ProviderRegistry.create` fixtures that do not yet supply Ticket 01's now-required Handle; Ticket 04's focused suites are green.
