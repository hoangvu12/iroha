# 21: Owner login and embedded UI shell

**What to build:** The binary serves an embedded React single-page app built to `.scratch/v2-gateway/design/v2-clean/`. The Owner sets a password on first visit, logs in (screen C13), and stays signed in for 30 days; the session acts as the Owner in Audit Entries. The shell is the sidebar from the design: Iroha banner art and avatar, a health status from the readiness endpoint, Providers / Gateway Keys / Requests / Chat with keyboard shortcuts (P, G, R, C), and the Owner row with sign out. The shell hosts the right-side chat panel slot used by ticket 23. Light and dark themes.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Password setup, login, logout; sessions last 30 days and can be revoked through the API
- [ ] The UI build is embedded in the binary; brand art is served by Iroha
- [ ] Shortcuts work from every page and are shown in the sidebar
- [ ] Health status reflects readiness
- [ ] Only the public admin API is used
