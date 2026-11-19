# 02: Admin API conventions: names, dry run, bulk, audit and revert

**What to build:** The shared machinery every admin route uses, proven on Admin Tokens as the first resource: an agent can create, read, list and revoke named Admin Tokens addressing them by name or ID; every mutation accepts `dry_run` and reports exactly what would change; a bulk variant returns per-item results; creates are create-or-update by name; errors carry a code, message and next-step hint; every mutation writes an Audit Entry naming the actor (Admin Token or Owner session) with before and after; any Audit Entry can be reverted. The served skill and OpenAPI document describe these conventions once, for all later resources.

**Blocked by:** 01

**Status:** done

- [x] Admin Tokens: create, read (secret readable), list, revoke, by name
- [x] Dry run returns the would-be change and writes nothing
- [x] Bulk call with one failing item reports per-item results and applies the rest
- [x] Repeating a create with the same name updates instead of duplicating
- [x] Audit Entries listed and filtered via the API; revert restores the before-state and is itself audited
- [x] Error responses always include a hint

## Comments

Built `internal/audit`: `audit.Register(&audit.Resource[T]{...})` (snapshot type, Load, Restore, name-or-ID `Resolve`), `Trail.Mutate` (one transaction; `?dry_run=true` runs and rolls back; `changes` with before/after/fields, `outcome`, 201 on create; one Audit Entry when anything changed; `config.change` log event), `audit.Bulk` (savepoint per item, one Audit Entry per call, 200 with `succeeded`/`failed`), `GET /api/audit-entries` (filters actor, resource, record, action, q, since, until, paging), `GET /api/audit-entries/{entry}`, `POST /api/audit-entries/{entry}/revert` (refuses `audit_conflict` with the later entries listed, `audit_irreversible`, `audit_already_reverted`; the revert is audited and can itself be reverted to redo). Secrets are masked to their last four characters in Audit Entry views and stored whole so revert can restore them. `api.CheckName`, `api.Conflict`, `Error.WithDetails` added. The conventions are written once in `internal/api/skill/10_conventions.md` and the OpenAPI `info.description`; `docs/agents/architecture.md` has "Add an admin resource" for later tickets. A test fails if any non-GET admin route lacks `dry_run`.

Admin Tokens: `GET/POST /api/admin-tokens`, `GET/PATCH /api/admin-tokens/{token}`, `POST /api/admin-tokens/{token}/revoke`, `POST /api/admin-tokens/bulk`, `POST /api/admin-tokens/bulk/revoke`. Decisions worth knowing:
- Added an optional `note` to Admin Tokens (migration `02_02`) so create-or-update and revert of an update have a real field to act on; PATCH also renames.
- Revoke is irreversible (its Audit Entry says why), matching the design's "Can't be reverted". Creating with a revoked token's name is refused (409) rather than resurrecting it.
- The last active Admin Token cannot be revoked (`last_admin_token`), since until ticket 21 there is no other way in. Ticket 21 may relax this once an Owner password exists.
- Reverting a create deletes the record; reverting that revert re-inserts it with the same ID and secret.
- Owner-session actors are stored the same way (`actor.kind = owner_session`, name `Owner`) but cannot be exercised until ticket 21 adds sessions.
- `testkit.Server.NewAdminToken(name)` creates a second actor for tests.
