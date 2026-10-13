#!/usr/bin/env bash
#
# Mas Sular — encrypted backup of PostgreSQL + the uploads volume.
#
# Pipeline per run:
#   pg_dump -Fc / tar -> integrity check -> encrypt -> checksum
#   -> VERIFY BY DECRYPTING -> manifest -> atomic promotion -> retention
#
# Nothing is promoted into the backup directory until it has been decrypted
# again and matched byte-for-byte against the source checksum. A half-written
# or unverifiable artifact must never be mistaken for a usable backup. Any
# failure exits non-zero and promotes nothing.
#
# This is a LOGICAL snapshot taken at the moment of the run. There is no
# point-in-time recovery (no WAL archiving): a restore returns the data as it
# was at the chosen backup, and loses every write made after it.
#
# Usage (on the VPS, from the repository root):
#   BACKUP_DIR=/srv/backups/mas-sular BACKUP_KEY_FILE=/etc/mas-sular/backup.key \
#     ./scripts/backup/backup.sh
#   BACKUP_LABEL=pre-migrate ./scripts/backup/backup.sh   # tag a one-off run
#   ./scripts/backup/backup.sh --dry-run-retention        # show what retention WOULD delete
#
set -Eeuo pipefail

# ----------------------------------------------------------------- config ---
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-production.env}"
POSTGRES_SERVICE="${POSTGRES_SERVICE:-postgres}"
# Direct container name/id; bypasses compose resolution (restore drills, tests).
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-mas-sular_uploads_data}"
BACKUP_LABEL="${BACKUP_LABEL:-scheduled}"

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR must be set (must live OUTSIDE any git repo)}"
BACKUP_KEY_FILE="${BACKUP_KEY_FILE:?BACKUP_KEY_FILE must be set (must live OUTSIDE BACKUP_DIR)}"

# Retention: newest N artifacts of each kind (scheduled daily runs AND the
# pre-migration runs count alike). 14 daily = two weeks of restore points.
KEEP_POSTGRES="${KEEP_POSTGRES:-14}"
KEEP_UPLOADS="${KEEP_UPLOADS:-14}"

DRY_RUN_RETENTION=0
[[ "${1:-}" == "--dry-run-retention" ]] && DRY_RUN_RETENTION=1

[[ "$BACKUP_LABEL" =~ ^[a-z0-9-]{1,32}$ ]] || { echo "ERROR: BACKUP_LABEL must match [a-z0-9-]{1,32}" >&2; exit 1; }

TS="$(date -u +%Y%m%d-%H%M%SZ)"
LOCK_DIR="${BACKUP_DIR}/.backup.lock"
WORK_DIR=""

log()  { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*"; }
fail() { printf '[%s] ERROR: %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; exit 1; }

# Docker on Git Bash mangles POSIX paths in -v; harmless on Linux.
dockerv() { MSYS_NO_PATHCONV=1 docker "$@"; }

# --------------------------------------------------------------- cleanup ----
# Runs on EVERY exit path. Temporary plaintext must never survive a crash.
cleanup() {
  local rc=$?
  [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]] && rm -rf "$WORK_DIR"
  # rm -rf, NOT rmdir: the lock directory holds a pid file, so rmdir fails with
  # "directory not empty" and the lock leaks — which then makes every later run
  # abort with a misleading "already running". Only release a lock we own.
  if [[ -d "$LOCK_DIR" && -f "$LOCK_DIR/pid" ]] && [[ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" == "$$" ]]; then
    rm -rf "$LOCK_DIR"
  fi
  (( rc != 0 )) && log "backup FAILED (exit $rc) — no artifact promoted" || true
  exit $rc
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------------ lock ----
# mkdir is atomic on every POSIX filesystem, and unlike flock it is available
# on hosts that ship no util-linux (verified absent on the dev host).
acquire_lock() {
  mkdir -p "$BACKUP_DIR"
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    fail "another backup is already running (lock: $LOCK_DIR)"
  fi
  echo "$$" > "$LOCK_DIR/pid"
}

# --------------------------------------------------------------- preflight --
preflight() {
  command -v docker >/dev/null || fail "docker not available"
  docker info >/dev/null 2>&1  || fail "docker daemon unreachable"
  command -v gpg >/dev/null    || fail "gpg not available"

  [[ -f "$BACKUP_KEY_FILE" ]] || fail "key file not found: $BACKUP_KEY_FILE"
  [[ -s "$BACKUP_KEY_FILE" ]] || fail "key file is empty"

  # The key must never sit in the directory it protects.
  case "$(cd "$(dirname "$BACKUP_KEY_FILE")" && pwd)" in
    "$(cd "$BACKUP_DIR" 2>/dev/null && pwd)"*) fail "key file must NOT live inside BACKUP_DIR" ;;
  esac

  if [[ -n "$POSTGRES_CONTAINER" ]]; then
    PG_CID="$POSTGRES_CONTAINER"
  else
    PG_CID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q "$POSTGRES_SERVICE" 2>/dev/null || true)"
  fi
  [[ -n "$PG_CID" ]] || fail "postgres container not found (service '$POSTGRES_SERVICE')"
  local health
  health="$(docker inspect "$PG_CID" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null || echo unknown)"
  [[ "$health" == "healthy" ]] || fail "postgres container is '$health', refusing to back up"

  # The database name comes from the container's own environment - nothing is
  # read from production.env on the host and nothing is passed on a command line.
  PG_DATABASE="$(docker exec "$PG_CID" sh -c 'printf %s "$POSTGRES_DB"')"
  [[ -n "$PG_DATABASE" ]] || fail "POSTGRES_DB is not set inside the postgres container"

  docker volume inspect "$UPLOADS_VOLUME" >/dev/null 2>&1 || fail "uploads volume not found: $UPLOADS_VOLUME"
  log "preflight ok (postgres=$health db=$PG_DATABASE volume=$UPLOADS_VOLUME label=$BACKUP_LABEL)"
}

# ------------------------------------------------------- encrypt + verify ---
# Encrypt, then prove the artifact is recoverable by decrypting it back and
# comparing checksums. An artifact that cannot be decrypted is not a backup.
#
# F7 (Phase 5J.13 Step 5): gpg STREAMS plaintext to its output file and only
# validates the MDC at the end, so bytes exist on disk even for a corrupt
# artifact. The exit status is the only trustworthy signal — we decrypt to a
# throwaway path, check the status, and delete the output on any failure.
encrypt_and_verify() {
  local plain="$1" enc="$2" expected_sha="$3"

  gpg --batch --yes --quiet --pinentry-mode loopback \
      --passphrase-file "$BACKUP_KEY_FILE" \
      --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 \
      --s2k-count 65011712 --compress-algo none \
      -o "$enc" "$plain" 2>/dev/null \
      || fail "encryption failed for $(basename "$plain")"

  [[ -s "$enc" ]] || fail "encrypted artifact is empty: $(basename "$enc")"

  local probe="${WORK_DIR}/verify.$$"
  if ! gpg --batch --yes --quiet --pinentry-mode loopback \
           --passphrase-file "$BACKUP_KEY_FILE" \
           -d -o "$probe" "$enc" 2>/dev/null; then
    rm -f "$probe"                      # discard partial plaintext (F7)
    fail "decrypt verification failed for $(basename "$enc")"
  fi

  local got; got="$(sha256sum "$probe" | cut -d' ' -f1)"
  rm -f "$probe"
  [[ "$got" == "$expected_sha" ]] || fail "checksum mismatch after decrypt for $(basename "$enc")"
  log "  verified $(basename "$enc") (decrypt + checksum ok)"
}

# --------------------------------------------------------- postgres backup --
backup_postgres() {
  local plain="${WORK_DIR}/mas-sular-postgres-${TS}.dump"
  local err="${WORK_DIR}/pg_dump.err"
  log "dumping postgres (${PG_DATABASE}, custom format)"

  # Runs INSIDE the postgres container over its local socket as the cluster's own
  # user, so no password is read, typed, passed in argv or written to history.
  # -Fc: compressed custom archive, restorable selectively with pg_restore; it is
  # a consistent snapshot (one repeatable-read transaction) that does not block
  # the application's writes.
  if ! docker exec "$PG_CID" sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
        > "$plain" 2> "$err"; then
    fail "pg_dump failed: $(head -c 400 "$err" 2>/dev/null)"
  fi
  [[ -s "$plain" ]] || fail "postgres dump is empty"

  # Integrity: the archive must be readable by pg_restore (same major version,
  # from the same container), and it must actually contain the schema.
  local toc="${WORK_DIR}/pg_restore.toc"
  if ! docker exec -i "$PG_CID" pg_restore --list < "$plain" > "$toc" 2> "$err"; then
    fail "pg_restore could not read the dump: $(head -c 400 "$err" 2>/dev/null)"
  fi
  PG_TABLES="$(grep -c ' TABLE DATA ' "$toc" || true)"
  grep -q ' TABLE DATA public _prisma_migrations ' "$toc" || fail "dump has no _prisma_migrations table data - not an application database"
  (( PG_TABLES > 0 )) || fail "dump contains no table data"
  log "  archive readable by pg_restore (${PG_TABLES} tables with data)"

  PG_PLAIN_SHA="$(sha256sum "$plain" | cut -d' ' -f1)"
  encrypt_and_verify "$plain" "${plain}.enc" "$PG_PLAIN_SHA"
  PG_ARTIFACT="$(basename "${plain}.enc")"
  PG_ENC_SHA="$(sha256sum "${plain}.enc" | cut -d' ' -f1)"
  PG_ENC_SIZE="$(stat -c%s "${plain}.enc")"
  rm -f "$plain" "$toc" "$err"             # plaintext is temporary, always
}

# ---------------------------------------------------------- uploads backup --
backup_uploads() {
  local plain="mas-sular-uploads-${TS}.tar.gz"
  log "archiving uploads volume (read-only mount)"

  # :ro — the source volume is physically unmodifiable during backup.
  # --numeric-owner — uid/gid survive restore into any image (app runs as 1000).
  dockerv run --rm \
    -v "${UPLOADS_VOLUME}:/src:ro" \
    -v "$(cd "$WORK_DIR" && pwd -W 2>/dev/null || pwd):/out" \
    alpine sh -c "tar czf /out/${plain} -C /src --numeric-owner ." \
    || fail "uploads archive failed"

  local p="${WORK_DIR}/${plain}"
  [[ -s "$p" ]] || fail "uploads archive is empty"
  gzip -t "$p" || fail "uploads archive failed gzip integrity"
  tar tzf "$p" >/dev/null 2>&1 || fail "uploads archive failed tar integrity"
  UPLOADS_FILES="$(tar tzf "$p" | grep -vc '/$' || true)"

  UPLOADS_PLAIN_SHA="$(sha256sum "$p" | cut -d' ' -f1)"
  encrypt_and_verify "$p" "${p}.enc" "$UPLOADS_PLAIN_SHA"
  UPLOADS_ARTIFACT="$(basename "${p}.enc")"
  UPLOADS_ENC_SHA="$(sha256sum "${p}.enc" | cut -d' ' -f1)"
  UPLOADS_ENC_SIZE="$(stat -c%s "${p}.enc")"
  rm -f "$p"
}

# ---------------------------------------------------------------- manifest --
# Safe metadata only: no passwords, keys, DATABASE_URL, PII or SQL content.
write_manifest() {
  cat > "${WORK_DIR}/manifest-${TS}.json" <<JSON
{
  "timestamp": "${TS}",
  "label": "${BACKUP_LABEL}",
  "database": "${PG_DATABASE}",
  "postgres": {
    "artifact": "${PG_ARTIFACT}",
    "format": "pg_dump custom (-Fc)",
    "tables_with_data": ${PG_TABLES},
    "sha256": "${PG_ENC_SHA}",
    "size": ${PG_ENC_SIZE},
    "plaintext_sha256": "${PG_PLAIN_SHA}"
  },
  "uploads": {
    "artifact": "${UPLOADS_ARTIFACT}",
    "files": ${UPLOADS_FILES},
    "sha256": "${UPLOADS_ENC_SHA}",
    "size": ${UPLOADS_ENC_SIZE},
    "plaintext_sha256": "${UPLOADS_PLAIN_SHA}"
  },
  "encryption": {
    "tool": "gpg",
    "algorithm": "AES-256",
    "integrity": "OpenPGP MDC (verified by decrypt round-trip)"
  },
  "verification": "pg_restore --list + decrypt + sha256 match performed before promotion",
  "point_in_time_recovery": false
}
JSON
}

# --------------------------------------------------------------- promotion --
# Atomic: everything is built in WORK_DIR (same filesystem as BACKUP_DIR) and
# mv'd only after every verification passed, so an interrupted run can never
# leave something that looks like a valid backup.
promote() {
  local f
  for f in "${WORK_DIR}"/*.enc "${WORK_DIR}"/manifest-*.json; do
    mv "$f" "${BACKUP_DIR}/$(basename "$f")" || fail "promotion failed for $(basename "$f")"
  done
  log "promoted artifacts into ${BACKUP_DIR}"
}

# --------------------------------------------------------------- retention --
# Deletes ONLY files matching this project's naming convention, only inside
# BACKUP_DIR, never the newest, and never the last remaining copy.
retention() {
  local prefix="$1" keep="$2" mode="$3" suffix="$4"
  local -a files=()
  # -name globs, not -regex: find's DEFAULT regex dialect is emacs, where
  # "[0-9]\{8\}" silently matches nothing — retention would then quietly never
  # delete anything and disk growth would be unbounded while appearing healthy.
  # This glob is still tightly scoped (project prefix + exact extension chain +
  # maxdepth 1 inside BACKUP_DIR), so no unrelated file can match.
  while IFS= read -r f; do [[ -n "$f" ]] && files+=("$f"); done < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f \
         -name "mas-sular-${prefix}-*.${suffix}" \
         -printf '%T@ %p\n' 2>/dev/null | sort -rn | cut -d' ' -f2-
  )

  local total=${#files[@]}
  log "  ${prefix}: ${total} artifact(s), keep ${keep}"
  (( total <= keep )) && { log "  ${prefix}: nothing to delete"; return 0; }

  local i
  for (( i = keep; i < total; i++ )); do
    (( i == 0 )) && continue                       # never the newest
    (( total <= 1 )) && continue                   # never the last remaining
    if (( mode == 1 )); then
      log "  [dry-run] would delete $(basename "${files[$i]}")"
    else
      rm -f "${files[$i]}" && log "  deleted $(basename "${files[$i]}")"
    fi
  done
}

# -------------------------------------------------------------------- main --
main() {
  acquire_lock
  WORK_DIR="$(mktemp -d "${BACKUP_DIR}/.work-${TS}.XXXXXX")"

  if (( DRY_RUN_RETENTION )); then
    log "RETENTION DRY RUN — no backup taken, nothing deleted"
    retention "postgres" "$KEEP_POSTGRES" 1 "dump.enc"
    retention "uploads"  "$KEEP_UPLOADS"  1 "tar.gz.enc"
    return 0
  fi

  preflight
  backup_postgres
  backup_uploads
  write_manifest
  promote

  log "applying retention"
  retention "postgres" "$KEEP_POSTGRES" 0 "dump.enc"
  retention "uploads"  "$KEEP_UPLOADS"  0 "tar.gz.enc"

  log "backup OK  postgres=${PG_ARTIFACT} uploads=${UPLOADS_ARTIFACT}"
}

main "$@"
