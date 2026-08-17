# 02 — Give existing and newly created Providers default Logos

**What to build:** Make every Provider carry a nullable Logo Domain and display its resulting Provider Logo, so branded Providers retain their official identity and generic Providers gain an identity derived from Base URL without extra Owner setup.

**Blocked by:** 01 — Resolve Logo Domains through the backend.

**Status:** complete

- [x] SQLite and PostgreSQL persist a nullable Logo Domain through their shared Provider repository contract.
- [x] Existing branded Providers are backfilled from their Provider Template's official hostname; existing generic Providers derive a hostname from Base URL or receive null when derivation is impossible.
- [x] Creating a Provider with Logo Domain omitted uses the branded template hostname or, for a generic template, the submitted Base URL hostname.
- [x] Creating a Provider with Logo Domain explicitly null disables lookup and selects the generic Server icon.
- [x] Provider management responses round-trip the saved normalized hostname or null.
- [x] Provider list and detail surfaces resolve saved Logo Domains through Iroha's backend and no longer select imagery directly from template identity or external browser requests.
- [x] Empty or unresolved Logo Domains quietly render the generic Server icon.
- [x] Focused migration, repository, and HTTP tests cover both database dialects, backfill behavior, omission versus null, response shape, and resolver integration.
