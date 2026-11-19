# 21: Destructive actions look dangerous and confirm

**What to build:** The Owner noticed actions that remove things with no danger colour and no confirmation (e.g. removing a model from a model list). Audit every action in `web/src` that deletes, removes, revokes, clears or detaches something the Owner saved (row menus, bulk bars, buttons, icon buttons, chips with an ×, list rows, settings danger zones), across Providers, Upstream Keys, Endpoints, Models, Failure Rules, Pools and their members, Gateway Keys and their scopes, Admin Tokens, signed-in browsers and Audit Entries. List them all in Comments with file:line and before/after.

Build one reusable piece in `web/src/ui/` for this (e.g. a `danger` tone on Button, IconButton and Menu item, plus a `ConfirmAction` / `useConfirm` that wraps any trigger in the existing UI SDK `ConfirmDialog`, naming what goes and how many), and move every destructive action onto it:

- Danger tone (the `danger` tokens in `styles/index.css`, never a hard-coded colour) on every destructive trigger, including menu items and × buttons.
- A confirmation naming what goes ("Remove gpt-4o from Pool fast?"; bulk: "Delete 12 keys?"). Revokes keep `TypeToConfirmDialog`.
- Not confirmed: removing a row from a draft that isn't saved yet (nothing is lost until Save); those still get the danger tone on hover/focus.
- After confirming, the result follows ticket 04's rule (Undo toast when the row is gone).
- Update the Conventions line in `docs/agents/architecture.md` ("Confirm only deletes...") to the new rule and document the component, so tickets 06–09 use it for row and bulk actions.

**Blocked by:** 03

**Status:** done

Owner request, 2026-11-19 (not in the original spec). Spec story 16 (accessible names) applies: the confirm button says what it does ("Remove model"), not "OK".

- [x] Every destructive action found is listed in Comments; none is left plain or unconfirmed (except unsaved draft rows)
- [x] One reusable danger/confirm component in `web/src/ui/`, with tests (keyboard: Escape cancels, focus returns to the trigger; agent test)
- [x] Checked in headless Chrome, light, dark and phone width; architecture.md convention updated

## Comments

**Built.** `web/src/ui/Confirm.tsx`: `useConfirm()` (`ask(question)` + one `dialog` to render) and `ConfirmAction` (wraps one trigger), over the existing UI SDK `ConfirmDialog`/`TypeToConfirmDialog` (`typeToConfirm` for revokes). Danger tone: `danger` on `Button` (red text and border on any variant; solid red stays on the confirm button only), `danger="hover"` (neutral at rest, red on hover/focus, for an action on every row of a list), `danger` on `IconButton` (red on hover/focus; new `size="xs"` for a chip's ×), and `MenuItem danger` now also tints red when highlighted. All from the `danger` tokens. Documented as "UI ticket 21" in `docs/agents/architecture.md`, Conventions line rewritten.

**Test-first** with the `tdd` skill: `ui/Confirm.test.tsx` started red (no module), then each behaviour (Escape cancels and focus returns to the trigger; to the ⋯ trigger from a menu item; confirm runs once and a clickable row never sees the clicks; type-to-confirm; tone classes; agent test needing a person to approve) one at a time. The tone test and the click-isolation test passed on first run because I had written that code with the component (not strictly red first). `pages/providers/Models.test.tsx` (the Owner's example) was red against the old menu, green after.

**Audit** (after = this branch; line numbers on this branch):

| Where | Action | Before | After |
|---|---|---|---|
| `pages/providers/Models.tsx:86` | Remove a model the Owner added from the list | plain item, acted at once | `danger` item "Remove from the list…", asks "Remove my-model from acme?", "Remove model", Undo toast |
| `pages/providers/Models.tsx:178` | Forget discovered models | danger + confirm | unchanged |
| `pages/providers/Keys.tsx:628` | Key row menu Delete | danger + confirm | unchanged |
| `pages/providers/Keys.tsx:263` | Bulk Delete ("Delete 12 keys?") | danger + confirm | unchanged |
| `pages/providers/Keys.tsx:1264` | Key dialog Delete | ghost with hard-coded `text-danger-text` class, confirm | `variant="ghost" danger`, "Delete…" |
| `pages/providers/Endpoints.tsx:54` | Endpoint Delete | danger + confirm | unchanged |
| `pages/providers/Rules.tsx:44` | Delete rule | danger + confirm | unchanged |
| `pages/providers/Rules.tsx:44` | Restore the built-in rule (deletes the Owner's version) | plain, confirm | `danger` |
| `pages/providers/PoolMembers.tsx:90` | Remove Pool member | danger + confirm "Remove dashscope from fast?" | title also names the model: "Remove dashscope (qwen3) from fast?" |
| `pages/providers/PoolSettings.tsx:127` | Delete Pool | class overrides, type-to-confirm | `danger`, unchanged dialog |
| `pages/providers/ProviderSettings.tsx:125` | Archive Provider | class overrides, confirm | `danger` |
| `pages/gateway-keys/List.tsx:134,137` | Revoke / Delete in row menu | danger + type-to-confirm / confirm | unchanged |
| `pages/gateway-keys/List.tsx:266` | Delete a revoked key (trash icon) | plain icon button, confirm | `IconButton danger` |
| `pages/gateway-keys/KeyPage.tsx:124,137` | Danger zone Revoke / Delete | `!important` class overrides | `danger` |
| `pages/gateway-keys/ModelPicker.tsx:98` | × on a picked model chip (scope draft) | plain `<button>` (not an agent part) | `IconButton size="xs" danger`, no confirm (draft until Save) |
| `pages/settings/AdminTokens.tsx:88` | Revoke Admin Token | danger + type-to-confirm | unchanged |
| `pages/settings/SignIn.tsx:85` | Sign out the others | plain, confirm | `danger`, "Sign out the others…" |
| `pages/settings/SignIn.tsx:173` | Sign out one other browser | plain, confirm | `danger="hover"`, named "Sign out <browser>", "Sign out…" |
| `pages/settings/AuditEntries.tsx:358` | Revert of a change that created records (it deletes them) | plain, acted at once | `danger="hover"` "Revert…", asks "Revert and delete deploy-script?", errors inline; Reverts of updates/deletes stay plain and act at once |
| `pages/chat/ChatPanel.tsx:81` | Delete this chat (browser storage, no Undo) | danger, no confirm | asks "Delete <chat>?", "Delete chat" |
| `pages/states/index.tsx` | Showcase | plain triggers, solid red on a bulk bar | danger triggers, `ConfirmAction` icon button, draft chip × |

Reviewed and left plain (not destructive, or nothing saved): Clear Model Gaps / Clear Endpoint Gaps (menus and inline Clear links; design C25 says they rely on Undo), Disable, Hide from Callers, Unpin a discovered model (stays listed), Restrict to working Endpoints, filter chip × and Clear filters/Clear selection, the Owner's own Sign out (Shell, Sign-in table), Close buttons, Gateway Key access ticks (a draft dialog).

**Browser check** (headless Chrome, seeded testkit): light, dark and 390 px: `C:\Users\ADMIN\Desktop\nguyenvu\iroha-v2-notes\v2-ui\shots\21\` (Models confirm light/dark/phone, Pool member confirm, Gateway Key danger zone light/dark, revoked keys, Provider settings dark, Audit Entries revert-and-delete and list, Sign-in phone dark, `/states` light/dark/phone). The first Audit Entries shot showed a wall of red (most entries are creates), which is why `danger="hover"` exists. The hover-only red on icon buttons is covered by class tests, not a screenshot (the script can't hover).

**Notes.** Ticket 04's result rules are kept: confirmed deletes still toast Undo through `notifyChange` from `onConfirm`. `ui/toast.test.tsx` "an action on a toast runs and closes it" failed once under a full parallel run and passed on every rerun; I didn't touch it, so it looks like a timing flake.
