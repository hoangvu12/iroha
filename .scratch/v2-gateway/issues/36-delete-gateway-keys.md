# 36: Delete revoked Gateway Keys

**What to build:** Ticket 24's danger zone asks for revoke and delete, but the API has no `DELETE /api/gateway-keys/{key}`; revoked keys stay listed forever (catalog KEY-14: v1 deleted them, history kept). Add the route: refused with 409 `gateway_key_active` unless the key is revoked, audited (decide irreversible or revertible), and history keeps `caller_name` and `gateway_key_id` (already no foreign key). If the Owner prefers revoke-only, drop delete from ticket 24 instead.

**Blocked by:** none (coordinate with 24)

**Status:** needs-decision (delete, or drop it from 24)

- [ ] `gatewaykeys` test: delete of an active key refused; of a revoked key succeeds; old Requests still show the Caller's name and `caller=<id>` finds them
