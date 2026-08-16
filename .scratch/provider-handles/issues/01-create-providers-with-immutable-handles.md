# 01 — Create Providers with immutable Handles

**What to build:** Let the Owner create and inspect Providers with a required public Handle that is pleasant to configure but can never change after creation. Existing Providers receive deterministic Handles so the upgraded Gateway immediately satisfies the same identity contract.

**Blocked by:** None — can start immediately.

**Status:** complete

- [x] SQLite and PostgreSQL give every existing Provider a valid, globally unique Handle derived solely from its display name, using deterministic collision suffixes ordered by creation time and then Provider ID.
- [x] Both database engines enforce the same required and globally unique Handle constraint across active and archived Providers.
- [x] Provider creation requires a 1–63 character lowercase kebab-case Handle and returns field-level validation or `handle_already_exists` conflict details without silently changing the submitted value.
- [x] Concurrent attempts to claim one Handle have exactly one winner, with database uniqueness remaining authoritative after any availability check.
- [x] The creation UI derives and transliterates a proposed Handle from the display name until the Owner edits it, supports explicit regeneration, falls back to `provider`, and suggests length-safe numeric suffixes for collisions.
- [x] The creation UI clearly says that a Provider Handle can never be renamed, and changing a saved Provider's display name leaves its Handle unchanged.
- [x] Provider cards, details, and management representations show the Handle prominently while retaining the immutable Provider ID as secondary diagnostic metadata.
- [x] HTTP-seam and dual-database conformance coverage proves creation, validation, collision, archival reservation, deterministic backfill, and immutability behavior.

## Comments

Implemented required immutable Provider Handles across both schemas, migrations, persistence, registry/admin HTTP contracts, and Owner UI. The database uniqueness constraint remains authoritative and maps races to field-level `409 handle_already_exists`. Creation UI proposal/transliteration follows display-name edits until customization, supports regeneration, debounced availability and length-safe suffix suggestions, and displays the Handle with the internal ID as diagnostic metadata.

Verification: `bun run typecheck`; `bun test test/http/providers.test.ts` (69 pass); migration/repository conformance (132 pass before two expectation updates, then focused Handle/repository rerun 6 pass). PostgreSQL execution was skipped because `IROHA_TEST_POSTGRES_URL` is not configured; the shared conformance test and PostgreSQL migration are present. Browser tests are intentionally deferred per `docs/agents/ui-testing.md`; coverage is at the HTTP seam. Two-axis Standards/Spec review performed before handoff.
