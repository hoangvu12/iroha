# 07 — Add keys dialog (provider detail): `single | bulk` mode toggle

**What to build:** Wire bulk mode into `AddKeyDialog` in `ui/src/components/provider-detail.tsx`. The existing single-row `AddKeyDialog` (lines 662-820) gains a `single | bulk` mode toggle that swaps the single-row form for a `<BulkKeyInput>` (ticket 05). On submit, bulk-mode entries call the new `bulkAddKeys` API (ticket 04) instead of `addKey`. The dialog shows partial-success feedback inline when the bulk call returns mixed `added` / `failed` results.

**Blocked by:** 04 (the API call must exist) and 05 (the shared component).

**Status:** done

- [x] `AddKeyDialog` (`ui/src/components/provider-detail.tsx:662-820`) has a `keyInputMode: 'single' | 'bulk'` state, defaulting to `'single'`.
- [x] A small toggle (segmented control) sits at the top of the dialog body, above the existing single-row form / below the `DialogHeader`. Labels: `Single entry` / `Bulk paste`. Same component used as in ticket 06 for visual consistency.
- [x] In `single` mode, the existing single-row form (upstream-key input, base URL override input, allowed/denied model pickers, submit) renders unchanged.
- [x] In `bulk` mode, the single-row form is replaced with `<BulkKeyInput onParsed={setBulkKeys} defaultBaseUrl={defaultBaseUrl} />`. The allowed/denied model pickers are **not** rendered in bulk mode (per-key `allowedModels` / `deniedModels` are explicitly out of scope; Owner configures them per-key via the existing Configure dialog after import).
- [x] Bulk-mode submit calls `bulkAddKeys(providerId, bulkKeys, csrfToken)` (ticket 04). On success, it reloads the Provider view via the existing `onChanged` callback and shows the partial-success alert (next bullet).
- [x] Partial-success alert: when `bulkAddKeys` resolves with `{added: [...], failed: [...]}`, the dialog stays open and renders a destructive `Alert` (using the existing `Alert` / `AlertTitle` / `AlertDescription` shape) above the input: `Added X of Y keys. Lines N, M failed: <problem.message>`. The alert lists each failed index with its first problem message (truncated to the first 5 failures with a trailing `…and N more` line if more than 5). The Owner can fix the offending lines and resubmit, or close the dialog.
- [x] Whole-batch error (server returns 400 `validation_failed`, e.g. >200 entries): the existing `ManagementError` plumbing at `provider-detail.tsx:710-717` surfaces the message in the dialog's existing error slot — no new error path is needed.
- [x] When all entries succeed (`failed.length === 0`), the dialog closes immediately and the existing `onChanged` reload fires (no partial-success alert needed).
- [x] `single` mode submit continues to call the existing `addKey` provider function (`provider-detail.tsx:592`), unchanged.
- [x] The `onAdd` callback prop's type at `provider-detail.tsx:673-679` is unchanged — bulk-mode submission does not flow through `onAdd`; it goes directly to `bulkAddKeys` inside the dialog. This keeps the `UpstreamKeysCard` parent unaware of bulk vs single.
