Status: ready-for-agent

# Bulk Key Import

## Problem Statement

Today, the Owner adds Upstream Keys to a Provider one at a time. On the Add provider dialog (`providers-area.tsx:495-510`) the Owner can click "Add another key" to repeat the same single-row form, and on the Provider detail page (`provider-detail.tsx:566-577`) the Owner clicks "Add key" and lands in a single-row `AddKeyDialog` (`provider-detail.tsx:662-820`). When the Owner has many keys (a password-manager dump, a vendor rotating 30 endpoints, several team members each holding a credential) the row-by-row flow is the bottleneck.

The Owner can already express a per-key base URL override in the single-row form, so the data model is ready; only the input UX is missing.

## Solution

Add a `single | bulk` mode toggle to both the Add provider dialog and the Add keys dialog. Bulk mode swaps the per-row form for a shared `BulkKeyInput` component with two tabs:

- **Paste** — a textarea accepting CSV (`upstreamKey,baseUrl` per line) or pipe-separated (`upstreamKey|baseUrl` per line); the parser auto-detects per line by whether it contains `|`.
- **Upload** — a file input that accepts `.csv` (CSV format, with optional header row) or `.json` (JSON array of `{upstreamKey, baseUrl?}`); the file extension picks the parser.

Both tabs normalize to the same canonical shape `{upstreamKey: string, baseUrl?: string}[]` and feed the same downstream action. The Add provider dialog feeds the entries into the existing `createProvider({ keys: [...] })` body; the Add keys dialog calls a new server endpoint `POST /providers/:id/keys/bulk`. Bulk-imported keys carry no per-key `accountId`, `allowedModels`, or `deniedModels` — they inherit Provider defaults, and the Owner configures per-key settings via the existing Configure dialog after import.

The new endpoint returns per-entry results:

- `200 OK` with `{ added: [{ index, keyId }], failed: [{ index, problems? }] }` on partial success.
- `400 validation_failed` on whole-batch errors (empty list, more than 200 entries, body not an array of objects).
- Standard error responses for `provider_not_found`, `provider_archived`, `authentication_required`.

The Owner-facing feedback on partial success is an inline alert in the bulk dialog: `Added 8 of 12 keys; lines 3, 7 failed: invalid base URL`. The dialog stays open so the Owner can fix and resubmit; closing the dialog re-fetches the Provider.

## User Stories

For the Owner:

1. As the Owner, I want a `Bulk` mode toggle in the Add provider dialog, so I can paste a list of keys at creation time instead of clicking "Add another key" N times.
2. As the Owner, I want the bulk paste to accept `key,baseUrl` pairs (CSV), so I can paste a column from a spreadsheet with no editing.
3. As the Owner, I want the bulk paste to accept `key|baseUrl` pairs (pipe-separated), so I can paste the same data in a format familiar from OmniRoute-style bulk imports.
4. As the Owner, I want the parser to skip blank lines and `#` comments, so I can annotate my paste with section headings.
5. As the Owner, I want the parser to detect and skip an optional header line (`key,baseUrl` or `upstreamKey,baseUrl`), so I can paste straight from a spreadsheet that includes the column names.
6. As the Owner, I want a file-upload button for CSV or JSON, so I can import from a file the team keeps in version control or shared docs.
7. As the Owner, I want bulk-imported keys to inherit the Provider's base URL when their line omits one, so I do not have to repeat the URL on every line for the common case.
8. As the Owner, I want bulk-imported keys to carry no per-key `allowedModels`, `deniedModels`, or `accountId`, so I configure those selectively via the existing Configure dialog after import rather than carrying settings through the bulk paste.
9. As the Owner, I want a clear count above the textarea showing how many lines were parsed and how many failed, so I can sanity-check the paste before submitting.
10. As the Owner, I want partial success — keys that pass validation are added even when others fail, so I do not lose valid keys to a single bad line.
11. As the Owner, I want to see which lines failed and why when the partial success happens, so I can fix the bad lines and resubmit.
12. As the Owner, I want the same bulk UX in the Add keys dialog on the Provider detail page, so I can grow an existing Provider the same way I created it.
13. As the Owner, I want the bulk endpoint to refuse batches above 200 entries, so a runaway paste does not consume the probe budget or saturate the audit log.
14. As the Owner, I want each successful bulk-imported key audited as `key.created`, so the audit trail records who added what and when.
15. As the Owner, I want the bulk endpoint to probe all newly-added keys in a single pass, so a 200-key paste does not produce 200 sequential probes per key.

For self-hosters and operators:

16. As a self-hoster, I want the new `POST /providers/:id/keys/bulk` route to require the same CSRF protection as the existing `POST /providers/:id/keys`, so the security posture is unchanged.

## Glossary

No new domain terms. `Upstream Key`, `Provider`, and `baseUrl` keep their existing `CONTEXT.md` definitions; `BulkKeyImport` is a UI feature name, not a domain concept.

## What this spec is not

- No new top-level modules or new top-level directories. The parser lives at `ui/src/lib/parse-bulk-keys.ts`; the shared component at `ui/src/components/bulk-key-input.tsx`; the registry method on `ProviderRegistry`; the route on the existing admin app.
- No browser / JS-DOM tests. Per `docs/agents/ui-testing.md`, the HTTP seam carries the behaviour.
- No new migration; the schema is unchanged.
- No per-key `allowedModels` / `deniedModels` / `accountId` in bulk-imported keys. The Owner sets those per-key via the existing Configure dialog after import.
- No heterogeneous cross-provider import (OmniRoute's `/api/providers/import`). Each bulk request targets exactly one Provider.
- No toast/sonner for partial-success feedback. Inline alert inside the dialog, matching the existing `Alert` patterns in `providers-area.tsx` and `provider-detail.tsx`.
- No CLI. The Owner imports through the management UI; the API endpoint is for programmatic use and follows the same JSON shape.

## Tickets

- `01-server-bulk-add-keys-registry.md` — `bulkAddKeys` on `ProviderRegistry`: per-entry validation, per-entry transaction, single probe pass.
- `02-http-bulk-add-keys-route.md` — `POST /providers/:id/keys/bulk`: body validation, whole-batch errors, partial-success response.
- `03-client-paste-parser.md` — `parseBulkKeyInput(text)` and `parseBulkKeyJson(text)` in `ui/src/lib/parse-bulk-keys.ts`.
- `04-client-bulk-add-keys-api-call.md` — `bulkAddKeys(providerId, entries, csrfToken)` in `ui/src/lib/providers.ts`.
- `05-shared-bulk-key-input-component.md` — `BulkKeyInput` in `ui/src/components/bulk-key-input.tsx` (Paste / Upload tabs, line counter, partial-success alert).
- `06-add-provider-bulk-mode.md` — wire the toggle into `CreateProviderForm` in `providers-area.tsx`; bulk mode feeds the parsed entries into `createProvider({ keys: [...] })`.
- `07-add-keys-bulk-mode.md` — wire the toggle into `AddKeyDialog` in `provider-detail.tsx`; bulk mode calls `bulkAddKeys`.
- `08-http-tests.md` — HTTP tests for the new route: empty list, oversized list, valid batch, partial batch, archived provider, CSRF required.

The blocking edges form a chain: 01 → 02 → 04 → 05 → 06, 01 → 02 → 04 → 05 → 07, 03 → 05, 05 → 06, 05 → 07, 02 → 08, 06 + 07 → 08. 08 is the gate.

## Out of Scope

- Per-key `accountId`, `allowedModels`, `deniedModels` in bulk-imported keys.
- Cross-provider heterogeneous imports (the file contains keys for multiple Providers).
- Atomic whole-batch semantics.
- A CLI importer.
- A new top-level module or migration.
- Per-line display names (Iroha keys do not carry display names; only the stable `uk_…` id).
- Automatic duplicate detection across the batch (if the same key value appears twice, both entries are added — the Owner's call to deduplicate).
- Streaming/progress UI during the probe (the probe happens after the bulk insert returns to the Owner; the Owner sees the keys as `unverified` and they settle into their final health on the next refresh).
