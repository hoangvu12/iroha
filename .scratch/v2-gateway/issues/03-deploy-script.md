# 03: Deploy script with backup and rollback

**What to build:** One script an agent runs to deploy Iroha to the server over SSH keys: build for Linux, copy the binary, back up the SQLite file, swap the binary, restart the systemd service, check readiness, and roll back to the previous binary and database backup automatically when the check fails. Ships with the systemd unit and a short runbook in the served skill.

**Blocked by:** 01

**Status:** done

- [x] Script deploys the skeleton to the server and reports the deployed version
- [x] A failing readiness check restores the previous binary and reports the failure
- [x] Database backed up before every swap; old backups pruned to a fixed count
- [x] The script never reads or writes passwords; it requires SSH key auth
- [x] The service drains in-flight requests on restart

## Comments

Built `deploy/deploy.sh` (local: build for the server's arch, upload, run the server half), `deploy/remote.sh` (server: check, stop with drain, back up binary + `iroha.db` to `backups/<UTC time>/`, swap, start, wait for `/readyz` to report the new version, else restore binary and database and wait for the previous version; prune to `--keep`), `deploy/iroha.service` (unit template; drain 30 s, `TimeoutStopSec=40s`, `KillMode=mixed`, `Restart=on-failure`, sandboxed to the install dir). Host, user, port, key, paths, service and address are parameters (flags or `IROHA_DEPLOY_*`); nothing production-specific is hard-coded. SSH runs with `BatchMode=yes` and publickey only; sudo with `-n`. Exit codes 0 / 1 (nothing changed) / 10 (rolled back) / 11 (rollback failed). Runbook is `internal/api/skill/50_deploy.md`, served in `/skill.md`.

Tests: `internal/server/drain_test.go` drives `server.Run` (the SIGTERM path) with a slow route added through the new `server.Options.Routes`: an in-flight request finishes after shutdown starts, and one that outlives the drain limit is cut at the limit and logged `drained: false`. `deploy/unit_test.go` parses the unit through the real config parser and fails if `TimeoutStopSec` is not drain + 5..30 s, and checks the runbook against the script's options and the unit's timings. `deploy/test/e2e.sh` (Docker, not part of `go test`) runs everything against a local Debian container with systemd and sshd: password login refused although the server allows it, `--check`, failing first deploy, first deploy as root with `--install-unit`, deploys as a restricted-sudo user, backup contents, data surviving, drained stop, rollback after a crashing release that damages the DB and after a never-ready one, wrong binary refused with nothing changed, pruning, and a failed rollback (exit 11). 44/44 checks passed.

Not exercised: a real server (forbidden until the Owner switches ms02 to key login; the Owner's one-time setup is in the runbook), arm64 builds, and the real-binary drain under systemd with a long request (no slow production route exists yet; the Go test covers the drain and the e2e shows systemd's stop logging `drained: true`).
