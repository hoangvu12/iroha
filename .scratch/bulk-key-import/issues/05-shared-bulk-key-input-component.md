# 05 — Shared `BulkKeyInput` component

**What to build:** A reusable `BulkKeyInput` component at `ui/src/components/bulk-key-input.tsx` that renders the Paste / Upload tabs, parses input client-side via the utilities from ticket 03, exposes a live count line ("12 lines parsed · 1 header skipped · 0 invalid"), and emits the parsed entries to its parent via a callback. The component is used by both the Add provider dialog (ticket 06) and the Add keys dialog (ticket 07) — no per-place duplication.

**Blocked by:** 03 (the parser utilities). The `bulkAddKeys` API call from 04 is **not** required for this ticket — the component is presentational and emits parsed entries; the caller decides whether to submit via `createProvider` or `bulkAddKeys`.

**Status:** done

- [x] New file `ui/src/components/bulk-key-input.tsx` exports `BulkKeyInput`.
- [x] Props: `{ onParsed: (result: ParseBulkResult & { ok: true }) => void; defaultBaseUrl: string; maxEntries?: number }`. `maxEntries` defaults to `200`.
- [x] Renders a tab strip with two tabs: **Paste** and **Upload**. Active tab state is local to the component.
- [x] **Paste tab** renders a `<textarea>` (monospace, full width, ~12 visible rows) with placeholder text:
  ```
  # Lines starting with # are skipped.
  # One Upstream Key per line. Optional base URL override after a comma or pipe.
  sk-abc
  sk-def,https://my-proxy.example.com/v1
  sk-ghi|https://other-endpoint.example.com/v2
  ```
- [x] **Upload tab** renders a file input accepting `.csv` and `.json`. On file selection, the file's text is read via `FileReader.readAsText`, then dispatched to `parseBulkKeyInput` (for `.csv`) or `parseBulkKeyJson` (for `.json`).
- [x] Below the input, a live count line shows: `N entries parsed · H header skipped · C comments skipped`. Updates on every textarea change / file selection (debounced to 100ms so it does not thrash on paste).
- [x] When `parseBulkKeyJson` returns `{ ok: false, reason: 'malformed_json' }`, the component surfaces a destructive `Alert` above the input: `That file isn't a valid JSON array. <message>`.
- [x] When the parsed entry count exceeds `maxEntries`, the component disables the parent's submit button and shows a warning `Alert`: `<count> entries parsed · limit is <maxEntries> · trim the file and try again`.
- [x] When the textarea is empty or no file is selected, the parent's submit button is disabled and the count line reads `No entries yet`.
- [x] The component is accessible: the tab strip uses `role="tablist"` with arrow-key navigation, the textarea has an `aria-label`, the file input has an `aria-label`, the count line has `aria-live="polite"`.
- [x] The component does not submit anything itself. Submission is owned by the parent dialog so the same component works for both `createProvider` (no CSRF per-key, just one for the whole create) and `bulkAddKeys` (one CSRF for the whole batch).
- [x] No business logic (no calls to `addKey`, `createProvider`, or `bulkAddKeys`). The component is a pure renderer that emits parsed entries.
