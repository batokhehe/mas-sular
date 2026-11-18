#!/usr/bin/env bash
# Mas Sular PRODUCTION deploy: build THIS checkout's HEAD, back up, migrate, roll out.
#
#   deploy/prd/deploy.sh              build + pre-migrate backup + migrate + roll out
#   deploy/prd/deploy.sh --check      preflight ONLY: validate the production
#                                     configuration and exit (0 = valid). Builds,
#                                     pulls, migrates, backs up, starts, stops and
#                                     changes nothing.
#   deploy/prd/deploy.sh --rollback   back to the previous image tag (no build, no migrate)
#
# These are the ONLY three accepted forms. Any other argument (a typo such as
# --rollbak, --rollback=true, --force, a positional word, an empty string, or
# two arguments such as --check --rollback) aborts with exit 2 before any check,
# git, docker or compose command runs, so a typo can never start a forward deploy.
#
# Every compose call goes through prd_compose (lib/preflight.sh: project
# mas-sular-prd, the trusted env files), the same invocation deploy/prd/dc uses:
# staging is never built, restarted or recreated by this script. Every docker
# call (compose, image inspect/ls/rm, and backup.sh via the exported DOCKER_HOST)
# is pinned to the local daemon socket unix:///var/run/docker.sock; DOCKER_HOST,
# DOCKER_CONTEXT, DOCKER_CONFIG, DOCKER_TLS_VERIFY, DOCKER_CERT_PATH,
# COMPOSE_PROFILES, BUILDX_BUILDER and BUILDX_CONFIG in the environment are
# refused. Images are built with the explicit builder `--builder default` (the
# pinned daemon's own BuildKit), never a builder saved with `docker buildx use`.
# KEEP_IMAGES and MIN_FREE_MB_FOR_BUILD must be plain decimal numbers (checked
# before anything runs; an arithmetic expression is never evaluated).
#
# Shared 1 vCPU host: images are built ONE AT A TIME (a Next.js build peaks at
# ~1-1.5 GiB) and the script refuses to build when the host is short on memory.
# Never trace: `bash -x deploy.sh` or an exported SHELLOPTS=xtrace would print
# every secret value this script reads. Tracing is switched off before any read.
set +x
set -Eeuo pipefail

# ---------------------------------------------------------- arguments -------
# Validated FIRST: nothing below (not even sourcing the library) runs for an
# invalid command line. There is deliberately no --force / bypass option.
usage() {
  printf 'Usage: %s              build + pre-migrate backup + migrate + roll out\n' "$0" >&2
  printf '       %s --check      preflight only: validate configuration, change nothing\n' "$0" >&2
  printf '       %s --rollback   back to the previous image tag (no build, no migrate)\n' "$0" >&2
}
# The rejected value is deliberately NEVER printed: an operator may have pasted
# a credential as an argument, and deploy output ends up in logs and tickets.
reject_args() {
  printf 'ABORT: invalid command line (%s argument(s) given); accepted: no argument, exactly --check, or exactly --rollback\n' "$1" >&2
  usage
  exit 2
}
case $# in
  0) MODE=forward ;;
  1) case "$1" in --rollback) MODE=rollback ;; --check) MODE=check ;; *) reject_args 1 ;; esac ;;
  *) reject_args "$#" ;;
esac
readonly MODE

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

log()  { printf '\n==> %s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
fail() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }

# shellcheck source=lib/prd-root.sh
. "$HERE/lib/prd-root.sh"
# shellcheck source=lib/secret-reuse.sh
. "$HERE/lib/secret-reuse.sh"
# shellcheck source=lib/preflight.sh
. "$HERE/lib/preflight.sh"

# The production config root is FIXED (lib/prd-root.sh); a PRD_CONF_DIR naming
# anything else is refused. Sets COMPOSE_ENV, APP_ENV, RELEASE_ENV, STAGING_ENV*.
prd_setup "$HERE/docker-compose.yml"
BACKUP_DIR="${BACKUP_DIR:-/srv/backups/mas-sular-prd}"
BACKUP_KEY_FILE="${BACKUP_KEY_FILE:-$PRD_CONF_DIR/backup.key}"
KEEP_IMAGES="${KEEP_IMAGES:-3}"
MIN_FREE_MB_FOR_BUILD="${MIN_FREE_MB_FOR_BUILD:-1200}"
# Both end up in bash arithmetic, which EVALUATES its operands: a value such as
# `BASH_VERSINFO[$(cmd)0]` would run cmd (reproduced offline, even under set -u).
# Only plain decimal digits within bounds are accepted,
# checked as strings BEFORE any arithmetic, git or docker; the value is not shown.
if [[ ! "$KEEP_IMAGES" =~ ^[0-9]{1,2}$ ]] || (( 10#$KEEP_IMAGES < 1 || 10#$KEEP_IMAGES > 20 )); then
  fail "KEEP_IMAGES must be a whole number from 1 to 20 (value not shown)"
fi
if [[ ! "$MIN_FREE_MB_FOR_BUILD" =~ ^[0-9]{1,6}$ ]] || (( 10#$MIN_FREE_MB_FOR_BUILD > 65536 )); then
  fail "MIN_FREE_MB_FOR_BUILD must be a whole number of MiB from 0 to 65536 (value not shown)"
fi
KEEP_IMAGES=$((10#$KEEP_IMAGES))
MIN_FREE_MB_FOR_BUILD=$((10#$MIN_FREE_MB_FOR_BUILD))
IMAGES=("${PRD_BUILT_SERVICES[@]}")

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
    IMAGE_TAG="$TAG" prd_compose build --builder "$PRD_BUILDX_BUILDER" "$svc"
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
  # Exactly ONE production postgres container id, resolved here: backup.sh falls
  # back to a different compose project when POSTGRES_CONTAINER is empty.
  local pg_cid
  pg_cid="$(prd_compose ps -q postgres)" || fail "could not resolve the production postgres container; refusing to migrate without a backup"
  [[ "$pg_cid" =~ ^[0-9a-f]{12,64}$ ]] || fail "expected exactly one production postgres container, found none or several; refusing to migrate without a backup"
  # Every documented backup.sh override is set here, so none comes from the
  # operator's shell (e.g. a KEEP_POSTGRES=1 that would prune all but the newest
  # dump right before a migration, or a COMPOSE_FILE/ENV_FILE fallback). Generic
  # process variables (TMPDIR, GNUPGHOME, PATH) remain the trusted shell (D2).
  ( cd "$REPO" && \
    POSTGRES_CONTAINER="$pg_cid" \
    UPLOADS_VOLUME=mas-sular-prd_uploads_data \
    BACKUP_LABEL=pre-migrate \
    KEEP_POSTGRES=14 KEEP_UPLOADS=14 \
    COMPOSE_FILE=/nonexistent/compose-not-used.yml ENV_FILE=/nonexistent/env-not-used \
    POSTGRES_SERVICE=postgres \
    BACKUP_DIR="$BACKUP_DIR" BACKUP_KEY_FILE="$BACKUP_KEY_FILE" \
    ./scripts/backup/backup.sh )
}

# ------------------------------------------------------------------ prune ---
# Keep $KEEP_IMAGES tags per image: the current one, the previous one (rollback
# target) and the newest others. `docker image ls` lists newest first.
prune_images() {
  local svc tag extra=$(( KEEP_IMAGES > 2 ? KEEP_IMAGES - 2 : 0 ))
  for svc in "${IMAGES[@]}"; do
    { prd_docker image ls "mas-sular-prd/$svc" --format '{{.Tag}}' \
        | grep -vxE "${TAG}|${PREV:-__none__}|undeployed|<none>" || true; } \
      | tail -n +"$(( extra + 1 ))" \
      | while read -r tag; do
          prd_docker image rm "mas-sular-prd/$svc:$tag" >/dev/null && echo "pruned mas-sular-prd/$svc:$tag" || true
        done
  done
}

record_release() {
  umask 077
  printf 'IMAGE_TAG=%s\nPREVIOUS_IMAGE_TAG=%s\nDEPLOYED_AT=%s\n' "$1" "$2" "$(date -u +%FT%TZ)" > "$RELEASE_ENV"
}

rollout() {
  log "roll out backend frontend admin @ $1"
  IMAGE_TAG="$1" prd_compose up -d --no-build --no-deps --wait --wait-timeout 300 backend frontend admin
}

# ------------------------------------------------------------------- main ---
# Verify the trusted root and resolve the staging env path FIRST (every mode):
# an invalid root or override aborts here, before git, docker or any compose command.
prd_validate_config_root
PREV="$(val "$RELEASE_ENV" IMAGE_TAG)"

if [[ "$MODE" == rollback ]]; then
  TARGET="$(val "$RELEASE_ENV" PREVIOUS_IMAGE_TAG)"
  [[ -n "$TARGET" ]] || fail "no PREVIOUS_IMAGE_TAG in $RELEASE_ENV"
  for svc in backend frontend admin; do
    prd_docker image inspect "mas-sular-prd/$svc:$TARGET" >/dev/null 2>&1 \
      || fail "image mas-sular-prd/$svc:$TARGET no longer exists - rebuild that commit instead"
  done
  warn "rolling back APPLICATION images to $TARGET. Database migrations are NOT reverted."
  preflight_rollback
  rollout "$TARGET"
  record_release "$TARGET" "$PREV"
  prd_compose ps
  exit 0
fi

if [[ "$MODE" == check ]]; then
  # The STRICT forward preflight, nothing else: the only compose call is the
  # read-only `config --quiet` inside it.
  preflight
  log "preflight OK - configuration is valid. Nothing was built, pulled, migrated, backed up, started, stopped or changed."
  exit 0
fi

TAG="$(git -C "$REPO" rev-parse --short=12 HEAD)"
log "deploying $(git -C "$REPO" log -1 --format='%h %s') (previous: ${PREV:-none})"

preflight
build

log "data services"
IMAGE_TAG="$TAG" prd_compose up -d --wait --wait-timeout 180 postgres redis rabbitmq

backup_before_migrate

log "migrate (prisma migrate deploy)"
IMAGE_TAG="$TAG" prd_compose run --rm --no-deps backend-migrate

rollout "$TAG"
record_release "$TAG" "$PREV"
prune_images

log "done"
IMAGE_TAG="$TAG" prd_compose ps
echo
echo "Rollback (app images only): $0 --rollback"
