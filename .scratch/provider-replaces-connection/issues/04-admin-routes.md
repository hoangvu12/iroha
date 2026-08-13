# 04 — HTTP admin routes renamed to Provider-scoped paths

**What to build:** Admin tooling can call `/api/v1/admin/providers` for every Provider lifecycle operation; the old `/api/v1/admin/provider-connections` returns 404.

**Blocked by:** 02 — Renamed ProviderRegistry with per-key base URL behavior and audit vocabulary update.

**Status:** done

- [x] Admin route paths change from `/api/v1/admin/provider-connections` to `/api/v1/admin/providers`.
- [x] All sub-routes are renamed: list, inspect, create, edit, archive, duplicate, purge, add-key, remove-key, test-key, activate-key, disable-key, configure-key, create-account, update-account, delete-account. The catalog and usage sub-routes (`/api/v1/admin/providers/:id/catalog` and `/api/v1/admin/providers/:id/usage`) ride on the same prefix rename.
- [x] JSON request and response field names track the rename (e.g. `connectionId` → `providerId` where present; `baseUrl` per-key is now a first-class field). The list response now returns `{ providers: [...] }`, the internal types are `ProviderDto` / `providerResponse` / `providerListResponse`, and the per-key body fields for `baseUrl` round-trip through `addKey` and `updateKeySettings`.
- [x] The old `/api/v1/admin/provider-connections` path returns 404 (no redirect). Stale sub-paths under the old prefix also 404.
- [x] Admin API tests pass on both dialects, including the create-with-base-URL case and the add-key-with-optional-base-URL case. The standalone test file `test/http/provider-connections.test.ts` is replaced by `test/http/providers.test.ts` with a `route naming` block asserting 404 on every stale path.