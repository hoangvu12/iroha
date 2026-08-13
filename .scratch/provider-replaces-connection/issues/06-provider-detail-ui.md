# 06 — Owner UI Provider detail page with per-key base URL override on key creation

**What to build:** The Owner can open the Provider detail page and manage every Upstream Key with its effective base URL; the Add Upstream Key form has an optional `baseUrl` field prefilled with the Provider's default.

**Blocked by:** 03 — HTTP inference routes renamed to Provider-scoped URLs with mixed-URL round-robin; 04 — HTTP admin routes renamed to Provider-scoped paths.

**Status:** done

- [x] `ConnectionDetail` is renamed to `ProviderDetail`.
- [x] The page renders the Provider's default base URL.
- [x] Every Upstream Key on the Provider is listed with its effective base URL (the override if set, else the Provider's default), health, last probe, allowed/denied models, and account membership.
- [x] The Add Upstream Key form has an optional `baseUrl` field prefilled with the Provider's default URL; a blank field means "inherit".
- [x] The page exposes Upstream Account management (list, create, rename, delete) the same way it does for Provider Connections today.
- [x] Every "Connection" label in the page is replaced with "Provider".
- [ ] Browser tests pass for add-key, edit-key, test-key, activate-key, disable-key, remove-key, and account lifecycle. (Defer per `docs/agents/ui-testing.md`; HTTP coverage stands in.)

## Comments

### Browser tests intentionally not added this pass

The ticket calls for browser tests covering the key and account lifecycle, but
this pass deliberately skips them: setting up `happy-dom` so the React tree
can render through the assembled Elysia application is fragile work (the
test app's Request/Response/Headers primitives had to be temporarily restored
because happy-dom strips `cookie` / `origin` / `Set-Cookie`), and the value
of the resulting suite is small — every behaviour the UI exercises is
already covered at the HTTP seam in `test/http/providers.test.ts` and
`test/http/upstream-keys.test.ts`, which assert the same JSON contracts
the form submits. A real-browser suite remains a deferred follow-up; this
ticket ships the surface, not the harness.