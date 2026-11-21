#!/usr/bin/env bash
# The last line of output is "IROHA_DEPLOY <outcome> key=value...". Exit
# codes: 0 deployed or checked, 1 failed before anything changed, 10 rolled
# back to the previous release, 11 rollback failed (the service may be down).
set -euo pipefail

DIR="" SERVICE="iroha" READY_URL="" VERSION="" TIMEOUT=60 KEEP=5 UNIT=""

say() { printf '==> %s\n' "$*"; }
result() { printf 'IROHA_DEPLOY %s\n' "$*"; }
fail() {
	printf 'error: %s\n' "$2" >&2
	result "failed nothing_changed=yes"
	exit "$1"
}

if [ "$(id -u)" = 0 ]; then SUDO=(); else SUDO=(sudo -n); fi
as_root() { ${SUDO[@]+"${SUDO[@]}"} "$@" </dev/null; }
ctl() { as_root systemctl "$@"; }

chown_to_dir_owner() {
	if [ "$(id -u)" = 0 ]; then chown "$(stat -c %u:%g "$DIR")" "$@"; fi
}
chown_trees_to_dir_owner() {
	if [ "$(id -u)" = 0 ] && [ -d "$DIR" ]; then
		chown -R "$(stat -c %u:%g "$DIR")" "$DIR/.deploy" "$DIR/backups" 2>/dev/null || true
	fi
}
trap chown_trees_to_dir_owner EXIT

fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsS --max-time 5 "$READY_URL" 2>/dev/null
	else
		wget -qO- -T 5 "$READY_URL" 2>/dev/null
	fi
}

wait_ready() {
	local want=$1 need_ui=${2:-0} body got="" deadline=$((SECONDS + TIMEOUT))
	while [ "$SECONDS" -lt "$deadline" ]; do
		if body=$(fetch); then
			got=$(printf '%s' "$body" | sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p')
			if printf '%s' "$body" | grep -q '"status" *: *"ready"' &&{ [ -z "$want" ] || [ "$got" = "$want" ]; }; then
				if [ "$need_ui" = 1 ] && ! printf '%s' "$body" | grep -q '"ui" *: *true'; then
					say "refused: $READY_URL reports version $got without the UI (\"ui\": false); build it with npm --prefix web run build, or deploy with --no-ui on purpose"
					return 1
				fi
				say "ready: $READY_URL reports version $got"
				return 0
			fi
		fi
		sleep 1
	done
	say "not ready within ${TIMEOUT}s: $READY_URL last reported ${got:-nothing}, wanted ${want:-any version}"
	return 1
}

check() {
	local problems=()
	[ -d "$DIR" ] && [ -w "$DIR" ] || problems+=("$DIR is missing or not writable by $(id -un)")
	command -v systemctl >/dev/null || problems+=("systemctl not found; Iroha runs under systemd")
	command -v flock >/dev/null || problems+=("flock not found (util-linux)")
	command -v curl >/dev/null || command -v wget >/dev/null || problems+=("neither curl nor wget is installed; the readiness check needs one")
	if [ -n "$UNIT" ]; then
		if [ "$(id -u)" != 0 ] && ! sudo -n -l install >/dev/null 2>&1; then
			problems+=("--install-unit needs root or passwordless sudo for install and systemctl daemon-reload; connect as root or install the unit by hand (see the runbook)")
		fi
	else
		systemctl cat "$SERVICE" >/dev/null 2>&1 || problems+=("no systemd unit $SERVICE; deploy once with --install-unit or install it by hand (see the runbook)")
	fi
	if [ "$(id -u)" != 0 ]; then
		local verb
		for verb in stop start; do
			sudo -n -l systemctl "$verb" "$SERVICE" >/dev/null 2>&1 ||
				problems+=("$(id -un) may not run 'sudo -n systemctl $verb $SERVICE' without a password; add the sudoers rule from the runbook")
		done
	fi
	if [ -d "$DIR" ]; then
		local used_kb=0 need_kb avail_kb f
		for f in "$DIR/iroha.db" "$DIR/iroha"; do
			if [ -f "$f" ]; then used_kb=$((used_kb + $(du -sk "$f" | cut -f1))); fi
		done
		need_kb=$((used_kb * 2 + 102400))
		avail_kb=$(df -Pk "$DIR" | awk 'NR==2 {print $4}')
		[ "$avail_kb" -ge "$need_kb" ] || problems+=("only ${avail_kb} KB free in $DIR; a backup and swap need about ${need_kb} KB")
	fi
	if [ ${#problems[@]} -gt 0 ]; then
		printf 'error: %s\n' "${problems[@]}" >&2
		result "failed nothing_changed=yes"
		exit 1
	fi
	say "check passed: $(id -un)@$(hostname) can deploy $SERVICE into $DIR"
}

install_unit() {
	say "installing systemd unit $SERVICE"
	as_root install -m 644 "$UNIT" "/etc/systemd/system/$SERVICE.service"
	as_root systemctl daemon-reload
	as_root systemctl enable "$SERVICE" >/dev/null 2>&1 || as_root systemctl enable "$SERVICE"
}

backup() {
	local bk=$1 f
	mkdir -p "$bk" || return 1
	for f in iroha iroha.db iroha.db-wal; do
		[ -f "$DIR/$f" ] || continue
		cp -p "$DIR/$f" "$bk/$f" || return 1
		cmp -s "$DIR/$f" "$bk/$f" || return 1
	done
	printf '%s\n' "$2" >"$bk/version"
}

restore_file() {
	cp -p "$1/$2" "$DIR/$2.restore" && mv -f "$DIR/$2.restore" "$DIR/$2" && chown_to_dir_owner "$DIR/$2"
}

restore_database() {
	local bk=$1 f
	rm -f "$DIR/iroha.db" "$DIR/iroha.db-wal" "$DIR/iroha.db-shm"
	for f in iroha.db iroha.db-wal; do
		if [ -f "$bk/$f" ]; then restore_file "$bk" "$f" || return 1; fi
	done
}

holds_earlier_binary() { [ -f "$1/iroha" ]; }

prune() {
	local old
	old=$(find "$DIR/backups" -mindepth 1 -maxdepth 1 -type d -name '[0-9]*T*Z*' -printf '%f\n' | sort | head -n "-$KEEP")
	for b in $old; do
		rm -rf "${DIR:?}/backups/$b"
		say "pruned backup $b"
	done
}

deploy() {
	local new="$DIR/.deploy/iroha.new" got prev="" stamp bk started
	exec 9>"$DIR/.deploy/lock"
	flock -n 9 || fail 1 "another deploy is running on this server"

	[ -f "$new" ] || fail 1 "$new was not uploaded"
	chmod 755 "$new"
	got=$("$new" --version 2>&1 </dev/null) || fail 1 "the new binary does not run on this server: $got"
	[ "$got" = "$VERSION" ] || fail 1 "the uploaded binary reports version '$got', expected '$VERSION'"
	[ -z "$UNIT" ] || install_unit
	if [ -x "$DIR/iroha" ]; then
		prev=$("$DIR/iroha" --version 2>/dev/null </dev/null || true)
	fi

	stamp=$(date -u +%Y%m%dT%H%M%SZ)
	bk="$DIR/backups/$stamp"
	while [ -e "$bk" ]; do bk="$bk-1"; done

	say "stopping $SERVICE (in-flight requests drain first)"
	ctl stop "$SERVICE" || fail 1 "could not stop $SERVICE"

	say "backing up to $bk"
	if ! backup "$bk" "${prev:-none}"; then
		rm -rf "$bk"
		ctl start "$SERVICE" || true
		fail 1 "backup failed; $SERVICE restarted on the old binary, nothing changed"
	fi
	if [ -f "$bk/iroha.db" ]; then say "database backed up ($(du -h "$bk/iroha.db" | cut -f1))"; else say "no database yet (first start)"; fi

	say "swapping binary: ${prev:-none} -> $VERSION"
	mv -f "$new" "$DIR/iroha"
	chown_to_dir_owner "$DIR/iroha"
	started=$(date +%s)
	say "starting $SERVICE"
	ctl start "$SERVICE" || say "systemctl start failed"

	if wait_ready "$VERSION" "$REQUIRE_UI"; then
		prune
		result "deployed version=$VERSION previous=${prev:-none} backup=$bk"
		return 0
	fi

	say "deploy failed; last log lines of $SERVICE:"
	journalctl -u "$SERVICE" --since "@$started" -n 40 --no-pager -o cat 2>/dev/null | sed 's/iroha_admin_[a-z2-7]*/iroha_admin_<redacted>/g' || true
	say "rolling back to ${prev:-nothing}"
	ctl stop "$SERVICE" || true
	cp -p "$DIR/iroha" "$DIR/.deploy/iroha.failed" 2>/dev/null || true
	if restore_database "$bk"; then
		if ! holds_earlier_binary "$bk"; then
			rm -f "$DIR/iroha"
			prune
			result "rolled_back version=$VERSION restored=none backup=$bk note=first_deploy_service_left_stopped"
			exit 10
		fi
		if restore_file "$bk" iroha; then
			ctl start "$SERVICE" || true
			if wait_ready "$prev"; then
				prune
				result "rolled_back version=$VERSION restored=$prev backup=$bk"
				exit 10
			fi
		fi
	fi
	result "rollback_failed version=$VERSION restore=$prev backup=$bk"
	exit 11
}

main() {
	local cmd=${1:-}
	REQUIRE_UI=1
	shift || true
	while [ $# -gt 0 ]; do
		case $1 in
		--dir) DIR=${2%/} ;;
		--service) SERVICE=$2 ;;
		--ready-url) READY_URL=$2 ;;
		--version) VERSION=$2 ;;
		--timeout) TIMEOUT=$2 ;;
		--keep) KEEP=$2 ;;
		--unit) UNIT=$2 ;;
		--allow-no-ui) REQUIRE_UI=0; shift; continue ;;
		*) fail 1 "unknown argument $1" ;;
		esac
		shift 2
	done
	[ -n "$DIR" ] && [ -n "$READY_URL" ] || fail 1 "--dir and --ready-url are required"
	[[ $KEEP =~ ^[1-9][0-9]*$ ]] || fail 1 "--keep must be a whole number of at least 1"
	[[ $TIMEOUT =~ ^[1-9][0-9]*$ ]] || fail 1 "--timeout must be a whole number of seconds"
	case $cmd in
	check) check ;;
	deploy)
		[ -n "$VERSION" ] || fail 1 "--version is required"
		check
		deploy
		;;
	*) fail 1 "unknown command '$cmd' (check or deploy)" ;;
	esac
}

main "$@"
