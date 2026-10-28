#!/usr/bin/env bash
#
# Mas Sular — offline test of restore-drill.sh's isolation, resource caps and cleanup.
#
# Runs the drill against FAKE `docker` and `gpg` commands placed first on PATH, with a
# dummy artifact, key and manifest created here, and DOCKER_HOST pointing at a socket
# that does not exist. No container is started, no Docker daemon is contacted and no
# real backup or key is read.
#
# Usage (repo root):  bash scripts/backup/test-restore-drill-cleanup.sh
# Needs: bash, coreutils, awk. Takes about ten seconds.
#
set -Euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DRILL="$HERE/restore-drill.sh"
T="$(mktemp -d)"
PASS=0; FAILS=0

ok()   { PASS=$((PASS + 1)); echo "  PASS  $*"; }
bad()  { FAILS=$((FAILS + 1)); echo "  FAIL  $*"; }
check() { local label="$1"; shift; if "$@"; then ok "$label"; else bad "$label"; fi; }

cleanup() {
  for f in "$T"/*/state/hang.pid; do [[ -f "$f" ]] && kill "$(cat "$f")" 2>/dev/null; done
  rm -rf "$T"
}
trap cleanup EXIT

mkdir -p "$T/bin"
cat > "$T/bin/gpg" <<'EOF'
#!/usr/bin/env bash
# fake gpg: "decrypts" by writing a fixed plaintext to the -o target
echo "gpg $*" >> "$FAKE_STATE/calls"
out=""; while (( $# )); do [[ "$1" == -o ]] && { out="$2"; shift; }; shift; done
[[ -n "$out" ]] && printf 'PGDMP-fake-plaintext' > "$out"
EOF
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
# fake docker: records every call, never talks to a daemon
echo "docker $*" >> "$FAKE_STATE/calls"
case "$1" in
  container) [[ "${FAKE_COLLIDE:-0}" == 1 ]] && exit 0; exit 1 ;;   # container inspect <name>
  run)
    while (( $# )); do [[ "$1" == --label ]] && echo "$2" > "$FAKE_STATE/label"; shift; done
    echo fakecontainerid ;;
  ps)
    [[ -f "$FAKE_STATE/label" && ! -f "$FAKE_STATE/removed" ]] || exit 0
    [[ "$*" == *"label=$(cat "$FAKE_STATE/label")"* ]] && echo fakecontainerid ;;
  rm) touch "$FAKE_STATE/removed" ;;
  exec)
    case "$*" in
      *pg_isready*) exit 0 ;;
      *pg_restore*)
        case "${FAKE_RESTORE:-ok}" in
          fail) cat > /dev/null; echo "pg_restore: error: fake failure" >&2; exit 1 ;;
          hang) echo $$ > "$FAKE_STATE/hang.pid"; exec sleep 60 ;;
          *)    cat > /dev/null ;;
        esac ;;
      *du\ -sm*) printf '123\t/var/lib/postgresql/data\n' ;;
      *psql*) echo 3 ;;
    esac ;;
esac
EOF
chmod +x "$T/bin/gpg" "$T/bin/docker"

printf 'not-a-real-backup' > "$T/artifact.dump.enc"
printf 'not-a-real-key' > "$T/test.key"
ART_SHA="$(sha256sum "$T/artifact.dump.enc" | cut -d' ' -f1)"
PLAIN_SHA="$(printf 'PGDMP-fake-plaintext' | sha256sum | cut -d' ' -f1)"
cat > "$T/manifest.json" <<JSON
{
  "postgres": {
    "sha256": "${ART_SHA}",
    "plaintext_sha256": "${PLAIN_SHA}"
  }
}
JSON

# run_drill <case> [VAR=value ...]: synchronous run; sets RC, leaves output in $T/<case>/out
run_drill() {
  local c="$1"; shift
  mkdir -p "$T/$c/state" "$T/$c/tmp"
  env PATH="$T/bin:$PATH" DOCKER_HOST="unix://$T/no-docker.sock" FAKE_STATE="$T/$c/state" TMPDIR="$T/$c/tmp" \
    BACKUP_KEY_FILE="$T/test.key" DRILL_MIN_HOST_AVAILABLE_MB=0 "$@" \
    bash "$DRILL" "$T/artifact.dump.enc" "$T/manifest.json" > "$T/$c/out" 2>&1
  RC=$?
}

# signal_drill <case> <signal>: interrupts the drill while pg_restore "runs"; sets RC, SECS
signal_drill() {
  local c="$1" sig="$2" pid start
  mkdir -p "$T/$c/state" "$T/$c/tmp"
  set -m   # own process group, so SIGINT is not ignored by the background job
  env PATH="$T/bin:$PATH" DOCKER_HOST="unix://$T/no-docker.sock" FAKE_STATE="$T/$c/state" TMPDIR="$T/$c/tmp" FAKE_RESTORE=hang \
    BACKUP_KEY_FILE="$T/test.key" DRILL_MIN_HOST_AVAILABLE_MB=0 \
    bash "$DRILL" "$T/artifact.dump.enc" "$T/manifest.json" > "$T/$c/out" 2>&1 &
  pid=$!
  set +m
  for _ in $(seq 1 100); do [[ -f "$T/$c/state/hang.pid" ]] && break; sleep 0.2; done
  start=$SECONDS
  kill -s "$sig" "$pid"
  wait "$pid"; RC=$?
  SECS=$((SECONDS - start))
}

calls()     { cat "$T/$1/state/calls" 2>/dev/null; }
run_line()  { calls "$1" | grep '^docker run '; }
no_plain()  { test -z "$(find "$T/$1/tmp" -mindepth 1 -print -quit)"; }
removed_once() { test "$(calls "$1" | grep -c '^docker rm -f -v fakecontainerid$')" -eq 1; }
never_ran() { ! calls "$1" | grep -q '^docker run '; }
never_rm()  { ! calls "$1" | grep -q '^docker rm '; }

echo "== 1. success"
run_drill ok
RUN="$(run_line ok)"
check "exits 0" test "$RC" -eq 0
check "reports DRILL_TABLES / migrations / data size" grep -q '^DRILL_TABLES=3$' "$T/ok/out"
check "reports DRILL_DATA_MB" grep -q '^DRILL_DATA_MB=123$' "$T/ok/out"
check "manifest checks still run" grep -q 'decrypted dump matches manifest' "$T/ok/out"
check "docker run: --rm" grep -q -- ' --rm ' <<< "$RUN"
check "docker run: --network none" grep -q -- ' --network none ' <<< "$RUN"
check "docker run: PGDATA on a size-capped tmpfs" grep -q -- ' --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=448m,mode=0700 ' <<< "$RUN"
check "docker run: PGDATA pinned to the tmpfs path" grep -q -- ' -e PGDATA=/var/lib/postgresql/data ' <<< "$RUN"
check "docker run: memory cap with swap disabled" grep -q -- ' --memory 768m --memory-swap 768m ' <<< "$RUN"
check "docker run: CPU, pids and OOM-priority caps" grep -q -- ' --cpus 0.5 --pids-limit 128 --oom-score-adj 500 ' <<< "$RUN"
check "docker run: no volume or bind mount" bash -c '! grep -qE -- " (-v|--volume|--mount|--volumes-from) " <<< "$1"' _ "$RUN"
check "docker run: random 48-hex password" grep -qE -- ' -e POSTGRES_PASSWORD=[0-9a-f]{48} ' <<< "$RUN"
check "docker run: random run label" grep -qE -- ' --label id\.baksomassular\.restore-drill=[0-9a-f]{16} ' <<< "$RUN"
check "cleanup lists only this run's label" bash -c 'grep -q "^docker ps -aq --filter label=$2\$" <<< "$1"' _ "$(calls ok)" "$(cat "$T/ok/state/label")"
check "container removed once, with its anonymous volumes (-v)" removed_once ok
check "decrypted dump gone" no_plain ok

echo "== 2. pg_restore fails"
run_drill restorefail FAKE_RESTORE=fail
check "exits non-zero" test "$RC" -ne 0
check "failure reported" grep -q 'pg_restore failed: pg_restore: error: fake failure' "$T/restorefail/out"
check "container removed once (-v)" removed_once restorefail
check "decrypted dump gone" no_plain restorefail

echo "== 3. SIGTERM during the restore"
signal_drill sigterm TERM
check "exits 143 (got $RC)" test "$RC" -eq 143
check "stops promptly, not after pg_restore (${SECS}s)" test "$SECS" -le 5
check "container removed once (-v)" removed_once sigterm
check "decrypted dump gone" no_plain sigterm
check "failure logged" grep -q 'restore drill FAILED (exit 143)' "$T/sigterm/out"

echo "== 4. SIGINT during the restore"
signal_drill sigint INT
check "exits 130 (got $RC)" test "$RC" -eq 130
check "stops promptly, not after pg_restore (${SECS}s)" test "$SECS" -le 5
check "container removed once (-v)" removed_once sigint
check "decrypted dump gone" no_plain sigint

echo "== 5. a container with the drill's name already exists"
run_drill collide FAKE_COLLIDE=1
check "exits non-zero" test "$RC" -ne 0
check "refusal reported" grep -q 'already exists; refusing to touch it' "$T/collide/out"
check "nothing started" never_ran collide
check "existing container NOT removed" never_rm collide
check "decrypted dump gone" no_plain collide

echo "== 6. preflight refusals start nothing and decrypt nothing"
run_drill lowmem DRILL_MIN_HOST_AVAILABLE_MB=99999999
check "low host memory: exits non-zero" test "$RC" -ne 0
check "low host memory: reported" grep -q 'refusing to squeeze the running stacks' "$T/lowmem/out"
check "low host memory: no decrypt, no container" bash -c '! grep -qE "^(gpg|docker) " "$1/state/calls" 2>/dev/null' _ "$T/lowmem"
run_drill tight DRILL_MEMORY_MB=768 DRILL_TMPFS_MB=700
check "tmpfs too close to memory cap: refused" grep -q 'must be at least DRILL_TMPFS_MB + 320' "$T/tight/out"
check "tmpfs too close to memory cap: nothing started" never_ran tight
printf 'x' > "$T/tampered.dump.enc"
mkdir -p "$T/tamper/state" "$T/tamper/tmp"
env PATH="$T/bin:$PATH" DOCKER_HOST="unix://$T/no-docker.sock" FAKE_STATE="$T/tamper/state" TMPDIR="$T/tamper/tmp" BACKUP_KEY_FILE="$T/test.key" \
  DRILL_MIN_HOST_AVAILABLE_MB=0 bash "$DRILL" "$T/tampered.dump.enc" "$T/manifest.json" > "$T/tamper/out" 2>&1; RC=$?
check "artifact checksum mismatch: refused" test "$RC" -ne 0
check "artifact checksum mismatch: nothing started" never_ran tamper

echo "== result: ${PASS} passed, ${FAILS} failed"
(( FAILS == 0 ))
