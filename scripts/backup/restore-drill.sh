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
# Usage:
#   BACKUP_KEY_FILE=/etc/mas-sular/backup.key \
#     ./scripts/backup/restore-drill.sh /srv/backups/mas-sular/mas-sular-postgres-<TS>.dump.enc \
#                                      /srv/backups/mas-sular/manifest-<TS>.json
#
# The manifest is optional but recommended: when given, the artifact AND the
# decrypted dump must match its checksums before anything is restored.
# Prints DRILL_* summary lines; exits non-zero on any failure.
#
set -Eeuo pipefail

ARTIFACT="${1:?usage: restore-drill.sh <postgres .dump.enc> [manifest.json]}"
MANIFEST="${2:-}"
BACKUP_KEY_FILE="${BACKUP_KEY_FILE:?BACKUP_KEY_FILE must be set}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"   # same major version as production

NAME="massular-restore-drill-$(date -u +%Y%m%d%H%M%S)-$$"
WORK="$(mktemp -d)"
STARTED=0

log()  { printf '[drill %s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { printf '[drill %s] ERROR: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 1; }

cleanup() {
  local rc=$?
  rm -rf "$WORK"                                           # decrypted dump never survives
  (( STARTED )) && docker rm -f "$NAME" >/dev/null 2>&1 || true
  (( rc != 0 )) && log "restore drill FAILED (exit $rc)" || true
  exit $rc
}
trap cleanup EXIT INT TERM

manifest_field() { # manifest_field <section> <key>  -> value (flat JSON written by backup.sh)
  awk -v s="\"$1\"" -v k="\"$2\"" '
    index($0, s) { inside = 1 }
    inside && index($0, k) { sub(/.*: *"?/, ""); sub(/"?,? *$/, ""); print; exit }
  ' "$MANIFEST"
}

[[ -s "$ARTIFACT" ]] || fail "artifact not found or empty: $ARTIFACT"
[[ -s "$BACKUP_KEY_FILE" ]] || fail "key file not found or empty"
command -v gpg >/dev/null || fail "gpg not available"

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

log "starting disposable ${PG_IMAGE} with no network (${NAME})"
docker run -d --name "$NAME" --network none \
  -e POSTGRES_USER=drill -e POSTGRES_DB=drill \
  -e POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')" \
  "$PG_IMAGE" >/dev/null || fail "could not start the drill container"
STARTED=1
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
if ! docker exec -i "$NAME" pg_restore -U drill -d drill --no-owner --no-privileges --exit-on-error < "$DUMP" 2> "$WORK/restore.err"; then
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
# Optional operator check, e.g. DRILL_EXTRA_SQL='select max("createdAt") from "Order"'
if [[ -n "${DRILL_EXTRA_SQL:-}" ]]; then
  echo "DRILL_EXTRA=$(q "$DRILL_EXTRA_SQL")"
fi
(( TABLES > 0 )) || fail "restore produced no tables"
(( MIGRATIONS > 0 )) || fail "restored database has no applied migrations"
log "restore drill OK (tables=${TABLES}, migrations=${MIGRATIONS}); disposable container removed on exit"
