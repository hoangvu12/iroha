# 06 — Add provider dialog: `single | bulk` mode toggle

**What to build:** Wire the bulk mode into `CreateProviderForm` in `ui/src/components/providers-area.tsx`. A `single | bulk` toggle at the top of the Upstream Keys section swaps the existing per-row form (rows + "Add another key" button) for a `<BulkKeyInput>` (ticket 05). On submit, the bulk-mode entries are fed into the existing `createProvider({ keys: [...] })` body — no new server endpoint is needed for the create path because `createProvider` already accepts a `keys` array.

**Blocked by:** 05 (the shared component must exist).

**Status:** done

- [x] `CreateProviderForm` (`ui/src/components/providers-area.tsx:407-659`) has a `keyInputMode: 'single' | 'bulk'` state, defaulting to `'single'`.
- [x] A small toggle (segmented control) sits at the top of the **Upstream keys** section, above the existing hint paragraph. Labels: `Single entry` / `Bulk paste`. Uses the existing `Select` (or a new minimal `ToggleGroup` from shadcn) — no new dependencies introduced.
- [x] In `single` mode, the existing per-row form (`CreateProviderKeyRow`, `CreateProviderKeyRowFields`, `addKeyRow`, `removeKeyRow`, the `keys` state shape at `ui/src/components/providers-area.tsx:419-421`) renders unchanged.
- [x] In `bulk` mode, the per-row form is replaced with `<BulkKeyInput onParsed={setBulkKeys} defaultBaseUrl={baseUrl} />`. The `keys` state from `single` mode is hidden; a new `bulkKeys` state (`{ upstreamKey: string; baseUrl?: string }[]`) holds the parsed entries.
- [x] Switching modes preserves the user's work: switching from `single` → `bulk` does not destroy the per-row entries until the user types in the textarea; switching from `bulk` → `single` does not destroy the parsed entries until the user adds a row. (Simpler implementation: keep both states and toggle which is read on submit. Document this choice in a comment.)
- [x] The submit handler calls `createProvider({ ..., keys: keyInputMode === 'bulk' ? bulkKeys.map((b) => ({ upstreamKey: b.upstreamKey, baseUrl: b.baseUrl })) : keys.map((row) => ({ upstreamKey: row.upstreamKey, baseUrl: row.baseUrl })) }, csrfToken)`.
- [x] Submit is disabled when `keyInputMode === 'bulk'` and `bulkKeys.length === 0`, or when `keyInputMode === 'single'` and the single-row form is empty (existing behavior).
- [x] No new server code in this ticket. The existing `createProvider` body shape already accepts a `keys` array (`ui/src/lib/providers.ts:173-205`); bulk-mode entries serialize into that body unchanged.
- [x] The `keysHint` paragraph in `providers-area.tsx:529-536` is updated to mention the bulk toggle: `Add one Upstream Key now, paste several at once with Bulk, or come back to this Provider detail page later to add more.` (Existing copy is preserved as the second sentence.)
- [x] The toggle does not affect `allowInsecureHttp`, `displayName`, `baseUrl`, `templateId`, or any other field — only the Upstream Keys section is mode-aware.
