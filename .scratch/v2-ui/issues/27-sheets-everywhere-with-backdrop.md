# 27: Sheets have a backdrop, close on a click outside, and show every record's details

**What to build:** Changes to the record sheet stack (`web/src/sheets/`, tickets 10, 11, 15) asked by the Owner (2026-11-20):

1. **Backdrop.** While any sheet is open, a backdrop dims the page behind the stack (design tokens, light and dark), fading in and out on the sheet tokens with the stack (ticket 15's motion; reduced motion: fade or instant). One backdrop for the whole stack, not one per sheet.
2. **A click outside closes.** A click or tap on the backdrop closes the whole stack. A click on a lower sheet still brings it forward (closes those above it, as today). Escape still closes the top sheet. The chat panel stays above the backdrop and usable while sheets are open (Test in Chat from a sheet keeps the sheet); a click in the chat panel doesn't close sheets. Back still behaves as today. Pages behind can't be clicked while the backdrop is up (the old "page stays usable beside a sheet" behaviour goes; this is the Owner's decision). Check focus: after closing by backdrop, focus returns to what opened the first sheet.
3. **Details in sheets, not dialogs.** Record details still open in dialogs in places, e.g. an Upstream Key's details (`KeyDialog`, `pages/providers/Keys.tsx:927-1213`: state, key reveal/copy/replace, name, Model Gaps, Endpoints, Added/Last used, Delete/Disable/Test in Chat/Test). Show them in the record's sheet (`sheets/records/KeySheet.tsx`, with everything KeyDialog has, then delete KeyDialog) and keep the URL deep link working (old `?key=` links redirect to the sheet). Audit every other Dialog in `web/src` (list in Comments with file:line): a dialog that shows or edits an existing record (Endpoint, Model, Pool member, Failure Rule, Gateway Key, Admin Token…) becomes that record's sheet when a sheet kind exists or fits; create dialogs, confirms, pickers and the snippet dialog stay dialogs. Say for each what you did and why.

**Blocked by:** none

**Status:** done

Owner request, 2026-11-20. Ticket 31 (Failure Rules view) runs at the same time and touches `pages/providers/Rules.tsx`; if Failure Rules get a sheet, keep the change there small and say so.

- [x] One backdrop under the stack, animated with it, light and dark; tests
- [x] Backdrop click closes the stack; lower sheet click cuts back; Escape, Back, focus and the chat panel behave; tests incl. agent test
- [x] Upstream Key details live in KeySheet (KeyDialog gone, old links redirect); every other details dialog audited and moved where it fits
- [x] Checked in headless Chrome, light, dark and phone width

## Comments

**Built** (branch `agent/ui27`; details in `docs/agents/architecture.md`, "UI ticket 27"):

- **Backdrop** (`sheets/SheetStack.tsx`): one `data-sheet-backdrop` element for the whole stack, always mounted, `data-open` while a sheet is open. It uses `bg-overlay` at `z-[25]`, so it sits above the page and sidebar (z-20) and under the chat panel (z-30); the sheets are in the top layer above both. It fades on `--duration-sheet-in`/`--duration-sheet-out` with `ease-drawer`, so it moves with the stack and is instant under reduced motion.
- **Click outside:**
  - A click on the backdrop closes the whole stack. A press that only dismissed a menu or select inside a sheet doesn't.
  - A click on a lower sheet closes the sheets above it, except when a link in it opened a record, the click was in a menu or dialog opened from it, or it ended a text selection.
  - `close(index)` with nothing above is now a no-op (no history step).
  - Escape and Back are unchanged. The chat panel stays usable and a click in it keeps the sheets.
  - The page behind can't be clicked. Keyboard focus is not trapped, because the chat panel must stay reachable.
  - Focus returns to what opened the first sheet, even when a backdrop click closes two sheets at once.
- **Overlay token (orchestrator's note from ticket 28):** the sheet backdrop and the dialog backdrop (`ui/Dialog.tsx` `backdropClass`) use the same token, `--overlay` / `bg-overlay`; I added no new one. The dark value was very faint, so I raised it from `rgb(0 0 0 / 0.55)` to `0.7` (`styles/index.css`). Both backdrops now read alike and visibly in dark mode. Light stays at 0.12.
- **KeySheet** (`sheets/records/KeySheet.tsx`) has everything KeyDialog had:
  - State with its Rule and "Open the Request".
  - The key: show/hide, copy, Replace.
  - Name with Rename and copy.
  - Model Gaps and cooling models, with Clear and Clear all.
  - Endpoints: Change, Endpoint Gaps with Clear, and Restrict to working Endpoints.
  - Added and Last used.
  - Test (results open `ResultsDialog`), Disable/Enable, Test in Chat, and Delete… (asks first, closes the sheet, toast with Undo).
  - Results show in place (`useSave`). A rename moves the sheet to the new name without a reload.
  - KeyDialog is deleted. The Keys tab's rows open the sheet, and `?key=<name>` is rewritten (replace) to `sheet=key:<handle>/<name>`.
- **EndpointSheet** gained Edit: the Facts become the fields (shared with Add endpoint through `EndpointFields`/`endpointBody`), with Cancel and Save. Save shows its result in the sheet, and a rename moves the sheet. The Endpoints tab's rows and the row menu's "Edit…" open the sheet; Edit… opens it on its fields through `sheets/records/editing.ts`. The Endpoint edit dialog is gone (`EndpointDialog` became `AddEndpointDialog`, add only).

**Dialog audit** (line numbers after merging v2-ui at 586ec69):

| Dialog | Where | Done | Why |
|---|---|---|---|
| KeyDialog | was `pages/providers/Keys.tsx:927-1213` | Moved to KeySheet, deleted | The ticket's main case |
| Endpoint edit (`EndpointDialog` with an endpoint) | `pages/providers/Endpoints.tsx` (was the same dialog as Add) | Moved to EndpointSheet's Edit | Edits an existing record, and the `endpoint` kind exists |
| AddEndpointDialog | `pages/providers/Endpoints.tsx:255` | Kept | Create |
| AddKeysDialog | `pages/providers/Keys.tsx:660` | Kept | Create |
| ResultsDialog | `pages/providers/Keys.tsx:609` | Kept | A list of test results, not a record |
| EndpointsDialog | `pages/providers/Keys.tsx:833` | Kept | Picker (a key's Endpoints), opened over the key's sheet |
| AddProviderDialog, NewPoolDialog | `pages/providers/List.tsx:354`, `:490` | Kept | Create |
| AddModelDialog | `pages/providers/Models.tsx:411` | Kept | Create |
| ModelDialog | `pages/providers/Models.tsx:473` | **Deferred**, kept | There is no Model sheet kind (ticket 11 decided models aren't records with their own sheet) and no API that fetches one model. A Model sheet needs a kind, a fetch and a decision on its identity first. |
| AddMemberDialog | `pages/providers/PoolMembers.tsx:300` | Kept | Create. Pool members have no details or edit dialog. |
| RuleDialog (add) | `pages/providers/Rules.tsx:127` | Kept | Create |
| RuleDialog (edit) | `pages/providers/Rules.tsx:128`, `:261` | **Deferred**, kept | There is no Failure Rule sheet kind, and ticket 31 just reshaped this view (Flow view). A rule sheet should come with a follow-up so the two don't fight. I made no change in `Rules.tsx`. |
| CreateDialog (Gateway Key) | `pages/gateway-keys/CreateDialog.tsx:17` (`:66`, `:124`) | Kept | Create, and the created key's one-time secret |
| AccessDialog | `pages/gateway-keys/KeyPage.tsx:306` | **Deferred**, kept | It edits one field (access) on the Gateway Key's own full page. Opening the same key's sheet over its page to edit it would be odd. The Gateway Key sheet could take an access editor later. |
| ModelPicker | `pages/gateway-keys/ModelPicker.tsx:65` | Kept | Picker |
| RevokeDialog, DeleteDialog | `pages/gateway-keys/confirm.tsx:47`, `:53` | Kept | Confirms |
| CreateDialog (Admin Token) | `pages/settings/AdminTokens.tsx:163` (`:202`, `:231`) | Kept | Create, and the created token's one-time secret |
| PasswordDialog | `pages/settings/SignIn.tsx:219` | Kept | The Owner password is a setting, not a record |
| SnippetDialog | `pages/chat/SnippetDialog.tsx:15` | Kept | The snippet stays a dialog (ticket) |
| ConfirmDialog / TypeToConfirmDialog | `pages/providers/PoolSettings.tsx:136`, `pages/providers/ProviderSettings.tsx:143`, `pages/states/index.tsx:101`, `:109`, `ui/Confirm.tsx` | Kept | Confirms |
| Sheet frames | `sheets/SheetStack.tsx:315` | n/a | The sheets themselves (non-modal Dialog) |

**Test-first:** I used the tdd skill, red then green one slice at a time. This run couldn't ask about seams, so I tested at the ones earlier sheet tickets used: the rendered stack through the URL (`SheetStackProvider` + router), the user's clicks and keys, and agent tests through `createAgent`.

- New: `sheets/backdrop.test.tsx` (4), `sheets/KeySheet.test.tsx` (6, incl. an agent test), `sheets/EndpointSheet.test.tsx` (5, incl. an agent test).
- Updated: `SheetStack.test.tsx`, `RecordSheets.test.tsx`, `Links.test.tsx`, `pages/providers/Keys.test.tsx`, `Endpoints.test.tsx`.
- Mutation note: the jsdom tests don't fail when I remove the `focusAfter` opener chain or the backdrop's `mousedown` preventDefault. UI SDK only returns focus when it was still in the closing popup, so both are kept as defensive code, and the browser check covers them (a backdrop click on a two-sheet stack returns focus to key-3's row).

**Checks:**

- `npm --prefix web run build` passes.
- `npm --prefix web test`: 64 files, 391 tests pass.
  - Under parallel load from other worktrees, one unrelated test can time out and pass alone: `requests/Feed.test.tsx` "numbered pages" earlier, `gateway-keys/List.test.tsx` agent sort once after the merge. Neither is in this ticket's area.

**Browser check:** headless Chrome over CDP with real mouse events, against a seeded local Iroha (`check27.mjs`). Screenshots and `check27.log` are in `iroha-v2-notes/v2-ui/shots/27/`.

- Light and dark: a row click opens the key sheet with the backdrop up (opacity 1, z 25). Opening the Provider from the key's title stacks two sheets over one backdrop. A click on the lower sheet closes the Provider. A backdrop click closes everything, and focus is back on the row ("Open key-2"), also from a two-sheet stack ("Open key-3").
- The page behind can't be clicked: `elementFromPoint` over a row is the backdrop. Escape closes one sheet.
- Escape in the Endpoints picker closes only the picker.
- Test in Chat keeps the sheet. The chat sits at z 30, and a click in its textarea keeps the sheets.
- The old `?key=key-3` link becomes `sheet=key:dashscope/key-3`.
- The backdrop fades in over about 250 ms, and is instant under reduced motion.
- Endpoint Edit in its sheet works, light and dark.
- Phone (390 px), light and dark: the sheet is full screen, with no sideways scroll.

**Notes and deferrals:**

- Deferred: the Model details dialog, the Failure Rule edit dialog and the Gateway Key Access dialog (reasons in the table).
- Requests' Route view "Open key" link (`pages/requests/RouteView.tsx:473`) still builds `?key=`. The redirect turns it into the sheet; I didn't touch that file, to stay in my area.
- `RecordLink drop` is now unused (it existed for the key dialog) and is kept for any future dialog the URL holds.
