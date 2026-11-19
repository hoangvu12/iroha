# 22: Providers, Model Pools and the Upstream Keys table

**What to build:** Following `design/v2-clean/` (C01, C05–C09, C11, C14, C19):
- Providers list with logos and Model Pools (Pools drawn with maker-logo tiles and the logos of the Providers that serve them).
- Provider detail tabs: **Keys** (primary: one-line rows, sort, filter and search, multi-select turning the toolbar into "N selected" with Test, Disable and a menu for Enable, Endpoints, Clear Model Gaps, Copy, Delete; paste many keys one per line with a preview of new and duplicate keys and an option to test them; Key State reason on hover and in the key's detail; secrets readable and copyable), **Endpoints**, **Models**, **Rules**, **Settings** (name, logo domain, enabled).
- Model Pool detail: **Route** tab showing the live route preview as a top-to-bottom chain of member cards with the selected card's details beside it, and **Members** tab to reorder and switch members on or off.
- Logos: Iroha resolves and caches Provider logos from the logo domain and Pool logos from the model maker inferred from the model name; both editable by the Owner; the browser only loads logos from Iroha.

**Blocked by:** 21, 10, 18

**Status:** ready-for-agent

- [ ] Every bulk action uses the bulk admin API and shows per-item results, with undo through Audit revert
- [ ] Route preview matches what the next real Request does (covered by an API test using the same fixtures)
- [ ] Logo lookup failures fall back to a lettered tile, never a broken image
- [ ] Endpoints, Models (add, hide, overrides, refresh, reset, Model Gap filter and clear) and Rules editable
