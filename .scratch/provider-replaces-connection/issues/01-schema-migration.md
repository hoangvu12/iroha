# 01 — Schema migration with renamed ProviderRepository and per-key base URL column

**What to build:** The Owner can run an existing installation through a single migration that renames the Provider Connection table and column, adds the per-key base URL column, and rewrites Gateway Key scope IDs in place; the repository contract works with the renamed entity.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] A migration on the SQLite dialect renames the `provider_connections` table to `providers`, renames `upstream_keys.connection_id` to `upstream_keys.provider_id`, renames the foreign-key index on `upstream_accounts` accordingly, and adds a nullable `upstream_keys.base_url` column.
- [ ] A parallel migration on the PostgreSQL dialect performs the same renames and column addition.
- [ ] The migration rewrites every `pc_*` literal in every `gateway_keys.scope` JSON value to the matching `pr_*` value by reading the pre-rename `provider_connections` rows; the underlying ID values are preserved across the rename.
- [ ] The migration aborts with a clear error if a scope entry references a Provider ID that does not resolve, so a corrupted scope cannot silently drop access.
- [ ] The repository contract exposes `listProviders`, `getProvider`, `insertProvider`, `updateProvider`, `deleteProvider` (renamed from `listConnections`, `getConnection`, etc.) and accepts Provider IDs in place of Connection IDs.
- [ ] `insertKey` and `updateKey` accept an optional `baseUrl` argument; the column is nullable.
- [ ] A new `providerDefaultBaseUrl(providerId, keyId)` resolver returns `key.baseUrl` when set, else `provider.baseUrl`.
- [ ] The `key` view surfaced to the Owner includes a derived `effectiveBaseUrl` so the UI does not have to compute inheritance itself.
- [ ] Repository conformance tests pass on both dialects, including the new column and the resolver.
- [ ] A migration conformance test runs the migrations against a populated fixture (one Provider, several Upstream Keys with mixed base URL values, several Gateway Keys with non-empty scopes containing `pc_*` references) on both dialects and asserts the post-migration shape.