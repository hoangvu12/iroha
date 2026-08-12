# 14 — Bounded background operations

**What to build:** Model, usage, recovery, retention, and session maintenance run predictably without overlapping work and expose failures to the Owner.

**Blocked by:** 06 — Model catalog and scoped Models API; 10 — Scoped retries and durable Key Health; 11 — Usage Adapter and entitlement visibility; 13 — Private request history and Owner audit.

**Status:** ready-for-agent

- [ ] Background jobs cover periodic model synchronization, Usage Adapter polling, cooldown recovery, request-retention cleanup, and expired-session cleanup.
- [ ] Each job prevents overlapping executions in the single-instance runtime.
- [ ] Each job records last start, completion, success/failure, and useful sanitized error detail.
- [ ] Model and usage schedules are globally configurable with appropriate connection overrides.
- [ ] Cleanup operates in bounded batches and does not monopolize the database.
- [ ] Recovery never creates automatic paid inference probes.
- [ ] The Owner can trigger appropriate jobs manually and see their current/last outcome.
- [ ] Deterministic clock tests cover schedule claims, overlap prevention, restart, backoff, and cleanup boundaries on both databases.

