# 21: Destructive actions look dangerous and confirm

**What to build:** The Owner noticed actions that remove things with no danger colour and no confirmation (e.g. removing a model from a model list). Audit every action in `web/src` that deletes, removes, revokes, clears or detaches something the Owner saved (row menus, bulk bars, buttons, icon buttons, chips with an ×, list rows, settings danger zones), across Providers, Upstream Keys, Endpoints, Models, Failure Rules, Pools and their members, Gateway Keys and their scopes, Admin Tokens, signed-in browsers and Audit Entries. List them all in Comments with file:line and before/after.

Build one reusable piece in `web/src/ui/` for this (e.g. a `danger` tone on Button, IconButton and Menu item, plus a `ConfirmAction` / `useConfirm` that wraps any trigger in the existing UI SDK `ConfirmDialog`, naming what goes and how many), and move every destructive action onto it:

- Danger tone (the `danger` tokens in `styles/index.css`, never a hard-coded colour) on every destructive trigger, including menu items and × buttons.
- A confirmation naming what goes ("Remove gpt-4o from Pool fast?"; bulk: "Delete 12 keys?"). Revokes keep `TypeToConfirmDialog`.
- Not confirmed: removing a row from a draft that isn't saved yet (nothing is lost until Save); those still get the danger tone on hover/focus.
- After confirming, the result follows ticket 04's rule (Undo toast when the row is gone).
- Update the Conventions line in `docs/agents/architecture.md` ("Confirm only deletes...") to the new rule and document the component, so tickets 06–09 use it for row and bulk actions.

**Blocked by:** 03

**Status:** open

Owner request, 2026-11-19 (not in the original spec). Spec story 16 (accessible names) applies: the confirm button says what it does ("Remove model"), not "OK".

- [ ] Every destructive action found is listed in Comments; none is left plain or unconfirmed (except unsaved draft rows)
- [ ] One reusable danger/confirm component in `web/src/ui/`, with tests (keyboard: Escape cancels, focus returns to the trigger; agent test)
- [ ] Checked in headless Chrome, light, dark and phone width; architecture.md convention updated

## Comments
