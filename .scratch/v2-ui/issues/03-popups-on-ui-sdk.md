# 03: Popups and controls on UI SDK; drop Radix and Sonner

**What to build:** Move every dialog, confirmation, menu, tooltip, popover, select, combobox, switch, checkbox, segmented control and toast in `web/src` to the UI SDK component the skill's build-interface table names for it (Dialog, Alert Dialog with `AlertDialogClose value="confirm"`, Menu, Tooltip, Popover, Select, Combobox, Switch, Checkbox, Segmented Control, Toast with `OverlayHost` mounted once). That includes `web/src/ui/Dialog.tsx`, the row menus, the chat panel's model Picker and settings, the Gateway Key scope editor and model picker, and every `role=` attribute written by hand. Keep the current look by styling `data-slot` and state attributes; popups grow from their trigger using `--transform-origin` with entry on `data-starting-style` and exit on `data-ending-style`. Remove `@radix-ui/*` and `sonner` from `package.json` when nothing imports them.

**Blocked by:** 01

**Status:** open

Spec story: 16 (and the base for 9 and 15).

- [ ] No `@radix-ui` or `sonner` import left; packages removed
- [ ] No hand-written `role="dialog|menu|listbox|tablist|switch|..."` next to UI SDK (the skill's rule)
- [ ] Every control has an accessible name; the agent test from the skill's agent-ready reference passes for a dialog, a menu and the model picker
- [ ] Keyboard: every popup opens, moves and closes by keyboard and returns focus to its trigger
