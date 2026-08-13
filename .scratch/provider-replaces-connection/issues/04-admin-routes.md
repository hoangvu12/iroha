# 04 — HTTP admin routes renamed to Provider-scoped paths

**What to build:** Admin tooling can call `/api/v1/admin/providers` for every Provider lifecycle operation; the old `/api/v1/admin/provider-connections` returns 404.

**Blocked by:** 02 — Renamed ProviderRegistry with per-key base URL behavior and audit vocabulary update.

**Status:** ready-for-agent

- [ ] Admin route paths change from `/api/v1/admin/provider-connections` to `/api/v1/admin/providers`.
- [ ] All sub-routes are renamed: list, inspect, create, edit, archive, duplicate, purge, add-key, remove-key, test-key, activate-key, disable-key, configure-key, create-account, update-account, delete-account.
- [ ] JSON request and response field names track the rename (e.g. `connectionId` → `providerId` where present; `baseUrl` per-key is now a first-class field).
- [ ] The old `/api/v1/admin/provider-connections` path returns 404 (no redirect).
- [ ] Admin API tests pass on both dialects, including the create-with-base-URL case and the add-key-with-optional-base-URL case.