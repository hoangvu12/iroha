# 28: Tall dialogs scroll as a page

**What to build:** A dialog taller than the window can't be scrolled the way the Owner expects (2026-11-20): they want to scroll it with the page (the wheel anywhere, and the page's scroll bar), not inside a box within the dialog. Reference: shadcn/ui issue #16 (https://github.com/shadcn-ui/ui/issues/16), the "scrollable overlay" pattern: the layer behind the dialog is the scroll container (fixed, full window, `overflow-y: auto`, padding top and bottom), the dialog sits in it at its natural height, centred when it fits and starting near the top when it doesn't; the close button stays on the dialog. Check UI SDK's Dialog docs first (`web/node_modules/@ui-sdk/react/docs/`; it may ship a viewport/positioner part for this) and use what it gives.

- `ui/Dialog.tsx` (Dialog and the confirm/alert dialogs) for every dialog: Add keys, create dialogs, Model picker, Rule dialog, snippet dialog…
- A body that is scrolled inside today (`max-h-*` inner scroll areas) stops scrolling inside unless it's a list that must (e.g. a long picker list may keep its own scroll; say which and why).
- Wheel, touch, keyboard (Page Down/Space when focus is in the dialog body) scroll it; the page behind stays locked. The dialog's open/close motion (ticket 14) still looks right when it's scrolled.
- Phone width: same behaviour (or a full-height sheet if the design already does that).

**Blocked by:** none

**Status:** open

Owner request, 2026-11-20. Ticket 27 moves some details dialogs into sheets at the same time; touch `ui/Dialog.tsx` and dialog bodies only for scrolling.

- [ ] Tall dialogs scroll with the wheel anywhere on screen; short ones stay centred; tests
- [ ] Inner scroll areas removed where they're no longer needed; the exceptions are listed
- [ ] Checked in headless Chrome, light, dark and phone width, with a dialog taller than the window
