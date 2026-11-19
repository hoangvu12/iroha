#!/usr/bin/env bash
# End-to-end test of deploy/deploy.sh against a local Docker container that
# plays the server (systemd + sshd, see server.Dockerfile). Never touches a
# real server: the target is 127.0.0.1 on a port Docker maps to the
# container. Needs Docker, bash, ssh, scp, ssh-keygen and Go.
#
#   bash deploy/test/e2e.sh            # KEEP_CONTAINER=1 leaves it running
#
# Covers: password login refused even when the server allows it, --check,
# first deploy with --install-unit as root, deploy as the restricted iroha
# user, database backup and data surviving a deploy, graceful stop logged as
# drained, rollback after a binary that crashes (and damages the database)
# and after one that never becomes ready, a failing first deploy, a failed
# rollback (exit 11), refusing a wrong binary before any change, and pruning
# backups.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE=iroha-deploy-e2e
NAME=iroha-deploy-e2e-$$
WORK=$(mktemp -d)
FAILS=0

docker() { MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' command docker "$@"; }
# Local paths handed to docker, a native program on Windows.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
cleanup() {
	if [ "${KEEP_CONTAINER:-0}" = 1 ]; then
		echo "container $NAME left running"
	else
		docker rm -f "$NAME" >/dev/null 2>&1
	fi
	rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf 'PASS  %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { # check DESCRIPTION COMMAND...
	local d=$1
	shift
	if "$@"; then pass "$d"; else bad "$d"; fi
}
on_server() { docker exec "$NAME" bash -c "$1"; }
ready_version() { on_server "curl -fsS http://127.0.0.1:8080/readyz" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
backups() { on_server "find /opt/iroha/backups -mindepth 1 -maxdepth 1 -type d | wc -l"; }

# deploy NAME ARGS...: run deploy.sh, keep its output in $OUT and code in $CODE.
deploy() {
	local label=$1
	shift
	printf '\n---- %s\n' "$label"
	OUT=$(SSH_AUTH_SOCK='' timeout 300 bash "$ROOT/deploy/deploy.sh" --host 127.0.0.1 --port "$PORT" \
		--known-hosts "$WORK/known_hosts" "$@" 2>&1 </dev/null)
	CODE=$?
	printf '%s\n' "$OUT" | sed 's/^/    | /'
}
has() { printf '%s\n' "$OUT" | grep -q -- "$1"; }

echo "building the server image"
docker build -q -t "$IMAGE" -f "$(native "$ROOT/deploy/test/server.Dockerfile")" "$(native "$ROOT/deploy/test")" >/dev/null || { echo "image build failed"; exit 1; }
docker run -d --name "$NAME" --privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock \
	-p 127.0.0.1::22 "$IMAGE" >/dev/null || { echo "container did not start"; exit 1; }
PORT=$(docker port "$NAME" 22 | head -1 | sed 's/.*://')

ssh-keygen -q -t ed25519 -N '' -C e2e-deploy -f "$WORK/deploy_key"
ssh-keygen -q -t ed25519 -N '' -C e2e-stranger -f "$WORK/stranger_key"
chmod 600 "$WORK/deploy_key" "$WORK/stranger_key"
docker cp "$(native "$WORK/deploy_key.pub")" "$NAME:/tmp/key.pub" >/dev/null
on_server 'install -m 600 -o iroha -g iroha /tmp/key.pub /home/iroha/.ssh/authorized_keys && install -m 600 /tmp/key.pub /root/.ssh/authorized_keys'
for _ in $(seq 60); do on_server 'systemctl is-active --quiet ssh' && break; sleep 1; done
KEY="$WORK/deploy_key"

# Test binaries for the failure paths. ExecStart is
# "iroha --data-dir DIR --addr ADDR", so $2 is the data directory.
cat >"$WORK/crash" <<'EOF'
#!/bin/sh
[ "$1" = --version ] && { echo broken-crash; exit 0; }
printf 'IROHA-E2E-DAMAGE' >> "$2/iroha.db"   # a migration gone wrong
exit 1
EOF
cat >"$WORK/hang" <<'EOF'
#!/bin/sh
[ "$1" = --version ] && { echo broken-hang; exit 0; }
exec sleep 100000                            # alive but never ready
EOF
cat >"$WORK/wrong" <<'EOF'
#!/bin/sh
echo something-else
EOF

# 1. Passwords are never used, even though this server accepts them.
check "server under test accepts password login" on_server 'sshd -T 2>/dev/null | grep -qx "passwordauthentication yes"'
deploy "unknown key is refused without a prompt" --user iroha --identity "$WORK/stranger_key" --check
check "unknown key: exit 1" [ "$CODE" = 1 ]
check "unknown key: says SSH keys are required" has "only uses SSH keys"
deploy "password flag is refused" --password hunter2
check "password flag: exit 2" [ "$CODE" = 2 ]

# 2. --check reports what is missing and changes nothing.
deploy "check before the unit exists" --user iroha --identity "$KEY" --check
check "check without unit: exit 1 with a hint" bash -c "[ $CODE = 1 ] && printf '%s' \"\$0\" | grep -q 'deploy once with --install-unit'" "$OUT"
deploy "check as root with --install-unit" --user root --identity "$KEY" --check --install-unit
check "check as root: exit 0" [ "$CODE" = 0 ]

# 3. A failing first deploy has nothing to go back to: it leaves no binary,
# no database and the service stopped.
deploy "failing first deploy" --user root --identity "$KEY" --install-unit --binary "$WORK/crash" --version broken-crash --timeout 6
check "failing first deploy: exit 10" [ "$CODE" = 10 ]
check "failing first deploy: says nothing was restored" has "IROHA_DEPLOY rolled_back version=broken-crash restored=none"
check "failing first deploy: service stopped, nothing left behind" \
	on_server '! systemctl is-active --quiet iroha && [ ! -e /opt/iroha/iroha ] && [ ! -e /opt/iroha/iroha.db ]'

# 4. First deploy, as root, installing the unit.
deploy "first deploy" --user root --identity "$KEY" --install-unit --version e2e-1
check "first deploy: exit 0" [ "$CODE" = 0 ]
check "first deploy: reports the version" has "IROHA_DEPLOY deployed version=e2e-1 previous=none"
check "first deploy: serving e2e-1" [ "$(ready_version)" = e2e-1 ]
check "service runs as iroha, not root" on_server '[ "$(ps -o user= -p "$(systemctl show -p MainPID --value iroha)")" = iroha ]'
check "files written as root belong to iroha" on_server '[ "$(stat -c %U /opt/iroha/iroha)" = iroha ] && [ "$(stat -c %U /opt/iroha/iroha.db)" = iroha ]'
check "unit stop timeout is 40s with SIGTERM to the main process" \
	on_server '[ "$(systemctl show -p TimeoutStopUSec --value iroha)" = 40s ] && [ "$(systemctl show -p KillMode --value iroha)" = mixed ]'
TOKEN=$(on_server "journalctl -u iroha -o cat | grep -o 'iroha_admin_[a-z2-7]*' | head -1")
whoami_ok() { on_server "curl -fsS -o /dev/null -H 'Authorization: Bearer $TOKEN' http://127.0.0.1:8080/api/whoami"; }
check "bootstrap Admin Token works" whoami_ok
check "deploy output never shows the Admin Token" bash -c "! printf '%s' \"\$0\" | grep -q iroha_admin_" "$OUT"

# 5. Normal deploy as the restricted user: backup, drain, data kept.
deploy "second deploy as iroha" --user iroha --identity "$KEY" --version e2e-2
check "second deploy: exit 0" [ "$CODE" = 0 ]
check "second deploy: reports versions" has "IROHA_DEPLOY deployed version=e2e-2 previous=e2e-1"
check "second deploy: serving e2e-2" [ "$(ready_version)" = e2e-2 ]
LATEST=$(on_server 'ls -1 /opt/iroha/backups | sort | tail -1')
check "backup holds database, previous binary and version" \
	on_server "cd /opt/iroha/backups/$LATEST && [ -s iroha.db ] && ./iroha --version | grep -qx e2e-1 && grep -qx e2e-1 version"
check "data survives a deploy (old Admin Token still works)" whoami_ok
check "the stop drained in-flight requests" on_server 'journalctl -u iroha -o cat | grep "\"kind\":\"shutdown\"" | tail -1 | grep -q "\"drained\":true"'

# 6. A binary that crashes and damages the database is rolled back.
deploy "crashing release" --user iroha --identity "$KEY" --binary "$WORK/crash" --version broken-crash --timeout 15
check "crash: exit 10" [ "$CODE" = 10 ]
check "crash: reports the rollback" has "IROHA_DEPLOY rolled_back version=broken-crash restored=e2e-2"
check "crash: previous release serving again" [ "$(ready_version)" = e2e-2 ]
check "crash: database restored from the backup" on_server '! grep -q IROHA-E2E-DAMAGE /opt/iroha/iroha.db'
check "crash: data intact (Admin Token works)" whoami_ok
check "crash: failed binary kept for diagnosis" on_server '[ -f /opt/iroha/.deploy/iroha.failed ]'

# 7. A binary that runs but never becomes ready is rolled back.
deploy "never-ready release" --user iroha --identity "$KEY" --binary "$WORK/hang" --version broken-hang --timeout 8
check "hang: exit 10" [ "$CODE" = 10 ]
check "hang: reports the rollback" has "IROHA_DEPLOY rolled_back version=broken-hang restored=e2e-2"
check "hang: previous release serving again" [ "$(ready_version)" = e2e-2 ]

# 8. A binary that does not report the expected version changes nothing.
BEFORE=$(backups)
deploy "wrong binary" --user iroha --identity "$KEY" --binary "$WORK/wrong" --version e2e-x
check "wrong binary: exit 1" [ "$CODE" = 1 ]
check "wrong binary: service untouched" [ "$(ready_version)" = e2e-2 ]
check "wrong binary: no backup taken" [ "$(backups)" = "$BEFORE" ]

# 9. Old backups are pruned to --keep.
check "backups accumulated before pruning ($BEFORE)" [ "$BEFORE" -ge 4 ]
deploy "deploy with --keep 2" --user iroha --identity "$KEY" --version e2e-3 --keep 2
check "keep 2: exit 0" [ "$CODE" = 0 ]
check "keep 2: two backups left" [ "$(backups)" = 2 ]
check "keep 2: the newest backup is kept" on_server 'grep -qx e2e-2 "/opt/iroha/backups/$(ls -1 /opt/iroha/backups | sort | tail -1)/version"'
check "keep 2: serving e2e-3" [ "$(ready_version)" = e2e-3 ]

# 10. A real Iroha built without the UI ("ui": false on /readyz) is refused
# and rolled back, unless --no-ui says that is intended. It is built from a
# clean export of HEAD, whose internal/webui/dist holds only the placeholder.
mkdir -p "$WORK/noui-src"
(cd "$ROOT" && git archive HEAD) | tar -x -C "$WORK/noui-src" || bad "export HEAD for the no-UI build"
(cd "$WORK/noui-src" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X main.version=e2e-noui" \
	-o "$(native "$WORK/noui")" ./cmd/iroha) || bad "build the no-UI binary"
deploy "release without the UI" --user iroha --identity "$KEY" --binary "$WORK/noui" --version e2e-noui --timeout 30
check "no UI: exit 10" [ "$CODE" = 10 ]
check "no UI: says why" has '"ui": false'
check "no UI: previous release serving again" [ "$(ready_version)" = e2e-3 ]
deploy "release without the UI, on purpose" --user iroha --identity "$KEY" --binary "$WORK/noui" --version e2e-noui --no-ui
check "no UI with --no-ui: exit 0" [ "$CODE" = 0 ]
check "no UI with --no-ui: serving e2e-noui" [ "$(ready_version)" = e2e-noui ]

# 11. When the restored release fails too, the script says so (exit 11).
# "fragile" is a real Iroha that refuses to start once a marker file exists.
(cd "$ROOT" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "-X main.version=e2e-fragile" \
	-o "$(native "$WORK/fragile-real")" ./cmd/iroha) || bad "build the fragile binary"
docker cp "$(native "$WORK/fragile-real")" "$NAME:/opt/iroha/.e2e-fragile-real" >/dev/null
on_server 'chmod 755 /opt/iroha/.e2e-fragile-real'
cat >"$WORK/fragile" <<'EOF'
#!/bin/sh
[ "$1" = --version ] && { echo e2e-fragile; exit 0; }
[ -e "$2/.e2e-break" ] && exit 1
exec "$2/.e2e-fragile-real" "$@"
EOF
deploy "fragile release" --user iroha --identity "$KEY" --binary "$WORK/fragile" --version e2e-fragile
check "fragile: deployed" [ "$CODE" = 0 ]
on_server 'touch /opt/iroha/.e2e-break'
deploy "crash on top of a release that can no longer start" --user iroha --identity "$KEY" --binary "$WORK/crash" --version broken-crash --timeout 6
check "rollback failed: exit 11" [ "$CODE" = 11 ]
check "rollback failed: reported" has "IROHA_DEPLOY rollback_failed version=broken-crash restore=e2e-fragile"
check "rollback failed: tells a human to look" has "ROLLBACK FAILED"

printf '\n'
if [ "$FAILS" = 0 ]; then echo "e2e: all checks passed"; else echo "e2e: $FAILS check(s) failed"; exit 1; fi
