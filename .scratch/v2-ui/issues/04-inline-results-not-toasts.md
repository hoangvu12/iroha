# 04: Show results in place, toasts only when the place is gone

**What to build:** Audit every `toast` call and every copy button in `web/src`. A copy button swaps its icon and label to "Copied" in place for about 1.5 s (with an `aria-live` announcement), then back; make one shared `CopyButton` and use it everywhere (key secrets, snippets, base URLs, IDs, request bodies). Inline saves (settings fields, switches, renames) show pending and saved state on the control or field itself, and an error under the field. Keep a toast only when the place that caused the result is gone: a dialog that closed after Save, a navigation away, a background job finishing, an undo offer after a delete, or an error with nowhere else to go. Read the `emil-design-eng` skill on feedback placement and press states before starting.

**Blocked by:** 03

**Status:** open

Spec story: 9.

- [ ] One `CopyButton`, used by every copy action; no "Copied" toast left
- [ ] Each remaining toast has a one-line reason in the code review notes (where it fires and why there's no place to show it)
- [ ] Saved and error states show on the control that changed
