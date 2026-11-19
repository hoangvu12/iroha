# 21: Owner login and embedded UI shell

**What to build:** The binary serves an embedded React single-page app. The Owner sets a password on first visit, logs in, and stays signed in for 30 days; the session acts as the Owner in Audit Entries. The shell has navigation for Providers, Gateway Keys and Requests, follows the design produced in the design session, and uses only the public admin API.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Password setup, login, logout; sessions last 30 days and can be revoked through the API
- [ ] The UI build is embedded in the binary; no separate server needed
- [ ] The shell matches the design handoff (see the design notes in this folder once delivered)
