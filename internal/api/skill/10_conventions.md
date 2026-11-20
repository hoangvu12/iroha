## Conventions of every admin resource

Every resource under `/api/` (Admin Tokens now; Providers, Upstream Keys, Model Pools, Gateway Keys, Failure Rules and settings as they arrive) follows the same rules, so learn them once.

### Addressing

A path parameter naming a record (`{token}`, `{provider}`, `{pool}`...) takes its name (a Provider's handle) or its ID. You never need to look an ID up first. An unknown name or ID answers 404 `not_found`, and the hint names the route that lists the records.

Names are 1 to 64 letters, digits, `.`, `_` or `-`, starting with a letter or digit. `bulk` is reserved.

### Dry run

Every mutating route (POST, PUT, PATCH, DELETE) accepts `?dry_run=true`. Iroha runs the whole change, validation and guards included, then rolls it back and writes nothing. The response is the one a real call would give, with `"dry_run": true`, so `changes` tells you exactly what would change. Values Iroha generates on create (IDs, secrets) are placeholders on a dry run.

### Responses of a change

A mutation answers with the record plus:

- `outcome`: `created` (status 201), `updated`, `deleted` or `unchanged` (200).
- `changes`: every record changed, each with `resource`, `id`, `name`, `op` (`create`, `update`, `delete`), the `fields` an update changed, and the record's `before` and `after` (null when it did not exist). Secrets are masked to their last four characters here; read the record itself for the whole secret.
- `audit_entry`: the ID of the Audit Entry written, absent on a dry run or when nothing changed.

### Create-or-update by name

`POST /api/<resource>` with the name of an existing record updates that record instead of making a duplicate. Fields you leave out keep their current values. Repeating the same call is safe: the second answers `"outcome": "unchanged"` and writes no Audit Entry. So re-run your work freely.

### Bulk

`POST /api/<resource>/bulk` creates or updates many records, and `POST /api/<resource>/bulk/<action>` (such as `/bulk/revoke`) applies one action to many, each item by name or ID. The body is `{"items": [...]}` (at most 1000). Each item succeeds or fails on its own: a failed item is rolled back and reported, the rest still apply. The answer is 200 even when items fail, so always read it:

```json
{"dry_run": false, "audit_entry": "ae_...", "succeeded": 39, "failed": 1,
 "items": [{"index": 0, "ok": true, "outcome": "updated", "result": {...}, "changes": [...]},
           {"index": 7, "ok": false, "error": {"code": "not_found", "message": "...", "hint": "..."}, "changes": []}]}
```

One Audit Entry covers every applied item of a bulk call, so one revert undoes all of it.

`POST /api/<resource>/bulk/update` (Upstream Keys, Gateway Keys) edits many existing records in one change: each item is `{"key": "<name or ID>", ...}` with only the fields to change; a field an item leaves out stays as that record has it. Use it to set one value on many records, or to send each its own value; it never creates a record. An Upstream Key's Endpoints can be changed rather than replaced: `endpoints_add` and `endpoints_remove` apply to each key's list as it is when the call runs, so a key changed since you read it keeps that change (`endpoints` replaces the whole list). Names and secrets, and a Gateway Key's scope, are changed one record at a time.

### Audit Entries and revert

Every change to Iroha's configuration writes an Audit Entry naming who made it (`actor`: your Admin Token's name, or `Owner` for the Owner's browser session), with each record's before and after. Read them with `GET /api/audit-entries` (filter by `actor`, `resource`, `record`, `action`, `q`, `since`).

`POST /api/audit-entries/{entry}/revert` restores the before-state of every record the entry changed. The revert is itself an Audit Entry (`revert_of` names the original, which gets `reverted_by`), so reverting the revert redoes the change. A revert is refused with:

- `audit_conflict` (409) when a record changed after the entry: `details.conflicts` lists each record and the `later_entries` that changed it. Revert those first, newest first, or make the change you want directly.
- `audit_irreversible` when the change cannot be undone (`revertible` is false and `not_revertible` says why), such as revoking a secret.
- `audit_already_reverted` when it was reverted already; revert the reverting entry instead.

Accepts `?dry_run=true` like every change.

### Errors

Every error has the form `{"error": {"code", "message", "hint", "details"}}`. The `hint` names the next action; follow it. Common codes: `invalid_request` (400: fix the body or query), `not_found` (404), `name_taken` (409: pick another name), `audit_conflict`, `audit_irreversible`, `audit_already_reverted`, `builtin_rule` (409), `admin_token_missing`, `admin_token_invalid`, `admin_token_revoked` (401), `internal` (500: retry once, then read `GET /api/logs?level=error&since=5m`).
