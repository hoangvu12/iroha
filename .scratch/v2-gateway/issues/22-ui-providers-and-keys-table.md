# 22: Providers, Model Pools and the Upstream Keys table

**What to build:** Following `design/v2-clean/` (C01, C05–C09, C11, C14, C19):
- Providers list with logos and Model Pools (Pools drawn with maker-logo tiles and the logos of the Providers that serve them).
- Provider detail tabs: **Keys** (primary: one-line rows, sort, filter and search, multi-select turning the toolbar into "N selected" with Test, Disable and a menu for Enable, Endpoints, Clear Model Gaps, Copy, Delete; paste many keys one per line with a preview of new and duplicate keys and an option to test them; Key State reason on hover and in the key's detail; secrets readable and copyable), **Endpoints**, **Models**, **Rules**, **Settings** (name, logo domain, enabled).
- Model Pool detail: **Route** tab showing the live route preview as a top-to-bottom chain of member cards with the selected card's details beside it, and **Members** tab to reorder and switch members on or off.
- Logos: Iroha resolves and caches Provider logos from the logo domain and Pool logos from the model maker inferred from the model name; both editable by the Owner; the browser only loads logos from Iroha.

**Blocked by:** 21, 10, 18

**Status:** done

- [x] Every bulk action uses the bulk admin API and shows per-item results, with undo through Audit revert
- [x] Route preview matches what the next real Request does (covered by an API test using the same fixtures)
- [x] Logo lookup failures fall back to a lettered tile, never a broken image
- [x] Endpoints, Models (add, hide, overrides, refresh, reset, Model Gap filter and clear) and Rules editable

## Comments

**Done (branch `agent/t22`).**
- Backend: `internal/logos` resolves and caches Provider logos (logo domain, guessed from the base URL when unset) and Pool logos (maker from the model name) behind an injectable source (`testkit.NewLogos` in tests, never real sites); served only by Iroha's API (`internal/logos/routes.go`), letter fallback in the browser. `GET /api/overview` gives per-Provider and per-Pool counts for the lists and Members stats. `pools` is a reserved Provider handle. `TestTheRoutePreviewMatchesWhatTheNextRequestDoes` (`internal/gateway/preview_next_test.go`) checks the preview against the next real Request on the same fixtures.
- UI in `web/src/pages/providers/`: list (Providers and Pools with logo stacks), Provider tabs Keys / Endpoints / Models / Rules / Settings, Pool tabs Route / Members / Settings. Bulk key actions call the bulk APIs, show per-item results when anything fails, and offer Undo via Audit revert. Paste-many keys shows a dry-run New / Already added / Refused preview with "test after adding".
- One shared logo helper: `web/src/api/logos.ts` plus `ProviderTile` / `PoolTile` in `web/src/ui/LogoTile.tsx`, now used by Providers, Requests (`bits.tsx`), Audit Entries (`TargetIcon`) and Gateway Keys (its `logos.tsx` copy removed).
- Because POSTs are create-or-update by name, the New Provider, New Pool, Add endpoint and Add rule dialogs check the name first (list, then `GET` for archived/built-in) and refuse a taken name.
- Checked in headless Chrome on seeded fake data: light, dark, phone.

**Deferred:**
- Per-model and per-endpoint "Requests today" columns: no API gives these counts yet.
- Pool "Gateway Keys" and "Requests" tabs: Gateway Keys that reach a Pool show as chips on Members instead; Requests filtering by Pool is left to the Requests page.
- Route canvas zooms but does not drag-pan.
