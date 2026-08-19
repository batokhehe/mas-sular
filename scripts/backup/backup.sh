#!/usr/bin/env bash
#
# Mas Sular — encrypted backup of MySQL + the uploads volume.
#
# Pipeline per run:
#   dump/archive -> compress -> encrypt -> checksum -> VERIFY BY DECRYPTING
#   -> manifest -> atomic promotion -> retention
#
# Nothing is promoted into the backup directory until it has been decrypted
# again and matched byte-for-byte against the source checksum. A half-written
# or unverifiable artifact must never be mistaken for a usable backup.
#
# Usage:
#   BACKUP_DIR=/srv/backups BACKUP_KEY_FILE=/etc/mas-sular/backup.key ./backup.sh
#   ./backup.sh --dry-run-retention     # show what retention WOULD delete
#
set -Eeuo pipefail

# ----------------------------------------------------------------- config ---
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.production.yml}"
ENV_FILE="${ENV_FILE:-production.env}"
MYSQL_SERVICE="${MYSQL_SERVICE:-mysql}"
MYSQL_DATABASE="${MYSQL_DATABASE:-mas_sular}"
UPLOADS_VOLUME="${UPLOADS_VOLUME:-mas-sular_uploads_data}"

BACKUP_DIR="${BACKUP_DIR:?BACKUP_DIR must be set (must live OUTSIDE any git repo)}"
BACKUP_KEY_FILE="${BACKUP_KEY_FILE:?BACKUP_KEY_FILE must be set (must live OUTSIDE BACKUP_DIR)}"

# Retention — values come from the Phase 5J.13 Step 2 strategy.
KEEP_MYSQL="${KEEP_MYSQL:-24}"      # hourly cadence -> 24h of point-in-time recovery
KEEP_UPLOADS="${KEEP_UPLOADS:-7}"   # daily cadence  -> 7 days

DRY_RUN_RETENTION=0
[[ "${1:-}" == "--dry-run-retention" ]] && DRY_RUN_RETENTION=1

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

  MYSQL_CID="$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q "$MYSQL_SERVICE" 2>/dev/null || true)"
  [[ -n "$MYSQL_CID" ]] || fail "mysql container not found"
  local health
  health="$(docker inspect "$MYSQL_CID" --format '{{.State.Health.Status}}' 2>/dev/null || echo unknown)"
  [[ "$health" == "healthy" ]] || fail "mysql container is '$health', refusing to back up"

  docker volume inspect "$UPLOADS_VOLUME" >/dev/null 2>&1 || fail "uploads volume not found: $UPLOADS_VOLUME"
  log "preflight ok (mysql=$health, volume=$UPLOADS_VOLUME)"
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

# ------------------------------------------------------------ mysql backup --
backup_mysql() {
  local plain="${WORK_DIR}/mas-sular-mysql-${TS}.sql.gz"
  log "dumping mysql (${MYSQL_DATABASE})"

  # MYSQL_PWD keeps the password out of argv/process listings.
  # --single-transaction gives a consistent InnoDB snapshot without blocking writers.
  if ! docker exec "$MYSQL_CID" sh -c '
        MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqldump -u root \
          --single-transaction --routines --triggers --events \
          --set-gtid-purged=OFF --default-character-set=utf8mb4 \
          --hex-blob --no-tablespaces '"$MYSQL_DATABASE"'
      ' 2>/dev/null | gzip -9 > "$plain"; then
    fail "mysqldump failed"
  fi
  [[ -s "$plain" ]] || fail "mysql dump is empty"
  gzip -t "$plain" || fail "mysql dump failed gzip integrity"

  MYSQL_PLAIN_SHA="$(sha256sum "$plain" | cut -d' ' -f1)"
  encrypt_and_verify "$plain" "${plain}.enc" "$MYSQL_PLAIN_SHA"
  MYSQL_ARTIFACT="$(basename "${plain}.enc")"
  MYSQL_ENC_SHA="$(sha256sum "${plain}.enc" | cut -d' ' -f1)"
  MYSQL_ENC_SIZE="$(stat -c%s "${plain}.enc")"
  rm -f "$plain"                          # plaintext is temporary, always
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
  "database": "${MYSQL_DATABASE}",
  "mysql": {
    "artifact": "${MYSQL_ARTIFACT}",
    "sha256": "${MYSQL_ENC_SHA}",
    "size": ${MYSQL_ENC_SIZE},
    "plaintext_sha256": "${MYSQL_PLAIN_SHA}"
  },
  "uploads": {
    "artifact": "${UPLOADS_ARTIFACT}",
    "sha256": "${UPLOADS_ENC_SHA}",
    "size": ${UPLOADS_ENC_SIZE},
    "plaintext_sha256": "${UPLOADS_PLAIN_SHA}"
  },
  "encryption": {
    "tool": "gpg",
    "algorithm": "AES-256",
    "integrity": "OpenPGP MDC (verified by decrypt round-trip)"
  },
  "verification": "decrypt + sha256 match performed before promotion"
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
  local prefix="$1" keep="$2" mode="$3" ext="$4"
  local -a files=()
  # -name globs, not -regex: find's DEFAULT regex dialect is emacs, where
  # "[0-9]\{8\}" silently matches nothing — retention would then quietly never
  # delete anything and disk growth would be unbounded while appearing healthy.
  # This glob is still tightly scoped (project prefix + exact extension chain +
  # maxdepth 1 inside BACKUP_DIR), so no unrelated .gz/.enc file can match.
  while IFS= read -r f; do [[ -n "$f" ]] && files+=("$f"); done < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f \
         -name "mas-sular-${prefix}-*.${ext}.gz.enc" \
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
    retention "mysql"   "$KEEP_MYSQL"   1 "sql"
    retention "uploads" "$KEEP_UPLOADS" 1 "tar"
    return 0
  fi

  preflight
  backup_mysql
  backup_uploads
  write_manifest
  promote

  log "applying retention"
  retention "mysql"   "$KEEP_MYSQL"   0 "sql"
  retention "uploads" "$KEEP_UPLOADS" 0 "tar"

  log "backup OK  mysql=${MYSQL_ARTIFACT} uploads=${UPLOADS_ARTIFACT}"
}

main "$@"
