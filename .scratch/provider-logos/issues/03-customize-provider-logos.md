# 03 — Let Owners customize, preview, and clear Provider Logos

**What to build:** Let the Owner control a Provider's Logo Domain from the Add and Edit Provider flows while keeping automatic defaults helpful and manual choices stable.

**Blocked by:** 02 — Give existing and newly created Providers default Logos.

**Status:** complete

- [x] Add and Edit Provider show Logo domain immediately after Base URL and accept either a hostname or an HTTP(S) URL while saving only the normalized hostname.
- [x] A non-empty value that cannot produce a valid hostname prevents saving and displays an inline validation error; empty input saves null.
- [x] Branded template selection suggests its official hostname, while a generic Provider derives its suggestion from a valid Base URL after a debounce.
- [x] Template and Base URL changes continue autofilling only while Logo domain is untouched; an Owner-edited or cleared value is not overwritten during that form session.
- [x] A debounced, theme-aware preview retains its previous image while pending and quietly falls back to the generic Server icon when empty, invalid, or unresolved.
- [x] A populated field shows an X overlaid at its far-right edge without consuming adjacent layout space, reserves text padding beneath it, and exposes the accessible name `Clear Logo domain`.
- [x] Clearing immediately shows the generic icon and prevents later Base URL changes from repopulating the field during that form session.
- [x] An update with Logo Domain omitted leaves it unchanged, a hostname replaces it, and null disables it.
- [x] When a generic Provider's saved Logo Domain matches its old Base URL hostname, changing Base URL updates both; a custom hostname or null remains unchanged.
- [x] Duplicating copies the Logo Domain including null, archiving retains it, and purging removes it with the Provider.
- [x] Focused repository, service, and HTTP tests cover normalization, update semantics, synchronization, duplication, and archive behavior; no browser test harness or required manual browser pass is added.

## Comments

- UI behavior is covered at the supported HTTP seam; no browser or JS-DOM harness was added, per `docs/agents/ui-testing.md`.
- PostgreSQL conformance remains available through `IROHA_TEST_POSTGRES_URL`; it was skipped locally because no disposable database URL was configured.
