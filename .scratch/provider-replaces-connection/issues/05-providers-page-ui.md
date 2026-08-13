# 05 — Owner UI Providers page with renamed entity and optional base URL on creation

**What to build:** The Owner sees a "Providers" page (not "Provider Connections"); can create a new Provider with an optional default base URL; sees one row per Provider with brand icon, traffic summary, and an Archived section.

**Blocked by:** 03 — HTTP inference routes renamed to Provider-scoped URLs with mixed-URL round-robin; 04 — HTTP admin routes renamed to Provider-scoped paths.

**Status:** ready-for-agent

- [ ] The "Provider Connections" page header is renamed to "Providers".
- [ ] The "New connection" CTA is renamed to "New provider".
- [ ] The new-Provider dialog accepts an optional `baseUrl` field; the field is empty by default and validated on submit.
- [ ] One row per Provider is rendered, with the brand icon (Provider Template aware), the Provider's effective default base URL, and the traffic summary.
- [ ] Archived Providers render under a separate section, preserving identity.
- [ ] Every "Connection" label in the page is replaced with "Provider" (or removed where the upstream brand name suffices).
- [ ] Browser tests pass for create, list, archive, and duplicate flows.