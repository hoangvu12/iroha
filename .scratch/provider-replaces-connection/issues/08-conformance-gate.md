# 08 — End-to-end conformance and old-path cleanup verification

**What to build:** The complete rename and per-key base URL feature is provably correct across both dialects, with no stale references to Provider Connection anywhere in new behavior.

**Blocked by:** 01 — Schema migration with renamed ProviderRepository and per-key base URL column; 02 — Renamed ProviderRegistry with per-key base URL behavior and audit vocabulary update; 03 — HTTP inference routes renamed to Provider-scoped URLs with mixed-URL round-robin; 04 — HTTP admin routes renamed to Provider-scoped paths; 05 — Owner UI Providers page with renamed entity and optional base URL on creation; 06 — Owner UI Provider detail page with per-key base URL override on key creation; 07 — Provider Directory and Gateway Key scope targeting Provider IDs.

**Status:** ready-for-agent

- [ ] Full test suite passes on both dialects (SQLite and PostgreSQL).
- [ ] All old inference paths (`/providers/:connectionId/v1/...`) confirmed to return 404.
- [ ] All old admin paths (`/api/v1/admin/provider-connections`) confirmed to return 404.
- [ ] New audit writes contain no `connection.*` actions; only `provider.*`, `key.*`, and `account.*` actions appear.
- [ ] Migration conformance tests confirm `gateway_keys.scope` is rewritten and the migration aborts when scope IDs cannot be resolved.
- [ ] Generated OpenAPI matches the new routes and field names.
- [ ] `CONTEXT.md`, `docs/adr/0006-provider-replaces-connection-with-per-key-base-url.md`, and the running system agree on Provider as the owner-managed entity with per-key base URL override.