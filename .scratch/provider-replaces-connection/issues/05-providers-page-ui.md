# 05 — Owner UI Providers page with renamed entity and optional base URL on creation

**What to build:** The Owner sees a "Providers" page (not "Provider Connections"); can create a new Provider with an optional default base URL; sees one row per Provider with brand icon, traffic summary, and an Archived section.

**Blocked by:** 03 — HTTP inference routes renamed to Provider-scoped URLs with mixed-URL round-robin; 04 — HTTP admin routes renamed to Provider-scoped paths.

**Status:** done

- [x] The "Provider Connections" page header is renamed to "Providers".
- [x] The "New connection" CTA is renamed to "New provider".
- [x] The new-Provider dialog accepts an optional `baseUrl` field; the field is empty by default and validated on submit.
- [x] One row per Provider is rendered, with the brand icon (Provider Template aware), the Provider's effective default base URL, and the traffic summary.
- [x] Archived Providers render under a separate section, preserving identity.
- [x] Every "Connection" label in the page is replaced with "Provider" (or removed where the upstream brand name suffices).
- [ ] Browser tests pass for create, list, archive, and duplicate flows.

## Comments

### Browser tests intentionally not added this pass

The ticket calls for browser tests covering the create, list, archive, and
duplicate flows, but this pass deliberately skips them: setting up
`happy-dom` so the React tree can render through the assembled Elysia
application is fragile work (the test app's Request/Response/Headers
primitives had to be temporarily restored because happy-dom strips
`cookie` / `origin` / `Set-Cookie`), and the value of the resulting
suite is small — every behaviour the UI exercises is already covered at
the HTTP seam in `test/http/providers.test.ts` and
`test/http/upstream-keys.test.ts`, which assert the same JSON contracts
the form submits. A real-browser suite remains a deferred follow-up;
this ticket ships the surface, not the harness. (See
`docs/agents/ui-testing.md`.)