# 28: Tall dialogs scroll as a page

**What to build:** A dialog taller than the window can't be scrolled the way the Owner expects (2026-11-20): they want to scroll it with the page (the wheel anywhere, and the page's scroll bar), not inside a box within the dialog. Reference: shadcn/ui issue #16 (https://github.com/shadcn-ui/ui/issues/16), the "scrollable overlay" pattern: the layer behind the dialog is the scroll container (fixed, full window, `overflow-y: auto`, padding top and bottom), the dialog sits in it at its natural height, centred when it fits and starting near the top when it doesn't; the close button stays on the dialog. Check UI SDK's Dialog docs first (`web/node_modules/@ui-sdk/react/docs/`; it may ship a viewport/positioner part for this) and use what it gives.

- `ui/Dialog.tsx` (Dialog and the confirm/alert dialogs) for every dialog: Add keys, create dialogs, Model picker, Rule dialog, snippet dialog…
- A body that is scrolled inside today (`max-h-*` inner scroll areas) stops scrolling inside unless it's a list that must (e.g. a long picker list may keep its own scroll; say which and why).
- Wheel, touch, keyboard (Page Down/Space when focus is in the dialog body) scroll it; the page behind stays locked. The dialog's open/close motion (ticket 14) still looks right when it's scrolled.
- Phone width: same behaviour (or a full-height sheet if the design already does that).

**Blocked by:** none

**Status:** done

Owner request, 2026-11-20. Ticket 27 moves some details dialogs into sheets at the same time; touch `ui/Dialog.tsx` and dialog bodies only for scrolling.

- [x] Tall dialogs scroll with the wheel anywhere on screen; short ones stay centred; tests
- [x] Inner scroll areas removed where they're no longer needed; the exceptions are listed
- [x] Checked in headless Chrome, light, dark and phone width, with a dialog taller than the window

## Comments

**Built** (agent/ui28):
- `ui/Dialog.tsx`: the "scrollable overlay". UI SDK's dialog content part is now a transparent layer over the whole window and the scroll container (`fixed inset-0 overflow-y-auto overscroll-contain`); a frame inside centres the visible dialog (`[data-dialog-panel]`) when it fits and starts it at the top padding when it doesn't. The title, body, footer and Close button all sit in that panel; there is no inner `ScrollArea` any more. This covers every `Dialog`, `ConfirmDialog`, `TypeToConfirmDialog` and `useConfirm`. UI SDK's docs have no viewport or positioner part for a centred dialog: its viewport only exists for `presentation="sheet"`. So the content part serves as the layer.
- Because the layer covers the window, UI SDK counts every press as inside the dialog. `useAroundPress` closes a `Dialog` when a press starts and ends on the layer or the frame. A press on the scroll bar doesn't close it, and neither does a text selection dragged out of a field. A press outside a nested dialog closes only that one. Alert dialogs still don't close this way.
- Motion (ticket 14): the scale and fade stay on the content part, which is now the layer. The dialog therefore grows and shrinks from the middle of the window, however far it is scrolled. Tokens and the existing class tests are unchanged.
- Phone: the same behaviour (16 px around). The frame's bottom padding adds UI SDK's `--keyboard-inset`.

**Inner scroll areas** (audit of every `Dialog` body in `web/src`):
- Removed:
  - `pages/providers/Keys.tsx` `ResultsDialog` (per-key test results, `max-h-[50vh]`).
  - `pages/chat/SnippetDialog.tsx` code block (`max-h-[50dvh]`; long lines still scroll sideways).
  - `pages/gateway-keys/ModelPicker.tsx` picked-model chips (`max-h-24`; at most 40 chips).
- Kept, with the reason:
  - `ModelPicker`'s model list: it is virtualised and draws only the rows in its own 300 px view of thousands of models.
  - `ScopeEditor`'s "Providers and Pools" list (Create key and Edit access): a picker list under its own search field.
  - Add keys' "keys found" preview (`Keys.tsx`, `max-h-[240px]`): a paste can be hundreds of keys, and the "Test each new key" switch and the Add button sit below it.
- No other dialog body had an inner scroll: Endpoint, Rule, Add Provider, New Pool, Pool member, Models, Admin Tokens, Sign-in, Gateway Key page dialogs and KeyDialog.

**Test-first** (the `tdd` skill). The seams are the public `Dialog` / `ConfirmDialog` components and the dialog bodies named above. Each slice was red, then green:
- `ui/Dialog.test.tsx`: the layer scrolls, the body has no scroll box, and the panel holds the body, footer and Close. A press around closes the dialog and focus returns; a press inside keeps it open. A selection drag keeps it open. A press around a nested dialog closes only that one. An alert dialog ignores a press around it.
- `pages/gateway-keys/ScopeEditor.test.tsx`: the chips flow, and the only scroller is the model list.
- `pages/providers/ResultsDialog.test.tsx`: new; `ResultsDialog` is now exported for it.
- `pages/chat/SnippetDialog.test.tsx`: new.
- Results: `npm --prefix web run build` passes, and the web tests pass (58 files, 334 tests) before the merge.

**Browser check** (headless Chrome, real CDP wheel, mouse and key events, scroll bars shown). Screenshots are in `iroha-v2-notes/v2-ui/shots/28/` (light, dark and phone 390 px) and the script is `check28.mjs` there. On a seeded testkit:
- A short alert dialog sits centred (269 px above and below in a 720 px window).
- New Gateway Key with Only some is taller than the window. The wheel at the window's edge, outside the panel, scrolls it. The page stays at its scroll position with `overflow: hidden`.
- The Upstream Key dialog in a 480 / 520 px window scrolls with the wheel outside it. Page Down with focus on the title scrolls 0 → 192, and Space scrolls to the end.
- A press around the dialog while it is scrolled closes it, and the exit is caught mid-way: it shrinks and fades from the window's middle.

**Deferred / notes**:
- Ticket 27 moves KeyDialog into KeySheet; until it merges, KeyDialog scrolls as a page like the rest.
- Keys.tsx changes are small and far from KeyDialog: the `ResultsDialog` export and wrapper, plus a comment at the Add keys preview.
- The dark-mode backdrop is as faint as before; it wasn't changed here.
