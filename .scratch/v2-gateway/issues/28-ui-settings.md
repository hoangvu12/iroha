# 28: Settings: Admin Tokens and Audit Entries

**What to build:** Following `design/v2-clean/` (C28, C29): a plain Settings page, reached from the Owner row (behind the avatar on phones), with two tabs. Admin Tokens lists each token's name, readable secret with copy, created and last used (highlighted when unused for a month), with create and revoke. Audit Entries lists every change with actor, time and what changed; opening a row shows before and after; each row has Revert.

**Blocked by:** 21, 02

**Status:** ready-for-agent

- [ ] Revoking a token asks for its name to be typed
- [ ] Revert from the UI uses the same API as agents and is itself recorded
- [ ] Audit Entries filterable by actor and resource
