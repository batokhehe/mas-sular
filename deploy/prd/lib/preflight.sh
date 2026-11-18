#!/usr/bin/env bash
# Production preflight, and the ONE way the production tooling invokes
# docker compose. Sourced by deploy/prd/deploy.sh and deploy/prd/dc after
# lib/prd-root.sh and lib/secret-reuse.sh; the caller defines log, warn, fail.
#
# Keeping both here means the preflight that deploy.sh runs and the one dc runs
# before a configuration-applying command are the same code, executed in the
# same process as the compose call they protect - there is no success marker or
# environment flag that could be reused or go stale.

# ---------------------------------------------------------- docker pin -----
# The ONE Docker daemon the production tooling talks to: the local socket of the
# deployment host. Every docker call made by deploy.sh, dc and this library
# passes it explicitly (-H), and it is exported as DOCKER_HOST for child
# processes (scripts/backup/backup.sh). With the Docker CLI, -H and DOCKER_HOST
# both take precedence over a context saved with `docker context use`
# (currentContext in ~/.docker/config.json), so a saved context cannot redirect
# production commands.
PRD_DOCKER_HOST=unix:///var/run/docker.sock

# The ONE BuildKit builder production images are built with: "default", the
# builder of the docker driver inside the pinned daemon (the default context,
# which DOCKER_HOST/-H select). deploy.sh passes it explicitly
# (`compose build --builder default`), so neither BUILDX_BUILDER nor a builder
# saved with `docker buildx use [--global]` (~/.docker/buildx) can send a build
# to a remote or container builder.
PRD_BUILDX_BUILDER=default

# Environment variables that could select another daemon, another CLI
# configuration (and with it a saved context), other TLS material, extra
# compose profiles, or another BuildKit builder / buildx state directory. Any
# of them being SET (even empty) is refused - never normalised - so the
# operator learns that something in their shell would have redirected a
# production command.
PRD_DOCKER_FORBIDDEN_ENV=(DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_TLS_VERIFY DOCKER_CERT_PATH COMPOSE_PROFILES
  BUILDX_BUILDER BUILDX_CONFIG)

# Services of docker-compose.yml (the offline test asserts both lists match the
# file). PRD_BUILT_SERVICES are the ones with a `build:` section: their images
# (mas-sular-prd/<service>:<IMAGE_TAG>) are built ONLY by deploy.sh.
PRD_SERVICES=(postgres redis rabbitmq backend-migrate backend frontend admin)
PRD_BUILT_SERVICES=(backend-migrate backend frontend admin)

prd_pin_docker() {
  local v
  for v in "${PRD_DOCKER_FORBIDDEN_ENV[@]}"; do
    if [[ -n "${!v+x}" ]]; then
      fail "environment variable $v is set; production docker commands are pinned to $PRD_DOCKER_HOST and must not be redirected - unset it (value not shown)"
      return 1
    fi
  done
  export DOCKER_HOST="$PRD_DOCKER_HOST"
}

# prd_docker <docker args...>: a plain docker call against the pinned daemon.
prd_docker() {
  docker -H "$PRD_DOCKER_HOST" "$@"
}

# prd_setup <compose_file>: pin the production config root (a PRD_CONF_DIR that
# names anything else is refused) and the Docker daemon, and set the production
# file paths. Runs before any git, docker or compose command.
prd_setup() {
  if [[ -n "${PRD_CONF_DIR+x}" && "$PRD_CONF_DIR" != "$PRD_TRUSTED_CONF_DIR" ]]; then
    fail "PRD_CONF_DIR override is not supported - unset it. The production config root is $PRD_TRUSTED_CONF_DIR (deploy/prd/lib/prd-root.sh)"
    return 1
  fi
  prd_pin_docker
  # Exported so docker-compose.yml (env_file: ${PRD_CONF_DIR}/app.env) sees it.
  export PRD_CONF_DIR="$PRD_TRUSTED_CONF_DIR"
  COMPOSE_ENV="$PRD_CONF_DIR/compose.env"
  APP_ENV="$PRD_CONF_DIR/app.env"
  RELEASE_ENV="$PRD_CONF_DIR/release.env"
  # The staging stack's env file (~/apps/mas-sular, template production.env.example).
  # Overridable ONLY through <trusted root>/staging-env.path (lib/secret-reuse.sh);
  # a STAGING_ENV_FILE environment variable is refused.
  STAGING_ENV_DEFAULT=/home/massular/apps/mas-sular/production.env
  STAGING_ENV=""
  PRD_COMPOSE_FILE="$1"
  # Compose interpolation variables exported in the shell are refused HERE too,
  # so that check also comes before any git or docker call (prd_compose and
  # prd_compose_exec still repeat it immediately before compose).
  prd_env_guard
}

# Verify the trusted root and resolve the staging env path into STAGING_ENV.
# Call as a plain command: any violation ABORTs.
prd_validate_config_root() {
  verify_trusted_conf_root "$PRD_CONF_DIR"
  STAGING_ENV="$(resolve_staging_env_path "$PRD_CONF_DIR" "$STAGING_ENV_DEFAULT")"
}

# CANONICAL value of KEY (last assignment; KEY=v, KEY="v" and KEY='v' are the
# same; see lib/secret-reuse.sh). Unsupported syntax ABORTs - value not shown.
# Use only as `x="$(val ...)"` so an abort inside the substitution stops the script.
val() {
  [[ -f "$1" ]] || return 0
  local out rc=0
  out="$(_secret_reuse_val "$1" "$2")" || rc=$?
  if (( rc != 0 )); then
    _secret_reuse_value_fail "$rc" "$(basename "$1")" "$1" "$2"
    return 1
  fi
  printf '%s\n' "$out"
}

# Report every non-comment line of FILE whose text matches the ERE as
# "  <file>:<line> <KEY>" on stderr - NEVER the value or the line itself. With
# a third argument "i" the match is case-insensitive (the ERE must be lowercase).
# Returns 0 when at least one line matched.
_matching_keys() {
  local file="$1" re="$2" ci="${3:-}" line text n=0 hit=1
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    text="$line"
    [[ "$ci" == i ]] && text="${line,,}"
    [[ "$text" =~ $re ]] || continue
    hit=0
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
      printf '  %s:%s %s\n' "${file##*/}" "$n" "${BASH_REMATCH[1]}" >&2
    else
      printf '  %s:%s (not a KEY=VALUE line)\n' "${file##*/}" "$n" >&2
    fi
  done < "$file"
  return "$hit"
}

# --------------------------------------------------------- compose call ----
# Variables docker-compose.yml interpolates. A value exported in the operator's
# shell would WIN over compose.env for that invocation and so apply an
# unvalidated configuration; it is refused instead. Only IMAGE_TAG (documented:
# selects an image tag) and PRD_CONF_DIR (pinned by prd_setup) may be set.
# COMPOSE_ENV_FILES could add env files and is refused too.
prd_env_guard() {
  local v names
  if [[ ! -r "$PRD_COMPOSE_FILE" ]]; then
    fail "compose file $PRD_COMPOSE_FILE is not readable"
    return 1
  fi
  names="$(grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' "$PRD_COMPOSE_FILE" | cut -c3- | sort -u)" || names=""
  for v in $names COMPOSE_ENV_FILES; do
    case "$v" in IMAGE_TAG|PRD_CONF_DIR) continue ;; esac
    if [[ -n "${!v+x}" ]]; then
      fail "environment variable $v is set; it would override the validated production configuration for docker compose - unset it (value not shown)"
      return 1
    fi
  done
}

# Arguments that pin the project, the env files and the compose file.
_prd_compose_args() {
  PRD_COMPOSE_ARGS=(-p mas-sular-prd --env-file "$COMPOSE_ENV")
  if [[ -f "$RELEASE_ENV" ]]; then PRD_COMPOSE_ARGS+=(--env-file "$RELEASE_ENV"); fi
  PRD_COMPOSE_ARGS+=(-f "$PRD_COMPOSE_FILE")
}

# prd_compose <compose args...>: run docker compose for the production stack.
# IMAGE_TAG comes from release.env; an IMAGE_TAG in the environment wins. With
# nothing deployed yet, read-only commands (ps, config) interpolate "undeployed".
prd_compose() {
  if [[ ! -r "$COMPOSE_ENV" ]]; then
    fail "$COMPOSE_ENV not readable"
    return 1
  fi
  prd_env_guard
  _prd_compose_args
  if [[ ! -f "$RELEASE_ENV" && -z "${IMAGE_TAG:-}" ]]; then
    IMAGE_TAG=undeployed docker -H "$PRD_DOCKER_HOST" compose "${PRD_COMPOSE_ARGS[@]}" "$@"
  else
    docker -H "$PRD_DOCKER_HOST" compose "${PRD_COMPOSE_ARGS[@]}" "$@"
  fi
}

# Same, replacing the current process (used by dc as its final step).
prd_compose_exec() {
  if [[ ! -r "$COMPOSE_ENV" ]]; then
    fail "$COMPOSE_ENV not readable"
    return 1
  fi
  prd_env_guard
  _prd_compose_args
  if [[ ! -f "$RELEASE_ENV" && -z "${IMAGE_TAG:-}" ]]; then
    export IMAGE_TAG=undeployed
  fi
  exec docker -H "$PRD_DOCKER_HOST" compose "${PRD_COMPOSE_ARGS[@]}" "$@"
}

# prd_require_images: before dc creates or runs containers. Resolves the image
# tag compose will use (IMAGE_TAG from the environment if set, else
# release.env), checks its syntax, and requires EVERY built application image
# for that tag to exist in the pinned daemon - so compose can neither build one
# from the working tree nor pull one from a registry. Exports the verified tag
# so compose uses exactly that one. Any doubt ABORTs (the tag is never shown:
# an environment value might be a pasted credential).
prd_require_images() {
  local tag src svc
  if [[ -n "${IMAGE_TAG+x}" ]]; then
    tag="$IMAGE_TAG"; src="the IMAGE_TAG environment variable"
  else
    tag="$(val "$RELEASE_ENV" IMAGE_TAG)"; src="$RELEASE_ENV"
  fi
  if [[ -z "$tag" ]]; then
    fail "no image tag in $src - nothing deployed yet; deploy with deploy/prd/deploy.sh"
    return 1
  fi
  if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
    fail "image tag from $src is not a valid image tag (value not shown)"
    return 1
  fi
  for svc in "${PRD_BUILT_SERVICES[@]}"; do
    if ! prd_docker image inspect "mas-sular-prd/$svc:$tag" >/dev/null 2>&1; then
      fail "image mas-sular-prd/$svc for the tag from $src does not exist (or could not be verified) - dc never builds or pulls application images; build with deploy/prd/deploy.sh"
      return 1
    fi
  done
  export IMAGE_TAG="$tag"
}

# ------------------------------------------------------------- preflight ----
# Production checks shared by forward deploy, --check, rollback and dc. Every
# one of them reads production files only; none depends on staging.
_preflight_common() {
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
  if _matching_keys "$APP_ENV" 'CHANGE_ME|<[A-Z_]+>'; then
    fail "app.env still contains placeholders (keys above; values not shown)"
  fi

  # app.env: infrastructure endpoints have ONE source of truth (compose.env).
  for k in DATABASE_URL REDIS_URL RABBITMQ_URL; do
    grep -qE "^$k=" "$APP_ENV" && fail "app.env must not set $k (docker-compose.yml injects it)"
  done

  # Production must never point at a staging/sandbox endpoint.
  if _matching_keys "$APP_ENV" 'staging|sandbox|stage-' i; then
    fail "app.env contains staging/sandbox values (keys above; values not shown)"
  fi
  grep -qE '^JNE_WEBHOOK_EXTRA_SOURCE_IPS=' "$APP_ENV" && fail "app.env must not set JNE_WEBHOOK_EXTRA_SOURCE_IPS"
  # Assignments (not `[[ "$(val ...)" ]]`) so an unsupported value aborts here.
  local mt_on mt_prod jne_on jne_env
  mt_on="$(val "$APP_ENV" MIDTRANS_ENABLED)"
  mt_prod="$(val "$APP_ENV" MIDTRANS_IS_PRODUCTION)"
  jne_on="$(val "$APP_ENV" JNE_ENABLED)"
  jne_env="$(val "$APP_ENV" JNE_ENVIRONMENT)"
  if [[ "$mt_on" == true && "$mt_prod" != true ]]; then
    fail "MIDTRANS_ENABLED=true requires MIDTRANS_IS_PRODUCTION=true in production"
  fi
  if [[ "$jne_on" == true && "$jne_env" != production ]]; then
    fail "JNE_ENABLED=true requires JNE_ENVIRONMENT=production"
  fi
  return 0
}

# STRICT preflight (forward deploy, deploy.sh --check, dc up/create/run). All
# three env files (production app, production compose, staging) must exist and
# be readable, non-empty regular files that parse. No secret may be shared with
# staging. MIDTRANS_SERVER_KEY is exempt only while MIDTRANS_ENABLED=false
# (gateway off); any other value fails closed.
preflight() {
  log "preflight"
  _preflight_common
  check_secret_reuse "$APP_ENV" "$STAGING_ENV" "$COMPOSE_ENV"
  prd_compose config --quiet || fail "compose configuration invalid"
}

# Rollback policy (deploy.sh --rollback, dc start/restart/unpause - commands
# that restart existing containers and cannot introduce new configuration).
# Same production checks as forward; the staging comparison runs when the
# staging env file is usable and is skipped WITH A WARNING when it is not, so
# an unavailable staging stack never blocks an emergency rollback or restart.
preflight_rollback() {
  log "preflight (rollback)"
  _preflight_common
  check_secret_reuse_rollback "$APP_ENV" "$STAGING_ENV" "$COMPOSE_ENV"
  prd_compose config --quiet || fail "compose configuration invalid"
}
