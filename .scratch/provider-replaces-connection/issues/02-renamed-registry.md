# 02 — Renamed ProviderRegistry with per-key base URL behavior and audit vocabulary update

**What to build:** The Owner can perform every Provider lifecycle operation through the renamed ProviderRegistry, including adding Upstream Keys with an optional base URL override; inference resolves to the right key with the right URL.

**Blocked by:** 01 — Schema migration with renamed ProviderRepository and per-key base URL column.

**Status:** ready-for-agent

- [ ] `ProviderConnectionRegistry` is renamed to `ProviderRegistry`; every public method tracks the rename (e.g. `listConnections` → `listProviders`, `getConnection` → `getProvider`).
- [ ] `addKey` and `updateKeySettings` accept an optional `baseUrl` parameter; when omitted, the key inherits the Provider's base URL.
- [ ] `resolveInference` picks a key round-robin among eligible keys and uses the resolved base URL (the key's `baseUrl` if set, else the Provider's `baseUrl`) for that call.
- [ ] Audit action names are renamed: `connection.created`, `connection.updated`, `connection.archived`, `connection.duplicated`, `connection.purged` become `provider.created`, `provider.updated`, `provider.archived`, `provider.duplicated`, `provider.purged`.
- [ ] Pre-existing audit rows keep their old action names because the audit table is append-only.
- [ ] All other rules stay the same: ID-immutability, encrypted-then-tested-then-active key lifecycle, archive-first purge, Owner-disable, key-account grouping, retry and cooldown scoping.
- [ ] Registry tests pass on both dialects, including a mixed-URL round-robin case (one Provider with one key at its default URL and one key at its own override URL; the test asserts the resolved call uses the override URL when that key wins).