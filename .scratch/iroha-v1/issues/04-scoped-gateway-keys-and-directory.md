# 04 — Scoped Gateway Keys and Provider Directory

**What to build:** The Owner can issue application credentials that reveal once, store only a hash, constrain access, and discover only permitted Provider Connections.

**Blocked by:** 03 — Generic Provider Connection with one encrypted Upstream Key.

**Status:** ready-for-agent

- [ ] The Owner can create a named Gateway Key with a public lookup identity and high-entropy one-time secret.
- [ ] Only a cryptographic hash of the usable Gateway Key secret is stored.
- [ ] The Owner can see creation and last-used metadata and revoke a Gateway Key.
- [ ] A Gateway Key can allow selected Provider Connections and optional exact model IDs.
- [ ] Authenticated Provider Directory discovery returns only connections and models allowed by the calling Key Scope.
- [ ] Directory results include connection identity, display name, scoped inference URL, exact model IDs, and capabilities but exclude upstream base URLs, balances, secrets, and internal health.
- [ ] Revoked or out-of-scope Gateway Keys receive stable sanitized errors.
- [ ] Browser and HTTP tests cover one-time reveal, lookup, scope filtering, last use, and revocation.

