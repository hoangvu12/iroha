# 06: Failure Rules managed by agents

**What to build:** Agents list, add, override (by name) and delete Failure Rules through the admin API, scoped to a Provider or global, matching on status, error code, body text and headers, with an outcome and an optional cooling duration or reset-time extraction. A dry run replays recent failed Attempts and reports which would match and what would change. Changes take effect without restart.

**Blocked by:** 05

**Status:** ready-for-agent

- [ ] Owner rules override built-ins by name; built-ins are listed but cannot be deleted
- [ ] Dry run against recent failed Attempts reports matches per rule
- [ ] Rules apply to the next Attempt after a change
- [ ] Every rule change writes an Audit Entry
