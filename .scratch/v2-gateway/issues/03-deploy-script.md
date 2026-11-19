# 03: Deploy script with backup and rollback

**What to build:** One script an agent runs to deploy Iroha to the server over SSH keys: build for Linux, copy the binary, back up the SQLite file, swap the binary, restart the systemd service, check readiness, and roll back to the previous binary and database backup automatically when the check fails. Ships with the systemd unit and a short runbook in the served skill.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Script deploys the skeleton to the server and reports the deployed version
- [ ] A failing readiness check restores the previous binary and reports the failure
- [ ] Database backed up before every swap; old backups pruned to a fixed count
- [ ] The script never reads or writes passwords; it requires SSH key auth
- [ ] The service drains in-flight requests on restart
