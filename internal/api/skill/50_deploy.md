## Deploying Iroha

Deploy only when the Owner asks. You need a checkout of the Iroha repository, Go, bash (Git Bash on Windows) and an SSH key that can log in to the server. The script never uses passwords: SSH runs in batch mode with keys only, and `sudo` on the server runs with `-n`. If key login fails, stop and ask the Owner; never ask for, type or store a password.

```
deploy/deploy.sh --host <server> --check     # can I deploy? changes nothing
deploy/deploy.sh --host <server>             # deploy the checked-out commit
```

Defaults: SSH user `iroha`, install directory `/opt/iroha`, service `iroha`, listening on `127.0.0.1:8080`. `deploy/deploy.sh --help` lists the options (`--user`, `--port`, `--identity`, `--dir`, `--service`, `--addr`, `--timeout`, `--keep`, `--dry-run`, ...); each also reads an `IROHA_DEPLOY_*` variable.

What a deploy does: build the UI (`npm --prefix web ci && npm --prefix web run build`; needs Node 22+, skip with `--no-ui`) and the binary for the server's architecture with a version of `<git describe>-<UTC time>`; copy the binary to `<dir>/.deploy/`; check it runs and reports that version; stop the service (Iroha drains in-flight requests, see below); copy the binary and `iroha.db` to `<dir>/backups/<UTC time>/`; swap in the new binary; start; wait until `GET /readyz` reports the new version. On success it deletes all but the newest `--keep` backups (default 5).

The last line of output is `IROHA_DEPLOY <outcome> key=value...`:

| Exit | Outcome | What to do |
|---|---|---|
| 0 | `deployed version=V previous=P backup=B` | Confirm with `GET /readyz`; report V to the Owner. |
| 1 | `failed nothing_changed=yes` | Read the `error:` lines (no key login, missing sudo rule, build failed, wrong binary) and fix that. The server is untouched. |
| 10 | `rolled_back version=V restored=P` | The new release never became ready. The previous binary and the database from before the deploy are back and serving. The output shows the failed release's log lines; the binary is kept at `<dir>/.deploy/iroha.failed`. Fix the cause before deploying again. |
| 11 | `rollback_failed` | The service may be down. Tell the Owner at once, then follow "Restore by hand". |

A rollback also restores the database, so anything the failed release wrote is discarded (it was never ready, so Callers were not served by it).

### One-time server setup (the Owner, as root)

1. Create the user and directory, let the user see the service's logs, and allow it to stop and start the service without a password:

   ```
   useradd --create-home --shell /bin/bash iroha
   install -d -o iroha -g iroha -m 755 /opt/iroha
   usermod -aG systemd-journal iroha
   echo 'iroha ALL=(root) NOPASSWD: /usr/bin/systemctl start iroha, /usr/bin/systemctl stop iroha, /usr/bin/systemctl restart iroha' > /etc/sudoers.d/iroha-deploy
   chmod 440 /etc/sudoers.d/iroha-deploy
   ```

2. Add the deploying machine's public key to `/home/iroha/.ssh/authorized_keys` (mode 600, owned by `iroha`). Turn password login off in `/etc/ssh/sshd_config` (`PasswordAuthentication no`, `KbdInteractiveAuthentication no`) and reload sshd.
3. Install the systemd unit, either by running the first deploy as root with key login (`--user root --install-unit`), or by hand: `deploy/deploy.sh --print-unit > iroha.service`, copy it to `/etc/systemd/system/iroha.service`, then `systemctl daemon-reload && systemctl enable iroha`. Re-run with `--install-unit` (as root) whenever `deploy/iroha.service` changes.
4. The first start prints the bootstrap Admin Token once to the service log: the Owner reads it with `journalctl -u iroha | grep iroha_admin_`. The deploy output never shows it.

The server needs systemd, `curl` or `wget`, and `flock`. Only the binary is copied; there is no source checkout on the server.

### Restarts and draining

On SIGTERM Iroha stops accepting new connections (so `GET /readyz` stops answering) and lets in-flight requests finish for at most `IROHA_DRAIN_TIMEOUT` (30 s in the unit); then it cuts what is left and logs a `shutdown` event with `drained: true` or `false`. systemd waits `TimeoutStopSec` (40 s) before killing it, so keep that above the drain limit if either changes (`deploy/unit_test.go` checks). A deploy therefore waits up to 30 s for long streams before the swap.

### Backups and restoring by hand

Each deploy leaves `<dir>/backups/<UTC time>/` holding `iroha` (the binary that was running), `iroha.db` (taken while the service was stopped, so it is consistent), and `version`. To go back to one by hand on the server:

```
sudo systemctl stop iroha
cd /opt/iroha && B=backups/<UTC time>
cp -p $B/iroha iroha && rm -f iroha.db-wal iroha.db-shm && cp -p $B/iroha.db* .
sudo systemctl start iroha && curl -s http://127.0.0.1:8080/readyz
```

Restoring a database discards everything written since that backup, including Requests and configuration changes; tell the Owner first. To return to an older release without touching data, check out that commit and deploy it normally.
