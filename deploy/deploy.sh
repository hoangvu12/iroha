#!/usr/bin/env bash
# Deploy Iroha to a Linux server over SSH keys: build the binary for the
# server, copy it, back up the database, swap the binary, restart the systemd
# service, check readiness, and roll back automatically when the check fails.
# The runbook is in GET /skill.md ("Deploying Iroha"); run with --help for
# the options.
#
# Never reads, writes or prompts for a password: SSH runs in BatchMode with
# public-key authentication only, and sudo on the server runs with -n.
set -euo pipefail

usage() {
	cat <<'EOF'
Usage: deploy/deploy.sh --host HOST [options]

Builds Iroha for Linux and deploys it to HOST over SSH keys, with a database
backup and automatic rollback. Every option can also be set as an
environment variable (shown in brackets).

Target:
  --host HOST          server name or address (no user@) [IROHA_DEPLOY_HOST]
  --user USER          SSH login, default iroha [IROHA_DEPLOY_USER]
  --port PORT          SSH port, default 22 [IROHA_DEPLOY_PORT]
  --identity FILE      SSH private key; default: ssh's own keys and agent
                       [IROHA_DEPLOY_IDENTITY]
  --known-hosts FILE   known_hosts file to use [IROHA_DEPLOY_KNOWN_HOSTS]
  --dir DIR            install directory holding the binary, iroha.db and
                       backups/, default /opt/iroha [IROHA_DEPLOY_DIR]
  --service NAME       systemd service, default iroha [IROHA_DEPLOY_SERVICE]
  --addr ADDR          Iroha's listen address in the unit, default
                       127.0.0.1:8080 [IROHA_DEPLOY_ADDR]
  --ready-url URL      readiness URL as seen on the server; default from
                       --addr, e.g. http://127.0.0.1:8080/readyz
                       [IROHA_DEPLOY_READY_URL]
  --run-as USER        user the service runs as (unit only), default iroha
                       [IROHA_DEPLOY_RUN_AS]

Release:
  --version V          version to stamp; default: git describe plus UTC time
  --arch ARCH          amd64 or arm64; default: detected on the server
  --binary FILE        deploy this Linux binary instead of building (needs
                       --version, which must match its --version output)
  --timeout SECONDS    how long to wait for readiness, default 60
  --keep N             database backups to keep on the server, default 5
  --no-ui              skip the UI build (npm in web/); the binary then serves
                       a "UI not built" page. Ignored with --binary

Modes:
  --install-unit       also install or update the systemd unit (needs root
                       or passwordless sudo on the server)
  --check              connect and check the server can be deployed to;
                       change nothing
  --print-unit         print the rendered systemd unit and exit
  --dry-run            print what would run; touch nothing
  -h, --help           show this help

Output ends with one line "IROHA_DEPLOY <outcome> key=value...".
Exit codes: 0 deployed (or checked), 1 failed and nothing changed on the
server, 2 bad usage, 10 the new release failed its readiness check and the
previous binary and database were restored, 11 the rollback also failed
(the service may be down; a human must look).
EOF
}

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DEPLOY_DIR="$ROOT/deploy"

HOST=${IROHA_DEPLOY_HOST:-}
SSH_USER=${IROHA_DEPLOY_USER:-iroha}
PORT=${IROHA_DEPLOY_PORT:-22}
IDENTITY=${IROHA_DEPLOY_IDENTITY:-}
KNOWN_HOSTS=${IROHA_DEPLOY_KNOWN_HOSTS:-}
DIR=${IROHA_DEPLOY_DIR:-/opt/iroha}
SERVICE=${IROHA_DEPLOY_SERVICE:-iroha}
ADDR=${IROHA_DEPLOY_ADDR:-127.0.0.1:8080}
READY_URL=${IROHA_DEPLOY_READY_URL:-}
RUN_AS=${IROHA_DEPLOY_RUN_AS:-iroha}
VERSION="" ARCH="" BINARY="" TIMEOUT=60 KEEP=5
INSTALL_UNIT=0 MODE=deploy DRY_RUN=0 NO_UI=0

die() { # die CODE MESSAGE
	printf 'deploy: %s\n' "$2" >&2
	[ "$1" = 2 ] || printf 'IROHA_DEPLOY failed nothing_changed=yes\n'
	exit "$1"
}
say() { printf '==> %s\n' "$*"; }

while [ $# -gt 0 ]; do
	opt=$1
	case $opt in
	-h | --help) usage; exit 0 ;;
	--install-unit) INSTALL_UNIT=1; shift; continue ;;
	--no-ui) NO_UI=1; shift; continue ;;
	--check) MODE=check; shift; continue ;;
	--print-unit) MODE=print-unit; shift; continue ;;
	--dry-run) DRY_RUN=1; shift; continue ;;
	--host | --user | --port | --identity | --known-hosts | --dir | --service | --addr | --ready-url | --run-as | --version | --arch | --binary | --timeout | --keep)
		[ $# -ge 2 ] || die 2 "$opt needs a value"
		val=$2
		shift 2
		;;
	--password* | --pass | --sshpass*)
		die 2 "$opt: this script never takes passwords; set up SSH key login (see the runbook)" ;;
	*) die 2 "unknown option $opt (see --help)" ;;
	esac
	case $opt in
	--host) HOST=$val ;;
	--user) SSH_USER=$val ;;
	--port) PORT=$val ;;
	--identity) IDENTITY=$val ;;
	--known-hosts) KNOWN_HOSTS=$val ;;
	--dir) DIR=${val%/} ;;
	--service) SERVICE=$val ;;
	--addr) ADDR=$val ;;
	--ready-url) READY_URL=$val ;;
	--run-as) RUN_AS=$val ;;
	--version) VERSION=$val ;;
	--arch) ARCH=$val ;;
	--binary) BINARY=$val ;;
	--timeout) TIMEOUT=$val ;;
	--keep) KEEP=$val ;;
	esac
done

# Values end up in a systemd unit, remote command lines and ldflags, so
# allow only plain characters.
[[ $DIR =~ ^/[A-Za-z0-9_./-]+$ ]] || die 2 "--dir must be an absolute path of plain characters, got '$DIR'"
[[ $SERVICE =~ ^[A-Za-z0-9_.-]+$ ]] || die 2 "--service: plain characters only, got '$SERVICE'"
[[ $RUN_AS =~ ^[a-z_][a-z0-9_-]*$ ]] || die 2 "--run-as: not a user name: '$RUN_AS'"
[[ $ADDR =~ ^([A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\]):[0-9]+$ ]] || die 2 "--addr must be host:port, got '$ADDR'"
[[ $TIMEOUT =~ ^[1-9][0-9]*$ ]] || die 2 "--timeout must be whole seconds, got '$TIMEOUT'"
[[ $KEEP =~ ^[1-9][0-9]*$ ]] || die 2 "--keep must be at least 1, got '$KEEP'"
[ -z "$ARCH" ] || [[ $ARCH =~ ^(amd64|arm64)$ ]] || die 2 "--arch must be amd64 or arm64, got '$ARCH'"
[ -z "$VERSION" ] || [[ $VERSION =~ ^[A-Za-z0-9._+-]+$ ]] || die 2 "--version: plain characters only, got '$VERSION'"
if [ -z "$READY_URL" ]; then
	host_part=${ADDR%:*}
	case $host_part in "" | 0.0.0.0) host_part=127.0.0.1 ;; "[::]") host_part="[::1]" ;; esac
	READY_URL="http://$host_part:${ADDR##*:}/readyz"
fi

render_unit() {
	sed -e "s|@DIR@|$DIR|g" -e "s|@ADDR@|$ADDR|g" -e "s|@RUN_AS@|$RUN_AS|g" "$DEPLOY_DIR/iroha.service"
}

if [ "$MODE" = print-unit ]; then
	render_unit
	exit 0
fi

[ -n "$HOST" ] || die 2 "--host is required (or IROHA_DEPLOY_HOST)"
[[ $HOST =~ ^[A-Za-z0-9.:_-]+$ ]] || die 2 "--host: give the name or address only (the login goes in --user), got '$HOST'"
[[ $SSH_USER =~ ^[a-z_][a-z0-9_-]*$ ]] || die 2 "--user: not a user name: '$SSH_USER'"
[[ $PORT =~ ^[0-9]+$ ]] || die 2 "--port must be a number, got '$PORT'"
if [ -n "$BINARY" ]; then
	[ -f "$BINARY" ] || die 2 "--binary $BINARY does not exist"
	[ -n "$VERSION" ] || die 2 "--binary needs --version (what the binary prints for --version)"
fi
[ -z "$IDENTITY" ] || [ -f "$IDENTITY" ] || die 2 "--identity $IDENTITY does not exist"

# Git Bash on Windows rewrites arguments that look like paths when calling
# native programs; remote paths must pass through untouched.
export MSYS2_ARG_CONV_EXCL='*' MSYS_NO_PATHCONV=1
native_path() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# Public-key authentication only, never a prompt: BatchMode makes ssh fail
# instead of asking for a password, passphrase or host-key confirmation.
SSH_OPTS=(
	-o BatchMode=yes
	-o PreferredAuthentications=publickey
	-o PubkeyAuthentication=yes
	-o PasswordAuthentication=no
	-o KbdInteractiveAuthentication=no
	-o StrictHostKeyChecking=accept-new
	-o ConnectTimeout=15
	-o ServerAliveInterval=15
	-o ServerAliveCountMax=4
	-o LogLevel=ERROR
	-o Port="$PORT"
)
[ -z "$IDENTITY" ] || SSH_OPTS+=(-o IdentityFile="$IDENTITY" -o IdentitiesOnly=yes)
[ -z "$KNOWN_HOSTS" ] || SSH_OPTS+=(-o UserKnownHostsFile="$KNOWN_HOSTS")
export SSH_ASKPASS_REQUIRE=never
unset SSH_ASKPASS DISPLAY
TARGET="$SSH_USER@$HOST"

show() { printf '+'; printf ' %q' "$@"; printf '\n'; }
# run CMD...: run it, or only show it under --dry-run.
run() { if [ "$DRY_RUN" = 1 ]; then show "$@"; else "$@"; fi; }
# remote_sh LINE: run a shell command line on the server.
remote_sh() { run ssh "${SSH_OPTS[@]}" "$TARGET" "$1" </dev/null; }
# remote CMD...: run CMD on the server; arguments are quoted for its shell.
remote() { remote_sh "$(printf '%q ' "$@")"; }

ssh_failed() {
	if [ "$1" = 255 ]; then
		die 1 "could not log in to $TARGET over SSH. This script only uses SSH keys: put your public key in ~$SSH_USER/.ssh/authorized_keys on the server (see the runbook), pass --identity, and check the host key in known_hosts"
	fi
	die 1 "SSH step failed on $TARGET (exit $1): ${2:-see above}; nothing was changed"
}
upload() { run scp -q "${SSH_OPTS[@]}" "$@" "$TARGET:$DIR/.deploy/" </dev/null || ssh_failed $? "copying into $DIR/.deploy/ (can $SSH_USER write there?)"; }

remote_args=(--dir "$DIR" --service "$SERVICE" --ready-url "$READY_URL")

say "target $TARGET:$PORT, service $SERVICE in $DIR, readiness $READY_URL"
set +e
detected=$(remote_sh "mkdir -p $(printf '%q' "$DIR/.deploy") && uname -m")
status=$?
set -e
[ "$status" = 0 ] || ssh_failed "$status" "creating $DIR/.deploy (does $DIR exist and can $SSH_USER write it?)"
if [ "$DRY_RUN" = 1 ]; then
	printf '%s\n' "$detected"
	detected=x86_64
fi
if [ -z "$ARCH" ]; then
	case $detected in
	x86_64 | amd64) ARCH=amd64 ;;
	aarch64 | arm64) ARCH=arm64 ;;
	*) die 1 "server architecture '$detected' is not supported; pass --arch" ;;
	esac
fi

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp "$DEPLOY_DIR/remote.sh" "$STAGE/remote.sh"
uploads=("$STAGE/remote.sh")
if [ "$INSTALL_UNIT" = 1 ]; then
	render_unit >"$STAGE/$SERVICE.service"
	uploads+=("$STAGE/$SERVICE.service")
	remote_args+=(--unit "$DIR/.deploy/$SERVICE.service")
fi

if [ "$MODE" = check ]; then
	upload "${uploads[@]}"
	set +e
	remote bash "$DIR/.deploy/remote.sh" check "${remote_args[@]}"
	status=$?
	set -e
	[ "$status" = 0 ] && [ "$DRY_RUN" = 0 ] && printf 'IROHA_DEPLOY checked host=%s\n' "$HOST"
	exit "$status"
fi

if [ -z "$VERSION" ]; then
	VERSION="$(cd "$ROOT" && git describe --tags --always --dirty 2>/dev/null || echo unknown)-$(date -u +%Y%m%d%H%M%S)"
fi
if [ -n "$BINARY" ]; then
	say "using $BINARY as version $VERSION"
	run cp "$BINARY" "$STAGE/iroha.new"
else
	if [ "$NO_UI" = 0 ]; then
		say "building the UI (web/ into internal/webui/dist)"
		command -v npm >/dev/null 2>&1 || die 1 "npm not found: the UI build needs Node 22+ (or pass --no-ui to ship without the UI)"
		(cd "$ROOT" && run npm --prefix web ci --no-audit --no-fund && run npm --prefix web run build) ||
			die 1 "UI build failed; nothing was sent to the server"
		[ "$DRY_RUN" = 1 ] || [ -f "$ROOT/internal/webui/dist/index.html" ] ||
			die 1 "UI build produced no internal/webui/dist/index.html; nothing was sent to the server"
	fi
	say "building $VERSION for linux/$ARCH"
	(cd "$ROOT" && run env CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" go build -trimpath \
		-ldflags "-s -w -X main.version=$VERSION" -o "$(native_path "$STAGE/iroha.new")" ./cmd/iroha) ||
		die 1 "build failed; nothing was sent to the server"
fi
uploads+=("$STAGE/iroha.new")

say "uploading to $TARGET:$DIR/.deploy/"
upload "${uploads[@]}"

say "deploying on $HOST"
set +e
remote bash "$DIR/.deploy/remote.sh" deploy "${remote_args[@]}" \
	--version "$VERSION" --timeout "$TIMEOUT" --keep "$KEEP"
status=$?
set -e
case $status in
0) [ "$DRY_RUN" = 1 ] || say "deployed $VERSION to $HOST" ;;
10) say "the new release failed its readiness check and was rolled back (see above)" ;;
11) say "ROLLBACK FAILED: $SERVICE on $HOST may be down; read the output above and the runbook" ;;
255) ssh_failed "$status" ;;
esac
exit "$status"
