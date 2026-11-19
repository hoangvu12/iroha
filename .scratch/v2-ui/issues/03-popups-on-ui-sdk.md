# 03: Popups and controls on UI SDK; drop Radix and Sonner

**What to build:** Move every dialog, confirmation, menu, tooltip, popover, select, combobox, switch, checkbox, segmented control and toast in `web/src` to the UI SDK component the skill's build-interface table names for it (Dialog, Alert Dialog with `AlertDialogClose value="confirm"`, Menu, Tooltip, Popover, Select, Combobox, Switch, Checkbox, Segmented Control, Toast with `OverlayHost` mounted once). That includes `web/src/ui/Dialog.tsx`, the row menus, the chat panel's model Picker and settings, the Gateway Key scope editor and model picker, and every `role=` attribute written by hand. Keep the current look by styling `data-slot` and state attributes; popups grow from their trigger using `--transform-origin` with entry on `data-starting-style` and exit on `data-ending-style`. Remove `@radix-ui/*` and `sonner` from `package.json` when nothing imports them.

**Blocked by:** 01

**Status:** done

Spec story: 16 (and the base for 9 and 15).

- [x] No `@radix-ui` or `sonner` import left; packages removed
- [x] No hand-written `role="dialog|menu|listbox|tablist|switch|..."` next to UI SDK (the skill's rule)
- [x] Every control has an accessible name; the agent test from the skill's agent-ready reference passes for a dialog, a menu and the model picker
- [x] Keyboard: every popup opens, moves and closes by keyboard and returns focus to its trigger

## Comments

**Built.** Radix (dialog, dropdown menu, tooltip) and Sonner are gone from `web/package.json` and the lock; nothing imports them. In `web/src/ui/`: `Dialog.tsx` (Dialog, and Alert Dialog for `ConfirmDialog`/`TypeToConfirmDialog` with `AlertDialogClose value="confirm"`, pending while `onConfirm` runs, the failure shown inline), `Menu.tsx` (Menu with `MenuIconTrigger`, radio/checkbox items, groups, submenus), `Tooltip.tsx` (`Tip`; `IconButton` is named by it), `Switch`, `Checkbox`, `Segmented`, `Select`, `Radio` (`RadioCards`), `Autocomplete` (replaces the Pool member `<datalist>`), `Disclosure` (Collapsible, replaces both `<details>`), `popup.ts`, and `toast.tsx` on UI SDK Toast with one `OverlayHost` (`<Toaster />` in `App`; `notify`/`notifyChange` unchanged, ticket 04 still owns moving toasts inline). Pages moved onto them: every row menu, the Owner menu, Audit Entries filters, the Requests Filter / Columns / Time menus (`requests/menus.tsx` deleted), the chat panel (model Picker on Popover + Command + Listbox with a controller whose payload is the view, the earlier-chats menu, Tools/Stop/Send tooltips, system prompt), the Gateway Key access editor and model picker (`RadioCards` + `Checkbox`; the private checkbox/radio/switch in `gateway-keys/bits.tsx` are gone), the key page's capture switch and Test button tooltip, and every native `<select>` (9 call sites). No hand-written `role="dialog|menu|listbox|option|switch|checkbox|radio|radiogroup"` is left; the tab roles in `Captured.tsx` went with ticket 05. After merging 05, menus, selects, the Picker, the access list, `ui/Dialog` bodies and the two Keys lists scroll in `ui/ScrollArea`.

**Test-first.** Ran the `tdd` skill. The seams could not be confirmed with the Owner (non-interactive run); I used the public component props plus the agent bridge. Switch/Checkbox/Segmented/Select/RadioCards, the Gateway Key access editor and model picker, and the chat Picker were written red first. `ui/Dialog.tsx` and `ui/Menu.tsx` were drafted just before their tests, and `Autocomplete` just before its test. Tests: `ui/Dialog.test.tsx`, `ui/Menu.test.tsx`, `ui/controls.test.tsx`, `ui/toast.test.tsx`, `ui/popup.test.tsx`, `pages/chat/Picker.test.tsx`, `pages/gateway-keys/ScopeEditor.test.tsx`. Each one checks names, keyboard, focus return to the trigger, and has an agent test (dialog with the confirm gate, per-row menus, model picker, every control). `LogoField.test.tsx` (from 12) now mounts `<Toaster />` and skips UI SDK's page announcer when it looks for its own status line.

**Browser check.** Headless Chrome against the seeded testkit, in light, dark and at 390 px. Screenshots are in `iroha-v2-notes/v2-ui/shots/03/`: menus, submenus, confirm and type-to-confirm dialogs, toasts, nested Gateway Key dialogs, Select, the chat Picker views, the Owner and Audit menus. `pages/` holds the `check-pages.mjs` run: no cursor, width or sideways issues. `probe/` shows the keyboard flows in real Chrome:
- A row menu returns focus to its trigger on Escape.
- An alert dialog opens on Cancel and returns focus on Escape.
- The Picker focuses its search, ArrowDown+Enter picks, a list's Escape goes back, a second Escape closes onto the trigger.

The first run found popups that render in place inheriting `text-align: right` from table cells. `styles/index.css` now resets text styles on `[popover], dialog`.

**Deferred / notes.**
- Native `title` stays on non-focusable text: truncated cells, key state words, the health dot, Audit and Admin Token spans. A UI SDK Tooltip needs a focusable trigger.
- The Gateway Key model picker's virtualised list still scrolls natively: it reads `scrollTop`, and `ui/ScrollArea` exposes no scroll ref.
- A `ScrollArea` without `label` shows up to agents as an unnamed `scroll-area` component. The access list is labelled; the Picker test leaves scroll areas out of its "every entry named" check.
- Motion beyond the base grow/fade is ticket 14.
- The Dialog and States chunks grew with UI SDK (about 146 KB and 173 KB before gzip).
