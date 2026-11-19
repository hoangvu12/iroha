# 27: v1 import and cutover

**What to build:** A runbook in the served skill and an agent-run import that reads v1's configuration and recreates it in v2 through the admin API: Providers and their Endpoints (v1 per-key base URLs become Endpoints with the keys restricted to them), Upstream Keys the Owner holds, and Gateway Keys with the same names and scopes but new secrets. The cutover deploys v2, points the public hostname at it, keeps v1 runnable for rollback, and lists the new Gateway Keys for the Owner to hand out once.

**Blocked by:** 03, 18, 22, 23, 24, 25, 26

**Status:** ready-for-agent

- [ ] Import is a dry run by default and reports what it would create
- [ ] Re-running the import does not duplicate anything
- [ ] Upstream Accounts, history, audit and Management Keys are not imported
- [ ] Rollback to v1 documented and tested once
