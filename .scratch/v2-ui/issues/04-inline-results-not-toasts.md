# 04: Show results in place, toasts only when the place is gone

**What to build:** Audit every `toast` call and every copy button in `web/src`. A copy button swaps its icon and label to "Copied" in place for about 1.5 s (with an `aria-live` announcement), then back; make one shared `CopyButton` and use it everywhere (key secrets, snippets, base URLs, IDs, request bodies). Inline saves (settings fields, switches, renames) show pending and saved state on the control or field itself, and an error under the field. Keep a toast only when the place that caused the result is gone: a dialog that closed after Save, a navigation away, a background job finishing, an undo offer after a delete, or an error with nowhere else to go. Read the `emil-design-eng` skill on feedback placement and press states before starting.

**Blocked by:** 03

**Status:** done

Spec story: 9.

- [x] One `CopyButton`, used by every copy action; no "Copied" toast left
- [x] Each remaining toast has a one-line reason in the code review notes (where it fires and why there's no place to show it)
- [x] Saved and error states show on the control that changed

## Comments

**Built** (details in `docs/agents/architecture.md`, "UI ticket 04"):

- **Copy.** `ui/clipboard.ts` `writeClipboard` replaces the two old helpers (`settings/format.ts` `copyText` and `requests/api.ts` `useCopy`). It uses the Clipboard API, with a textarea + `execCommand` fallback that gives focus back.
  - `ui/CopyButton.tsx` is every copy button: key secrets, base URLs, the snippet dialog, Request IDs (drawer, Route view), Copy as cURL, the Admin Token and Gateway Key create dialogs, and the secret cells.
  - The button shows "Copied" in place for 1.5 s and keeps its width. The result goes to UI SDK's live region, and a refused copy says so.
  - `notify.copied` is gone.
  - Copies from row menus (Gateway Keys, Admin Tokens, Upstream Keys, Endpoints, the keys bulk menu) show a check on the ⋯ trigger the menu closes back to. The trigger keeps its name.
- **Inline saves.** `ui/SaveStatus.tsx` (`useSave`, `SaveStatus`, `SaveError`) shows Saving…, then the result with Undo (and Redo) on the control. Errors go under the field with `aria-invalid`, and the typed value is kept. Used by:
  - Gateway Key page: rename on blur, capture.
  - Provider Settings: name, logo, Enabled.
  - Pool Settings: maker, budget.
  - Rules: each switch.
  - Pool Members: switches and the member list.
  - Models: Clear in the Gaps cell, and Refresh list beside its button.
  - Keys selection bar: every bulk action, and Test with a Details action when a key failed.
  - Key dialog: rename, replace key, and toggle / test / restrict / clear-gap on their own line under the footer.
  - Audit Entries: Revert shows "Reverted" with Undo in place.
  - Sign-in: signing this browser out.
  - Chat panel: setup errors as a banner.
- **Switches.** `Switch pending` is optimistic: the new state shows at once and goes back if the save fails.
- **Toasts kept.** Each has a `// Toast: <why>` comment where it fires. They are:
  - Row-menu actions, since the menu closed.
  - Dialogs that close on success: Add keys, Endpoints, Access, Add Provider, New Pool, rule editor.
  - Deletes and revokes, where the row is gone and the toast offers Undo.
  - Pool rename (the page navigates) and Provider Restore (its row is replaced).
  - A Models row that leaves the "gaps" filter.
  - The background key test after Add keys.
  - Shell sign-out failure.
- **Fixes from ticket-adjustments.**
  - `providers/List.tsx` no longer sets an error on the dialog it closes. A lost Endpoint now goes in the toast: "Provider X added without its Endpoint: why".
  - The Gateway Key and Admin Token create dialogs have Undo in their footer. It reverts, closes the dialog and toasts the delete.

**Test-first.** I used the tdd skill, but the session was non-interactive, so I chose the seams myself: CopyButton, `useSave`/`SaveStatus`, MenuIconTrigger copy, and the Gateway Key page.
- `ui/Menu.test.tsx` (menu copy) went red first.
- `ui/CopyButton.test.tsx` (5) and `ui/SaveStatus.test.tsx` (5) were written in the same slice as their code.
- `pages/gateway-keys/KeyPage.test.tsx` (4: inline rename with Undo, refused rename, capture switch, agent test) was written after the migration.
- Web suite: 75/75. `npm --prefix web run build` passes.

**Browser check.** Headless Chrome against the seeded server, in light, dark and 390 px phone. Screenshots and the plan are in `iroha-v2-notes/v2-ui/shots/04/`. They cover:
- the /states demo
- Gateway Key page rename, copy and capture
- row-menu copy (Gateway Keys, Keys, Admin Tokens)
- the create dialog with Copied and Undo
- Provider and Pool settings saves
- Keys bar and key dialog results
- Pool members, Rules, Models Refresh list
- Audit Entry revert

The check found three layout problems, all fixed:
- A long result beside a Name field squeezed the field (Provider settings, and the Gateway Key page on phones). The result now wraps under the field.
- The key dialog's result squeezed its footer buttons. It now has its own line.

**Left as is.**
- A few plain `<button>` links (Models "Clear", key dialog links, "Clear selection") are not UI SDK parts, so agents can't see them. That is outside result feedback.
- `/states` scrolls sideways on phones because of its table panel. It did before this ticket (see `shots/03/states-toasts-phone.png`), and it is a dev-only page.

**After merging v2-ui** (tickets 10, 21, 22, motion):
- The sheets' `CopyIconButton` is now a `CopyButton`.
- The Key and Provider sheets show the Disable/Enable result beside the buttons.
- Ticket 21's confirmed revert shows "Reverted" with Undo in its row.
- Ticket 21's "Remove model" toast got its reason comment.
- Web suite: 106/106.
