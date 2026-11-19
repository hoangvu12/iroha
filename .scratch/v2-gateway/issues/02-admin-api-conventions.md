# 02: Admin API conventions: names, dry run, bulk, audit and revert

**What to build:** The shared machinery every admin route uses, proven on Admin Tokens as the first resource: an agent can create, read, list and revoke named Admin Tokens addressing them by name or ID; every mutation accepts `dry_run` and reports exactly what would change; a bulk variant returns per-item results; creates are create-or-update by name; errors carry a code, message and next-step hint; every mutation writes an Audit Entry naming the actor (Admin Token or Owner session) with before and after; any Audit Entry can be reverted. The served skill and OpenAPI document describe these conventions once, for all later resources.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Admin Tokens: create, read (secret readable), list, revoke, by name
- [ ] Dry run returns the would-be change and writes nothing
- [ ] Bulk call with one failing item reports per-item results and applies the rest
- [ ] Repeating a create with the same name updates instead of duplicating
- [ ] Audit Entries listed and filtered via the API; revert restores the before-state and is itself audited
- [ ] Error responses always include a hint
