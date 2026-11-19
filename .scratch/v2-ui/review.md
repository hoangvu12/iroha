# Code review fixes (review of fc44965...f2d2230)

Branch `agent/uifix`. Every item of the review list was fixed. The "Not to change" items were left alone: clearing Model and Endpoint Gaps still doesn't ask first, Pool Members are still not paged, Audit Entries and Models are still unsorted, and the sheet stack still swaps a sheet of the same kind. The conventions are in `docs/agents/architecture.md`, under "Code review fixes" and the lines it corrected.

## Standards

1. **ScrollArea durations → tokens.** New tokens `--duration-scrollbar-in` (100 ms) and `--duration-scrollbar-out` (200 ms) in `styles/index.css`, pinned in `styles/motion.test.ts` and listed in the motion table. The bar uses `duration-scrollbar-out` and `data-visible:duration-scrollbar-in`. Test: `ui/ScrollArea.test.tsx`.
2. **`// Toast:` markers.** Added in `gateway-keys/CreateDialog.tsx` and `settings/AdminTokens.tsx` (the shared `UndoCreate` now holds both, see 6), `Keys.tsx` `reportBulk`, and per call in `Models.tsx`. The `/states` demo buttons got one too. Every `notify.*`, `notifyChange` and `toastDone` call outside `ui/toast.tsx` and `toastDone` itself now has a marker.
3. **Plain `<button>` → UI SDK.** There is a new `TextButton` (`ui/Button.tsx`, tones `link` and `quiet`) for buttons that look like links. Converted:
   - Picker header and rows, named e.g. "Change the model: o3 on openai", "Shape OpenAI Chat", "Send as Owner".
   - ChatPanel's Tools toggle and prompt chips.
   - The sidebar Chat button.
   - ScopeEditor's "Models of <handle>" button.
   - Keys: "Add a keyless key"; "Clear all Model Gaps"; each Gap's Clear, named "Clear the Model Gap for <model>" or "Clear the Endpoint Gap on <endpoint>"; "Change the Endpoints of <key>".
   - Providers list: "Make one".
   - Models: Gaps "Clear", named "Clear the Model Gaps of <model>".
   - Feed: LiveToggle, and "Clear filters" (quiet tone).
   - PoolRoute: "N more", named "Show N more ready keys".
   - Captured: Raw JSON and "Show all N characters".
   - Details: "View prompt and response".
   - Chip ×: an `IconButton` named "Remove filter <label>".

   Plain `<button>`s that remain, as documented exceptions: the canvas cards' select buttons in `PoolRoute.tsx` and `RouteView.tsx` ("UI ticket 11"), and the Rules dialog's hidden submit (`<button type="submit" hidden />`, not a control).
4. **Index keys.** Keys are now chosen by value: `key={r.name}` for bulk result rows and `key={r.secret}` for the Add keys preview. The feed chips use `key={c.label}`.
5. **URL state.** `lib/url-state.ts` adds `useUrlParams()` (`setParam`, `setParams`, `setSort`) and `patchParams`. Every write replaces the history entry. It is used by Keys, Gateway Keys list, Providers list, Models, Rules and Audit Entries; the Requests feed's `url-state.ts` uses `patchParams`. Test: `lib/url-state.test.tsx`. One change in behaviour: Audit Entries' "Clear filters" used to drop every param and now clears only `q`, `actor` and `resource`, as the other pages do.
6. **Create dialog duplication.** `UndoCreate` (`ui/SaveStatus.tsx`) is the footer Undo for Gateway Key and Admin Token. `errorText(e)` lives in `api/client.ts` and is used by both dialogs, the key page and `SaveStatus`; `pages/providers/api.ts` re-exports it.
7. **Toolbar search.** `ToolbarSearch` (`ui/Input.tsx`) is used by the 5 toolbars and by Audit Entries. Models used 300 px and now uses 320 px, which looks no different because the box is narrower than both.
8. **Auth-style labels.** `AUTH_STYLES` and `authStyleLabel()` in `pages/providers/api.ts` hold one wording, used by the Endpoint dialog's select and the Endpoint sheet. The sheet shows "x-api-key: <key>" or "?key=<key>" when a parameter is set. Test: `sheets/RecordSheets.test.tsx`.
9. **"credential" in copy.** Replaced with the glossary's words ("key", "no key", "Keyless: no key is sent") in the Endpoint sheet, the Key sheet, Keys and the Providers list.

## Spec

10. **ModelPicker on ScrollArea.** `ScrollArea` now takes `viewportRef`, `onScroll` and `style`. ModelPicker's virtual list and its chips row are Scroll Areas. The list keeps its scroll-to-top on a new search. Tests: `ui/ScrollArea.test.tsx` and `ScopeEditor.test.tsx`, where scrolling a list of 100 models renders the last rows.
11. **Numbered pages choice.** The feed's toolbar menu was "Columns" and is now "View": Show columns, then "Load Requests" with "Live, load older as you scroll" or "Numbered pages". On phones it is a "Load Requests" submenu in the filter menu. The choice is stored in `localStorage["iroha:requests:paging"]` (try/catch), and `FEED_PAGING` is gone. `<RequestsFeed paging>` still forces a mode, for tests. Test: `Feed.test.tsx`.
12. **Upstream Key sheet copy.** The Key sheet has Name (copy) and Key (masked, with copy). The secret is copied because the Keys tab already shows and copies it. Test: `RecordSheets.test.tsx`.

## Earlier notes

13. **Chat close focus.** The panel remembers the last element focused outside it. When it closes (its X, the sidebar button, or C from inside), focus goes back there if that element is still on the page. Before, focus went to the body. Tests: `app/ChatSheet.test.tsx`. In Chrome, closing with X put focus on the sidebar's Chat button.
14. **Picker popup classes.** `ui/popup.ts` gained `popupMotionClass`, the recipe without the surface, and `popupClass` is now the surface plus that recipe. The Picker keeps its own surface (wider radius, no padding) and uses `popupMotionClass`. Test: `Picker.test.tsx`.
15. **Typed durations.** A grep of `web/src` turned up only the ScrollArea values (fixed in 1). What remains is intended:
   - `ease-[ease]` is the documented CSS keyword.
   - `data-instant:duration-0` on tooltips is "instant", not a timing.
   - `skeleton-hold 150ms` in `index.css` is the skeleton's load threshold, not motion.

## Checks

- `npm --prefix web run build` passes (tsc and vite). Web suite: see the commit message's results. Go is unchanged.
- Headless Chrome screenshots, in light, dark and phone, are in `iroha-v2-notes/v2-ui/shots/review/` (outside the repo): feed View menu, chips with × and Clear filters, numbered pages, phone filter menu, Keys toolbar, Key and Endpoint sheets, ModelPicker scrolled, chat Picker, and chat close focus.

## Found during the review, then fixed

- **Phone submenus off screen.** On phones (390 px), every submenu of the Requests filter menu (Caller, Provider or Pool, Model, Status, Time, Load Requests) opened partly off the left edge. Status, for example, measured −55 px. This was already so before these fixes.
  - Cause: the filter menu sits at the right, so there's no room beside it on either side. UI SDK's placement (`core/foundation/platform/position.js`) flips a `right` placement to `left` but only shifts it along that side (vertically). Sideways, it is clamped only when the submenu is no wider than its item.
  - Fix: UI SDK's own positioning, no custom layout. `SubMenu` (`ui/Menu.tsx`) opens with `side="bottom"` on phones (`useIsPhone`, < 768 px). There the SDK shifts it sideways to stay within `collisionPadding`, and `--available-height` still caps its list. Wider screens keep `right`. `SubMenu` is the only submenu in the app, so this covers every one.
  - Tests: `ui/Menu.test.tsx`, "on a wide screen a submenu opens beside its item" and "on a phone a submenu opens under its item".
  - Chrome at 390 px: every submenu measured on screen (left 136–154 px, right at most 382 px). Shots `submenu-phone-*-light/dark.png`. The desktop filter submenu still opens to the right (`submenu-desktop-filter-light.png`).
  - On a phone, the submenu now covers the menu items under its trigger while it is open. Escape or a press outside closes it as before.
