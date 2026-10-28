#!/usr/bin/env bash
#
# Mas Sular — PostgreSQL restore DRILL.
#
# Decrypts one backup artifact and restores it into a DISPOSABLE PostgreSQL
# container that has NO network at all (--network none), reports what came back,
# then removes that container. It never touches the application's containers,
# volumes or database, so it is safe to run on the production VPS at any time -
# and it is how you PROVE a backup restores, before you ever need it.
#
# The restored database is plaintext customer data, so it never reaches a Docker
# volume or the disk: PGDATA is a size-capped tmpfs inside a memory-capped
# container with swap disabled, and both disappear with the container. Only the
# container labelled with this run's random id is ever removed.
#
# Usage:
#   BACKUP_KEY_FILE=/etc/mas-sular/backup.key \
#     ./scripts/backup/restore-drill.sh /srv/backups/mas-sular/mas-sular-postgres-<TS>.dump.enc \
#                                      /srv/backups/mas-sular/manifest-<TS>.json
#
# The manifest is optional but recommended: when given, the artifact AND the
# decrypted dump must match its checksums before anything is restored.
# Resource caps (RUNBOOK §8.1): DRILL_MEMORY_MB, DRILL_TMPFS_MB, DRILL_CPUS,
# DRILL_MIN_HOST_AVAILABLE_MB.
# Prints DRILL_* summary lines; exits non-zero on any failure or interruption.
#
set -Eeuo pipefail

ARTIFACT="${1:?usage: restore-drill.sh <postgres .dump.enc> [manifest.json]}"
MANIFEST="${2:-}"
BACKUP_KEY_FILE="${BACKUP_KEY_FILE:?BACKUP_KEY_FILE must be set}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"   # same major version as production
DRILL_MEMORY_MB="${DRILL_MEMORY_MB:-768}"    # container RAM cap (tmpfs pages count against it); swap disabled
DRILL_TMPFS_MB="${DRILL_TMPFS_MB:-448}"      # PGDATA size cap; a full tmpfs fails the restore cleanly
DRILL_CPUS="${DRILL_CPUS:-0.5}"              # leave half of the single vCPU to the running stacks
PGDATA_DIR=/var/lib/postgresql/data          # the image's VOLUME path: the tmpfs covers it, so no volume

DRILL_ID="$(head -c 8 /dev/urandom | od -An -tx1 | tr -d ' \n')"
DRILL_LABEL="id.baksomassular.restore-drill"
NAME="massular-restore-drill-$(date -u +%Y%m%d%H%M%S)-${DRILL_ID}"
WORK="$(mktemp -d)"
LAUNCHED=0

log()  { printf '[drill %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { printf '[drill %s] ERROR: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 1; }

cleanup() {
  local rc=$? ids=()
  trap - EXIT
  trap '' INT TERM HUP                                     # finish cleaning up even if interrupted again
  rm -rf "$WORK"                                           # decrypted dump never survives
  if (( LAUNCHED )); then
    # Only the container carrying THIS run's random label; -v also drops any anonymous
    # volume it owns (none is expected while PGDATA is a tmpfs). Pre-existing containers
    # and volumes can never match.
    mapfile -t ids < <(docker ps -aq --filter "label=${DRILL_LABEL}=${DRILL_ID}" 2>/dev/null || true)
    (( ${#ids[@]} )) && docker rm -f -v "${ids[@]}" >/dev/null 2>&1 || true
  fi
  (( rc != 0 )) && log "restore drill FAILED (exit $rc)" || true
  exit $rc
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

manifest_field() { # manifest_field <section> <key>  -> value (flat JSON written by backup.sh)
  awk -v s="\"$1\"" -v k="\"$2\"" '
    index($0, s) { inside = 1 }
    inside && index($0, k) { sub(/.*: *"?/, ""); sub(/"?,? *$/, ""); print; exit }
  ' "$MANIFEST"
}

[[ "$DRILL_MEMORY_MB" =~ ^[0-9]+$ && "$DRILL_TMPFS_MB" =~ ^[0-9]+$ ]] || fail "DRILL_MEMORY_MB and DRILL_TMPFS_MB must be whole MiB"
[[ "$DRILL_CPUS" =~ ^[0-9]+(\.[0-9]+)?$ ]] || fail "DRILL_CPUS must be a number of CPUs, e.g. 0.5"
# shared_buffers (64MB) + /dev/shm (<=64MB) + server and pg_restore processes need ~320 MiB
# beside the tmpfs, so a growing database hits ENOSPC (a clean pg_restore error) before OOM.
(( DRILL_TMPFS_MB + 320 <= DRILL_MEMORY_MB )) || fail "DRILL_MEMORY_MB must be at least DRILL_TMPFS_MB + 320"
DRILL_MIN_HOST_AVAILABLE_MB="${DRILL_MIN_HOST_AVAILABLE_MB:-$(( DRILL_MEMORY_MB + 512 ))}"
[[ "$DRILL_MIN_HOST_AVAILABLE_MB" =~ ^[0-9]+$ ]] || fail "DRILL_MIN_HOST_AVAILABLE_MB must be whole MiB"

[[ -s "$ARTIFACT" ]] || fail "artifact not found or empty: $ARTIFACT"
[[ -s "$BACKUP_KEY_FILE" ]] || fail "key file not found or empty"
command -v gpg >/dev/null || fail "gpg not available"

# Container limits on this host are overcommitted, so the cap alone does not protect the
# running stacks: refuse to start unless the host can give the drill its whole cap and more.
AVAIL_MB="$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null || true)"
[[ -n "$AVAIL_MB" ]] || fail "cannot read MemAvailable from /proc/meminfo"
(( AVAIL_MB >= DRILL_MIN_HOST_AVAILABLE_MB )) \
  || fail "host has ${AVAIL_MB} MiB available, the drill needs ${DRILL_MIN_HOST_AVAILABLE_MB}; refusing to squeeze the running stacks"
log "host memory available: ${AVAIL_MB} MiB (need ${DRILL_MIN_HOST_AVAILABLE_MB})"

if [[ -n "$MANIFEST" ]]; then
  [[ -s "$MANIFEST" ]] || fail "manifest not found: $MANIFEST"
  want="$(manifest_field postgres sha256)"
  got="$(sha256sum "$ARTIFACT" | cut -d' ' -f1)"
  [[ -n "$want" && "$got" == "$want" ]] || fail "artifact checksum does not match the manifest"
  log "artifact checksum matches manifest"
fi

# Decrypt — the exit status is the only trustworthy signal (gpg streams output
# before it validates the MDC), so a failed decrypt discards its output.
DUMP="$WORK/restore.dump"
if ! gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_KEY_FILE" \
         -d -o "$DUMP" "$ARTIFACT" 2>/dev/null; then
  rm -f "$DUMP"
  fail "decryption failed (wrong key or corrupt artifact)"
fi
if [[ -n "$MANIFEST" ]]; then
  [[ "$(sha256sum "$DUMP" | cut -d' ' -f1)" == "$(manifest_field postgres plaintext_sha256)" ]] \
    || fail "decrypted dump does not match the manifest plaintext checksum"
  log "decrypted dump matches manifest"
fi

if docker container inspect "$NAME" >/dev/null 2>&1; then
  fail "a container named ${NAME} already exists; refusing to touch it"
fi
log "starting disposable ${PG_IMAGE} with no network (${NAME}; ${DRILL_MEMORY_MB} MiB, tmpfs ${DRILL_TMPFS_MB} MiB, ${DRILL_CPUS} CPU)"
LAUNCHED=1   # set first: an interrupted `docker run` may still have created the container
docker run -d --rm --name "$NAME" --label "${DRILL_LABEL}=${DRILL_ID}" --network none \
  --memory "${DRILL_MEMORY_MB}m" --memory-swap "${DRILL_MEMORY_MB}m" --cpus "$DRILL_CPUS" \
  --pids-limit 128 --oom-score-adj 500 \
  --tmpfs "${PGDATA_DIR}:rw,nosuid,nodev,noexec,size=${DRILL_TMPFS_MB}m,mode=0700" \
  -e PGDATA="$PGDATA_DIR" -e POSTGRES_USER=drill -e POSTGRES_DB=drill \
  -e POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  "$PG_IMAGE" postgres \
    -c shared_buffers=64MB -c max_wal_size=128MB -c min_wal_size=32MB \
    -c max_parallel_maintenance_workers=0 -c autovacuum=off \
  >/dev/null || fail "could not start the drill container"
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -U drill -d drill >/dev/null 2>&1 && break
  sleep 1
done
# The entrypoint restarts the server once after init; wait for the final instance.
sleep 2
for _ in $(seq 1 30); do
  docker exec "$NAME" pg_isready -U drill -d drill >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$NAME" pg_isready -U drill -d drill >/dev/null 2>&1 || fail "drill database never became ready"

log "restoring"
# In the background so INT/TERM interrupt `wait` at once instead of after pg_restore ends.
docker exec -i "$NAME" pg_restore -U drill -d drill --no-owner --no-privileges --exit-on-error \
  < "$DUMP" 2> "$WORK/restore.err" &
if ! wait $!; then
  fail "pg_restore failed: $(head -c 400 "$WORK/restore.err")"
fi

q() { docker exec "$NAME" psql -U drill -d drill -tAc "$1"; }
TABLES="$(q "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")"
MIGRATIONS="$(q "select count(*) from _prisma_migrations where finished_at is not null and rolled_back_at is null")"
echo "DRILL_TABLES=${TABLES}"
echo "DRILL_MIGRATIONS_APPLIED=${MIGRATIONS}"
for t in Admin User Product Order Payment Shipment OrderInvoiceToken RefreshToken; do
  n="$(q "select count(*) from \"$t\"" 2>/dev/null || echo n/a)"
  echo "DRILL_ROWS_${t}=${n}"
done
# Watch this against DRILL_TMPFS_MB as the database grows.
echo "DRILL_DATA_MB=$(docker exec "$NAME" du -sm "$PGDATA_DIR" 2>/dev/null | cut -f1 || echo n/a)"
# Optional operator check, e.g. DRILL_EXTRA_SQL='select max("createdAt") from "Order"'
if [[ -n "${DRILL_EXTRA_SQL:-}" ]]; then
  echo "DRILL_EXTRA=$(q "$DRILL_EXTRA_SQL")"
fi
(( TABLES > 0 )) || fail "restore produced no tables"
(( MIGRATIONS > 0 )) || fail "restored database has no applied migrations"
log "restore drill OK (tables=${TABLES}, migrations=${MIGRATIONS}); disposable container and its tmpfs removed on exit"
