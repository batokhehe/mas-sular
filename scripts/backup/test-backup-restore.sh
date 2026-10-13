#!/usr/bin/env bash
#
# Mas Sular — end-to-end test of backup.sh + restore-drill.sh (production-readiness H1).
#
# Everything runs against THROWAWAY resources created here and removed on exit,
# all named massular-backuptest-<pid>: a PostgreSQL 16 container migrated with the
# repository's real migrations, an uploads volume, a temp backup dir and a temp key.
# It never touches the application's containers, volumes or any shared service.
#
# Usage (repo root):  ./scripts/backup/test-backup-restore.sh
# Needs: docker, gpg, the migrator image (MIGRATOR_IMAGE, default below).
#
set -Eeuo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MIGRATOR_IMAGE="${MIGRATOR_IMAGE:-mas-sular-dev-backend-migrate:latest}"
P="massular-backuptest-$$"
NET="$P-net"; SRC="$P-src"; VOL="$P-uploads"; VOL2="$P-uploads-restored"
TMP="$(mktemp -d)"; BDIR="$TMP/backups"; KDIR="$TMP/keys"; KEY="$KDIR/backup.key"
PASS=0; FAILS=0

export MSYS_NO_PATHCONV=1
hostpath() { (cd "$1" && pwd -W 2>/dev/null || pwd); }

ok()   { PASS=$((PASS + 1)); echo "  PASS  $*"; }
bad()  { FAILS=$((FAILS + 1)); echo "  FAIL  $*"; }
check() { local label="$1"; shift; if "$@"; then ok "$label"; else bad "$label"; fi; }

cleanup() {
  docker rm -f "$SRC" >/dev/null 2>&1 || true
  docker volume rm "$VOL" "$VOL2" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== setup (throwaway: $P)"
mkdir -p "$BDIR" "$KDIR"
head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$KEY"
docker network create "$NET" >/dev/null
docker run -d --name "$SRC" --network "$NET" \
  -e POSTGRES_USER=app -e POSTGRES_DB=app -e POSTGRES_PASSWORD=backuptest-only \
  --health-cmd 'pg_isready -U app -d app' --health-interval 2s --health-retries 30 \
  postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do [[ "$(docker inspect "$SRC" --format '{{.State.Health.Status}}')" == healthy ]] && break; sleep 1; done
docker run --rm --network "$NET" -e DATABASE_URL="postgresql://app:backuptest-only@$SRC:5432/app?schema=public" \
  -v "$(hostpath "$REPO/backend/prisma"):/app/prisma:ro" "$MIGRATOR_IMAGE" \
  node node_modules/prisma/build/index.js migrate deploy >/dev/null
MIGRATIONS="$(ls -d "$REPO"/backend/prisma/migrations/*/ | wc -l)"
docker exec -i "$SRC" psql -q -U app -d app -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "User"(id, email, name, "isOnboarded", "updatedAt") VALUES
  ('00000000-0000-4000-8000-000000000001', 'a@example.invalid', 'Pelanggan Ñandú 漢字 🍜', true, now()),
  ('00000000-0000-4000-8000-000000000002', 'b@example.invalid', 'Second Customer', false, now());
INSERT INTO "Role"(id, name, "updatedAt") VALUES ('00000000-0000-4000-8000-00000000000a', 'SUPER_ADMIN', now());
SQL
FINGERPRINT_SQL='select md5(string_agg(id || email || name, $$,$$ order by id)) from "User"'
SRC_FP="$(docker exec "$SRC" psql -U app -d app -tAc "$FINGERPRINT_SQL")"
docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL:/v" alpine sh -c 'mkdir -p /v/receipts && echo receipt-1 > /v/1700000000000-aa.jpg && head -c 65536 /dev/urandom > /v/receipts/binary.webp && chown -R 1000:1000 /v'
SRC_FILES="$(docker run --rm -v "$VOL:/v:ro" alpine sh -c 'cd /v && find . -type f -exec sha256sum {} + | sort')"

run_backup() { BACKUP_DIR="$BDIR" BACKUP_KEY_FILE="$KEY" POSTGRES_CONTAINER="$SRC" UPLOADS_VOLUME="$VOL" "$HERE/backup.sh" "$@"; }

echo "== 1. backup"
if BACKUP_LABEL=pre-migrate run_backup > "$TMP/backup.log" 2>&1; then ok "backup.sh exits 0"; else bad "backup.sh exits 0"; cat "$TMP/backup.log"; fi
DUMP_ENC="$(ls "$BDIR"/mas-sular-postgres-*.dump.enc 2>/dev/null | head -1)"
TAR_ENC="$(ls "$BDIR"/mas-sular-uploads-*.tar.gz.enc 2>/dev/null | head -1)"
MANIFEST="$(ls "$BDIR"/manifest-*.json 2>/dev/null | head -1)"
check "timestamped postgres artifact (pg_dump -Fc, encrypted)" test -s "$DUMP_ENC"
check "timestamped uploads artifact (encrypted)" test -s "$TAR_ENC"
check "manifest written" test -s "$MANIFEST"
check "manifest records the run label" grep -q '"label": "pre-migrate"' "$MANIFEST"
check "manifest does not claim point-in-time recovery" grep -q '"point_in_time_recovery": false' "$MANIFEST"
check "manifest says custom format" grep -q '"format": "pg_dump custom (-Fc)"' "$MANIFEST"
check "no plaintext left in BACKUP_DIR" test -z "$(find "$BDIR" -maxdepth 1 -type f \( -name '*.dump' -o -name '*.tar.gz' \))"
check "no work dir or lock left behind" test -z "$(find "$BDIR" -maxdepth 1 -name '.work-*' -o -maxdepth 1 -name '.backup.lock')"
check "encrypted dump is not a readable PGDMP archive" bash -c "! head -c 5 '$DUMP_ENC' | grep -q PGDMP"
check "backup log never prints the password" bash -c "! grep -q backuptest-only '$TMP/backup.log'"

echo "== 2. restore drill (disposable, no network)"
if DRILL_EXTRA_SQL="$FINGERPRINT_SQL" BACKUP_KEY_FILE="$KEY" "$HERE/restore-drill.sh" "$DUMP_ENC" "$MANIFEST" > "$TMP/drill.log" 2>&1; then ok "restore-drill.sh exits 0"; else bad "restore-drill.sh exits 0"; cat "$TMP/drill.log"; fi
check "all ${MIGRATIONS} migrations restored" grep -q "^DRILL_MIGRATIONS_APPLIED=${MIGRATIONS}$" "$TMP/drill.log"
check "User rows restored (2)" grep -q '^DRILL_ROWS_User=2$' "$TMP/drill.log"
check "restored data identical (unicode fingerprint)" grep -q "^DRILL_EXTRA=${SRC_FP}$" "$TMP/drill.log"
check "drill container removed" test -z "$(docker ps -aq --filter name=massular-restore-drill-)"

echo "== 3. uploads restore into a fresh volume"
docker volume create "$VOL2" >/dev/null
gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$KEY" -d -o "$TMP/uploads.tar.gz" "$TAR_ENC"
docker run --rm -v "$VOL2:/dst" -v "$(hostpath "$TMP"):/in:ro" alpine sh -c 'tar xzf /in/uploads.tar.gz -C /dst --numeric-owner'
RESTORED_FILES="$(docker run --rm -v "$VOL2:/v:ro" alpine sh -c 'cd /v && find . -type f -exec sha256sum {} + | sort')"
check "every upload restored byte-identical" test "$SRC_FILES" == "$RESTORED_FILES"
check "ownership preserved (uid 1000)" test "$(docker run --rm -v "$VOL2:/v:ro" alpine stat -c %u /v/receipts/binary.webp)" == 1000

echo "== 4. failures are loud and promote nothing"
BEFORE="$(ls "$BDIR" | sort)"
check "wrong key: drill refuses" bash -c "! BACKUP_KEY_FILE='$TMP/backup.log' '$HERE/restore-drill.sh' '$DUMP_ENC' >/dev/null 2>&1"
cp "$DUMP_ENC" "$TMP/tampered.dump.enc"; printf 'X' | dd of="$TMP/tampered.dump.enc" bs=1 seek=200 conv=notrunc 2>/dev/null
check "tampered artifact: drill refuses (manifest checksum)" bash -c "! BACKUP_KEY_FILE='$KEY' '$HERE/restore-drill.sh' '$TMP/tampered.dump.enc' '$MANIFEST' >/dev/null 2>&1"
check "invalid label: backup refuses" bash -c "! BACKUP_LABEL='Bad Label' BACKUP_DIR='$BDIR' BACKUP_KEY_FILE='$KEY' POSTGRES_CONTAINER='$SRC' UPLOADS_VOLUME='$VOL' '$HERE/backup.sh' >/dev/null 2>&1"
docker stop "$SRC" >/dev/null
if run_backup > "$TMP/fail.log" 2>&1; then bad "stopped database: backup must fail"; else ok "stopped database: backup exits non-zero"; fi
check "failure reported explicitly" grep -q 'refusing to back up' "$TMP/fail.log"
check "failed run promoted nothing" test "$BEFORE" == "$(ls "$BDIR" | sort)"
docker start "$SRC" >/dev/null
for _ in $(seq 1 60); do [[ "$(docker inspect "$SRC" --format '{{.State.Health.Status}}')" == healthy ]] && break; sleep 1; done

echo "== 5. retention keeps the newest N"
sleep 1; run_backup >/dev/null 2>&1; sleep 1; run_backup >/dev/null 2>&1
KEEP_POSTGRES=2 KEEP_UPLOADS=2 BACKUP_DIR="$BDIR" BACKUP_KEY_FILE="$KEY" "$HERE/backup.sh" --dry-run-retention > "$TMP/dry.log" 2>&1
check "dry run deletes nothing" test "$(ls "$BDIR"/mas-sular-postgres-*.dump.enc | wc -l)" -eq 3
check "dry run names what it would delete" grep -q 'would delete mas-sular-postgres-' "$TMP/dry.log"
sleep 1
KEEP_POSTGRES=2 KEEP_UPLOADS=2 run_backup >/dev/null 2>&1
check "retention leaves exactly 2 postgres artifacts" test "$(ls "$BDIR"/mas-sular-postgres-*.dump.enc | wc -l)" -eq 2
check "retention leaves exactly 2 uploads artifacts" test "$(ls "$BDIR"/mas-sular-uploads-*.tar.gz.enc | wc -l)" -eq 2

echo "== result: ${PASS} passed, ${FAILS} failed"
(( FAILS == 0 ))
