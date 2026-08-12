# 04 — Scoped Gateway Keys and Provider Directory

**What to build:** The Owner can issue application credentials that reveal once, store only a hash, constrain access, and discover only permitted Provider Connections.

**Blocked by:** 03 — Generic Provider Connection with one encrypted Upstream Key.

**Status:** complete

- [x] The Owner can create a named Gateway Key with a public lookup identity and high-entropy one-time secret.
- [x] Only a cryptographic hash of the usable Gateway Key secret is stored.
- [x] The Owner can see creation and last-used metadata and revoke a Gateway Key.
- [x] A Gateway Key can allow selected Provider Connections and optional exact model IDs.
- [x] Authenticated Provider Directory discovery returns only connections and models allowed by the calling Key Scope.
- [x] Directory results include connection identity, display name, scoped inference URL, exact model IDs, and capabilities but exclude upstream base URLs, balances, secrets, and internal health.
- [x] Revoked or out-of-scope Gateway Keys receive stable sanitized errors.
- [x] Browser and HTTP tests cover one-time reveal, lookup, scope filtering, last use, and revocation.

## Comments

Implemented via subagent: Gateway Key registry (one-time `<id>.<secret>` reveal, SHA-256 hash storage, revocable, Key Scope allow-lists), Provider Directory endpoint filtered by Key Scope, admin CRUD, SQLite/Postgres migration 0003, 26 HTTP tests. Full suite 319 pass / 1 skip (PG conformance, no URL) / 0 fail; typecheck clean.

