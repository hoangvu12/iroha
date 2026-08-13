# 06 — Owner UI Provider detail page with per-key base URL override on key creation

**What to build:** The Owner can open the Provider detail page and manage every Upstream Key with its effective base URL; the Add Upstream Key form has an optional `baseUrl` field prefilled with the Provider's default.

**Blocked by:** 03 — HTTP inference routes renamed to Provider-scoped URLs with mixed-URL round-robin; 04 — HTTP admin routes renamed to Provider-scoped paths.

**Status:** ready-for-agent

- [ ] `ConnectionDetail` is renamed to `ProviderDetail`.
- [ ] The page renders the Provider's default base URL.
- [ ] Every Upstream Key on the Provider is listed with its effective base URL (the override if set, else the Provider's default), health, last probe, allowed/denied models, and account membership.
- [ ] The Add Upstream Key form has an optional `baseUrl` field prefilled with the Provider's default URL; a blank field means "inherit".
- [ ] The page exposes Upstream Account management (list, create, rename, delete) the same way it does for Provider Connections today.
- [ ] Every "Connection" label in the page is replaced with "Provider".
- [ ] Browser tests pass for add-key, edit-key, test-key, activate-key, disable-key, remove-key, and account lifecycle.