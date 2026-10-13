#!/usr/bin/env bash
# Mas Sular PRODUCTION deploy: build THIS checkout's HEAD, back up, migrate, roll out.
#
#   deploy/prd/deploy.sh              build + pre-migrate backup + migrate + roll out
#   deploy/prd/deploy.sh --rollback   back to the previous image tag (no build, no migrate)
#
# Every compose call goes through ./dc (project mas-sular-prd): staging is never
# built, restarted or recreated by this script.
#
# Shared 1 vCPU host: images are built ONE AT A TIME (a Next.js build peaks at
# ~1-1.5 GiB) and the script refuses to build when the host is short on memory.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export PRD_CONF_DIR="${PRD_CONF_DIR:-/etc/mas-sular-prd}"
COMPOSE_ENV="$PRD_CONF_DIR/compose.env"
APP_ENV="$PRD_CONF_DIR/app.env"
RELEASE_ENV="$PRD_CONF_DIR/release.env"
STAGING_ENV="${STAGING_ENV_FILE:-/home/massular/apps/mas-sular/production.env}"
BACKUP_DIR="${BACKUP_DIR:-/srv/backups/mas-sular-prd}"
BACKUP_KEY_FILE="${BACKUP_KEY_FILE:-$PRD_CONF_DIR/backup.key}"
KEEP_IMAGES="${KEEP_IMAGES:-3}"
MIN_FREE_MB_FOR_BUILD="${MIN_FREE_MB_FOR_BUILD:-1200}"
DC="$HERE/dc"
IMAGES=(backend-migrate backend frontend admin)

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
fail() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

# Value of KEY in an env file: last assignment wins, inline " # comment" dropped.
val() {
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n1 | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'
}

# ------------------------------------------------------------- preflight ----
preflight() {
  log "preflight"
  local f
  for f in "$COMPOSE_ENV" "$APP_ENV"; do
    [[ -r "$f" ]] || fail "$f not found/readable (see deploy/prd/README.md)"
    [[ "$(stat -c %a "$f")" == 600 ]] || fail "$f must be chmod 600"
  done

  # compose.env: filled in, and every password URL-safe (it is embedded in URLs).
  grep -q 'CHANGE_ME' "$COMPOSE_ENV" && fail "compose.env still contains CHANGE_ME"
  local k v
  for k in POSTGRES_PASSWORD APP_DB_OWNER_PASSWORD APP_DB_APP_PASSWORD REDIS_PASSWORD RABBITMQ_PASSWORD; do
    v="$(val "$COMPOSE_ENV" "$k")"
    [[ "$v" =~ ^[A-Za-z0-9]{32,}$ ]] || fail "compose.env $k must be >= 32 alphanumeric chars (openssl rand -hex 32)"
  done

  # app.env: fail before a 20-minute build, not at boot.
  if grep -vE '^[[:space:]]*(#|$)' "$APP_ENV" | grep -nE 'CHANGE_ME|<[A-Z_]+>'; then
    fail "app.env still contains placeholders (lines above)"
  fi

  # app.env: infrastructure endpoints have ONE source of truth (compose.env).
  for k in DATABASE_URL REDIS_URL RABBITMQ_URL; do
    grep -qE "^$k=" "$APP_ENV" && fail "app.env must not set $k (docker-compose.yml injects it)"
  done

  # Production must never point at a staging/sandbox endpoint.
  if grep -vE '^[[:space:]]*(#|$)' "$APP_ENV" | grep -inE 'staging|sandbox|stage-'; then
    fail "app.env contains staging/sandbox values (lines above)"
  fi
  grep -qE '^JNE_WEBHOOK_EXTRA_SOURCE_IPS=' "$APP_ENV" && fail "app.env must not set JNE_WEBHOOK_EXTRA_SOURCE_IPS"
  if [[ "$(val "$APP_ENV" MIDTRANS_ENABLED)" == true && "$(val "$APP_ENV" MIDTRANS_IS_PRODUCTION)" != true ]]; then
    fail "MIDTRANS_ENABLED=true requires MIDTRANS_IS_PRODUCTION=true in production"
  fi
  if [[ "$(val "$APP_ENV" JNE_ENABLED)" == true && "$(val "$APP_ENV" JNE_ENVIRONMENT)" != production ]]; then
    fail "JNE_ENABLED=true requires JNE_ENVIRONMENT=production"
  fi

  # No secret may be shared with staging.
  if [[ -r "$STAGING_ENV" ]]; then
    for k in JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_ADMIN_ACCESS_SECRET COOKIE_SECRET \
             PAXEL_API_SECRET PAXEL_WEBHOOK_SECRET MIDTRANS_SERVER_KEY QONTAK_API_TOKEN RESEND_API_KEY; do
      v="$(val "$APP_ENV" "$k")"
      [[ -n "$v" && "$v" == "$(val "$STAGING_ENV" "$k")" ]] && fail "app.env $k is the SAME as staging - generate a new one"
    done
    for k in POSTGRES_PASSWORD RABBITMQ_PASSWORD; do
      v="$(val "$COMPOSE_ENV" "$k")"
      [[ -n "$v" && "$v" == "$(val "$STAGING_ENV" "$k")" ]] && fail "compose.env $k is the SAME as staging"
    done
  else
    warn "staging env $STAGING_ENV not readable - secret-reuse check skipped"
  fi

  "$DC" config --quiet || fail "compose configuration invalid"
}

# ------------------------------------------------------------------ build ---
build() {
  if [[ -n "$(git -C "$REPO" status --porcelain --untracked-files=no)" && "${ALLOW_DIRTY:-0}" != 1 ]]; then
    fail "working tree has uncommitted changes; the image tag must identify the code (ALLOW_DIRTY=1 to override)"
  fi
  local avail
  avail="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
  (( avail >= MIN_FREE_MB_FOR_BUILD )) || fail "only ${avail} MiB available; a build needs >= ${MIN_FREE_MB_FOR_BUILD} MiB (MIN_FREE_MB_FOR_BUILD)"

  local svc
  for svc in "${IMAGES[@]}"; do
    log "build $svc @ $TAG"
    IMAGE_TAG="$TAG" "$DC" build "$svc"
  done
}

# ----------------------------------------------------------------- backup ---
backup_before_migrate() {
  if [[ ! -f "$RELEASE_ENV" ]]; then
    log "first deploy: empty database, pre-migrate backup skipped"
    return
  fi
  log "pre-migrate backup -> $BACKUP_DIR"
  [[ -r "$BACKUP_KEY_FILE" ]] || fail "backup key $BACKUP_KEY_FILE missing (see README); refusing to migrate without a backup"
  ( cd "$REPO" && \
    POSTGRES_CONTAINER="$("$DC" ps -q postgres)" \
    UPLOADS_VOLUME=mas-sular-prd_uploads_data \
    BACKUP_LABEL=pre-migrate \
    BACKUP_DIR="$BACKUP_DIR" BACKUP_KEY_FILE="$BACKUP_KEY_FILE" \
    ./scripts/backup/backup.sh )
}

# ------------------------------------------------------------------ prune ---
# Keep $KEEP_IMAGES tags per image: the current one, the previous one (rollback
# target) and the newest others. `docker image ls` lists newest first.
prune_images() {
  local svc tag extra=$(( KEEP_IMAGES > 2 ? KEEP_IMAGES - 2 : 0 ))
  for svc in "${IMAGES[@]}"; do
    { docker image ls "mas-sular-prd/$svc" --format '{{.Tag}}' \
        | grep -vxE "${TAG}|${PREV:-__none__}|undeployed|<none>" || true; } \
      | tail -n +"$(( extra + 1 ))" \
      | while read -r tag; do
          docker image rm "mas-sular-prd/$svc:$tag" >/dev/null && echo "pruned mas-sular-prd/$svc:$tag" || true
        done
  done
}

record_release() {
  umask 077
  printf 'IMAGE_TAG=%s\nPREVIOUS_IMAGE_TAG=%s\nDEPLOYED_AT=%s\n' "$1" "$2" "$(date -u +%FT%TZ)" > "$RELEASE_ENV"
}

rollout() {
  log "roll out backend frontend admin @ $1"
  IMAGE_TAG="$1" "$DC" up -d --no-build --no-deps --wait --wait-timeout 300 backend frontend admin
}

# ------------------------------------------------------------------- main ---
PREV="$(val "$RELEASE_ENV" IMAGE_TAG)"

if [[ "${1:-}" == "--rollback" ]]; then
  TARGET="$(val "$RELEASE_ENV" PREVIOUS_IMAGE_TAG)"
  [[ -n "$TARGET" ]] || fail "no PREVIOUS_IMAGE_TAG in $RELEASE_ENV"
  for svc in backend frontend admin; do
    docker image inspect "mas-sular-prd/$svc:$TARGET" >/dev/null 2>&1 \
      || fail "image mas-sular-prd/$svc:$TARGET no longer exists - rebuild that commit instead"
  done
  warn "rolling back APPLICATION images to $TARGET. Database migrations are NOT reverted."
  preflight
  rollout "$TARGET"
  record_release "$TARGET" "$PREV"
  "$DC" ps
  exit 0
fi

TAG="$(git -C "$REPO" rev-parse --short=12 HEAD)"
log "deploying $(git -C "$REPO" log -1 --format='%h %s') (previous: ${PREV:-none})"

preflight
build

log "data services"
IMAGE_TAG="$TAG" "$DC" up -d --wait --wait-timeout 180 postgres redis rabbitmq

backup_before_migrate

log "migrate (prisma migrate deploy)"
IMAGE_TAG="$TAG" "$DC" run --rm --no-deps backend-migrate

rollout "$TAG"
record_release "$TAG" "$PREV"
prune_images

log "done"
IMAGE_TAG="$TAG" "$DC" ps
echo
echo "Rollback (app images only): $0 --rollback"
