#!/usr/bin/env bash
#
# Offline test for deploy/prd/lib/secret-reuse.sh.
#
# Exercises the production secret-reuse guard (forward and rollback variants)
# with synthetic env files, then runs a SANDBOX COPY of deploy.sh (forward and
# --rollback) against stubbed dc / docker / git. No Docker, no production
# config and no real secret is read or written; everything lives in mktemp -d.
#
# Usage (repo root):  bash deploy/prd/test-secret-reuse.sh
#
set -Euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/lib/secret-reuse.sh"
T="$(mktemp -d)"
PASS=0
FAILS=0
SKIPS=0
LAST_OUTPUT=""

ok()   { PASS=$((PASS + 1)); echo "  PASS  $*"; }
bad()  { FAILS=$((FAILS + 1)); echo "  FAIL  $*"; }
skip() { SKIPS=$((SKIPS + 1)); echo "  SKIP  $*"; }
cleanup() { chmod -R u+rwX "$T" 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
# The real deploy files must be byte-identical after the run (checked at the end).
RUNBOOK="$HERE/../../scripts/backup/RUNBOOK.md"
REPO_BEFORE="$(sha256sum "$HERE/deploy.sh" "$LIB" "$HERE/lib/prd-root.sh" "$HERE/lib/preflight.sh" "$HERE/dc" "$HERE/docker-compose.yml" "$HERE/README.md" "$RUNBOOK" 2>/dev/null)"

# deploy.sh provides these; the test supplies lightweight equivalents so a
# rejection returns instead of exiting the whole test run. warn() prints, so a
# skipped comparison can be asserted and every warning is leak-checked too.
warn() { echo "WARN: $*" >&2; }
fail() { echo "ABORT: $*" >&2; return 1; }
# shellcheck source=lib/secret-reuse.sh
. "$LIB"

# Every synthetic value used below. A failure message must never contain one.
SECRET_VALUES=(
  staging-jwt-access staging-jwt-refresh staging-jwt-admin staging-cookie
  staging-paxel-api staging-paxel-webhook SB-Mid-server-STAGING
  staging-qontak staging-resend staging-postgres staging-rabbitmq
  prod-jwt-access prod-jwt-refresh prod-jwt-admin prod-cookie
  prod-paxel-api prod-paxel-webhook prod-qontak prod-resend
  prod-postgres prod-rabbitmq prod-midtrans
)

# ---------------------------------------------------------------- fixtures ---
cat > "$T/staging.env" <<'EOF'
JWT_ACCESS_SECRET=staging-jwt-access
JWT_REFRESH_SECRET=staging-jwt-refresh
JWT_ADMIN_ACCESS_SECRET=staging-jwt-admin
COOKIE_SECRET=staging-cookie
PAXEL_API_SECRET=staging-paxel-api
PAXEL_WEBHOOK_SECRET=staging-paxel-webhook
MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING
QONTAK_API_TOKEN=staging-qontak
RESEND_API_KEY=staging-resend
POSTGRES_PASSWORD=staging-postgres
RABBITMQ_PASSWORD=staging-rabbitmq
EOF

cat > "$T/app.base" <<'EOF'
JWT_ACCESS_SECRET=prod-jwt-access
JWT_REFRESH_SECRET=prod-jwt-refresh
JWT_ADMIN_ACCESS_SECRET=prod-jwt-admin
COOKIE_SECRET=prod-cookie
PAXEL_API_SECRET=prod-paxel-api
PAXEL_WEBHOOK_SECRET=prod-paxel-webhook
QONTAK_API_TOKEN=prod-qontak
RESEND_API_KEY=prod-resend
EOF

cat > "$T/compose.base" <<'EOF'
POSTGRES_PASSWORD=prod-postgres
RABBITMQ_PASSWORD=prod-rabbitmq
EOF

# set_kv <file> <KEY=VALUE>: replace the key's existing line, or append it.
# Production files reject duplicate keys, so fixtures must override in place.
set_kv() {
  local file="$1" line="$2" key="${2%%=*}"
  if grep -q "^$key=" "$file"; then
    # The replacement goes through ENVIRON, not -v: awk -v would turn "\b" etc. into escapes.
    SETKV_LINE="$line" awk -v k="$key" 'index($0, k "=") == 1 { print ENVIRON["SETKV_LINE"]; next } { print }' "$file" > "$file.tmp" \
      && cat "$file.tmp" > "$file" && rm -f "$file.tmp"
  else
    printf '%s\n' "$line" >> "$file"
  fi
}

# new_case <name> [extra app.env lines...]
new_case() {
  local name="$1"; shift
  CASE="$T/$name"
  mkdir -p "$CASE"
  cp "$T/app.base" "$CASE/app.env"
  cp "$T/compose.base" "$CASE/compose.env"
  cp "$T/staging.env" "$CASE/staging.env"
  local line
  for line in "$@"; do set_kv "$CASE/app.env" "$line"; done
}

# chmod is a no-op for readability on some filesystems (e.g. DrvFs). Return
# success only when the file really became unreadable.
make_unreadable() {
  chmod 000 "$1" 2>/dev/null || true
  [[ ! -r "$1" ]]
}

assert_no_leak() {
  local label="$1" out="$2" secret
  for secret in "${SECRET_VALUES[@]}"; do
    if [[ "$out" == *"$secret"* ]]; then
      bad "$label leaked a synthetic secret value into its output"
      return 1
    fi
  done
  return 0
}

# expect <label> <allow|reject>           forward check (check_secret_reuse)
# expect_rb <label> <allow|reject>        rollback check (check_secret_reuse_rollback)
expect()    { expect_fn check_secret_reuse "$@"; }
expect_rb() { expect_fn check_secret_reuse_rollback "$@"; }
expect_fn() {
  local fn="$1" label="$2" want="$3" got out
  if out="$("$fn" "$CASE/app.env" "$CASE/staging.env" "$CASE/compose.env" 2>&1)"; then
    got=allow
  else
    got=reject
  fi
  LAST_OUTPUT="$out"
  if ! assert_no_leak "$label" "$out"; then
    return
  fi
  if [[ "$got" == "$want" ]]; then
    ok "$label"
  else
    bad "$label (expected $want, got $got)"
  fi
}

echo "secret-reuse: required files, fail-closed paths, and approved exemptions"

# 1. Both environment files readable and all secrets distinct.
new_case distinct 'MIDTRANS_ENABLED=false'
expect "both files readable + all secrets distinct -> allowed" allow

# 2. Staging file missing.
new_case staging_missing 'MIDTRANS_ENABLED=false'
rm -f "$CASE/staging.env"
expect "missing staging env -> rejected" reject

# 3. Staging file unreadable.
new_case staging_unreadable 'MIDTRANS_ENABLED=false'
if make_unreadable "$CASE/staging.env"; then
  expect "unreadable staging env -> rejected" reject
else
  skip "unreadable staging env (platform keeps files readable after chmod 000)"
fi

# 3b. Staging file empty.
new_case staging_empty 'MIDTRANS_ENABLED=false'
: > "$CASE/staging.env"
expect "empty staging env -> rejected" reject

# 4. Production app env missing.
new_case app_missing 'MIDTRANS_ENABLED=false'
rm -f "$CASE/app.env"
expect "missing production app env -> rejected" reject

# 4b. Production app env unreadable.
new_case app_unreadable 'MIDTRANS_ENABLED=false'
if make_unreadable "$CASE/app.env"; then
  expect "unreadable production app env -> rejected" reject
else
  skip "unreadable production app env (platform keeps files readable after chmod 000)"
fi

# 4c. Production compose env missing.
new_case compose_missing 'MIDTRANS_ENABLED=false'
rm -f "$CASE/compose.env"
expect "missing production compose env -> rejected" reject

# 4d. Production compose env unreadable.
new_case compose_unreadable 'MIDTRANS_ENABLED=false'
if make_unreadable "$CASE/compose.env"; then
  expect "unreadable production compose env -> rejected" reject
else
  skip "unreadable production compose env (platform keeps files readable after chmod 000)"
fi

# 5. Midtrans disabled + matching key: allowed.
new_case midtrans_disabled_match \
  'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "MIDTRANS_ENABLED=false + matching MIDTRANS_SERVER_KEY -> allowed" allow

# 6. Midtrans enabled + matching key: rejected.
new_case midtrans_enabled_match \
  'MIDTRANS_ENABLED=true' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "MIDTRANS_ENABLED=true + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 7. Flag missing + matching key: rejected (fail closed).
new_case midtrans_flag_missing \
  'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "missing MIDTRANS_ENABLED + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 7b. Flag invalid + matching key: rejected (fail closed).
new_case midtrans_flag_invalid \
  'MIDTRANS_ENABLED=yes' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "invalid MIDTRANS_ENABLED + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 7c. Wrong case is invalid, not "disabled": rejected.
new_case midtrans_flag_wrong_case \
  'MIDTRANS_ENABLED=FALSE' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "MIDTRANS_ENABLED=FALSE + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 7d. Empty flag is invalid: rejected.
new_case midtrans_flag_empty \
  'MIDTRANS_ENABLED=' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "empty MIDTRANS_ENABLED + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 8. Owner-authorized shared credentials: QONTAK_API_TOKEN / RESEND_API_KEY
#    may match staging (owner authorization, 2026-11-10) regardless of the
#    Midtrans flag. Every OTHER shared secret is still rejected.
new_case qontak_match 'MIDTRANS_ENABLED=false' 'QONTAK_API_TOKEN=staging-qontak'
expect "MIDTRANS_ENABLED=false + matching QONTAK_API_TOKEN -> allowed" allow

new_case qontak_match_midtrans_enabled 'MIDTRANS_ENABLED=true' 'QONTAK_API_TOKEN=staging-qontak'
expect "MIDTRANS_ENABLED=true + matching QONTAK_API_TOKEN -> allowed" allow

new_case qontak_no_match 'MIDTRANS_ENABLED=false' 'QONTAK_API_TOKEN=prod-qontak'
expect "MIDTRANS_ENABLED=false + non-matching QONTAK_API_TOKEN -> allowed" allow

new_case resend_match 'MIDTRANS_ENABLED=false' 'RESEND_API_KEY=staging-resend'
expect "MIDTRANS_ENABLED=false + matching RESEND_API_KEY -> allowed" allow

new_case resend_match_midtrans_enabled 'MIDTRANS_ENABLED=true' 'RESEND_API_KEY=staging-resend'
expect "MIDTRANS_ENABLED=true + matching RESEND_API_KEY -> allowed" allow

new_case jwt_match 'MIDTRANS_ENABLED=false' 'JWT_ACCESS_SECRET=staging-jwt-access'
expect "MIDTRANS_ENABLED=false + matching JWT_ACCESS_SECRET -> rejected" reject

# 8b. The Qontak/Resend authorization does not rescue any other secret.
new_case qontak_match_plus_jwt_match \
  'MIDTRANS_ENABLED=false' 'QONTAK_API_TOKEN=staging-qontak' 'JWT_REFRESH_SECRET=staging-jwt-refresh'
expect "matching QONTAK_API_TOKEN + matching JWT_REFRESH_SECRET -> rejected" reject

# 9. Disabled Midtrans and owner-authorized Qontak/Resend do not exempt
#    shared infrastructure passwords.
new_case postgres_match 'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=prod-midtrans' 'QONTAK_API_TOKEN=staging-qontak' 'RESEND_API_KEY=staging-resend'
set_kv "$CASE/compose.env" 'POSTGRES_PASSWORD=staging-postgres'
expect "shared Qontak/Resend + matching POSTGRES_PASSWORD -> rejected" reject

new_case rabbitmq_match 'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=prod-midtrans' 'QONTAK_API_TOKEN=staging-qontak' 'RESEND_API_KEY=staging-resend'
set_kv "$CASE/compose.env" 'RABBITMQ_PASSWORD=staging-rabbitmq'
expect "shared Qontak/Resend + matching RABBITMQ_PASSWORD -> rejected" reject

# 10. Non-matching Midtrans key stays allowed regardless of the flag.
new_case midtrans_disabled_no_match \
  'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=prod-midtrans'
expect "MIDTRANS_ENABLED=false + non-matching key -> allowed" allow

# 11. Inline comment after the flag is stripped, so it still reads as false.
new_case midtrans_disabled_comment \
  'MIDTRANS_ENABLED=false  # gateway not live yet' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "MIDTRANS_ENABLED=false with inline comment + matching key -> allowed" allow

# 12. Parsing failures fail closed.
new_case app_parse_error 'MIDTRANS_ENABLED=false'
printf 'JWT_ACCESS_SECRET prod-secret-without-equals\n' >> "$CASE/app.env"
expect "unparseable production app env -> rejected" reject

new_case staging_parse_error 'MIDTRANS_ENABLED=false'
printf 'this line is not a KEY=VALUE assignment\n' >> "$CASE/staging.env"
expect "unparseable staging env -> rejected" reject

new_case compose_parse_error 'MIDTRANS_ENABLED=false'
printf 'POSTGRES_PASSWORD prod-secret-without-equals\n' >> "$CASE/compose.env"
expect "unparseable production compose env -> rejected" reject

# 13. A value-extraction failure (parser command unavailable) fails closed.
new_case parser_unavailable 'MIDTRANS_ENABLED=false'
if out="$( ( PATH=/nonexistent; check_secret_reuse "$CASE/app.env" "$CASE/staging.env" "$CASE/compose.env" ) 2>&1 )"; then
  bad "value-extraction failure -> rejected (expected reject, got allow)"
else
  ok "value-extraction failure (sed unavailable) -> rejected"
fi
LAST_OUTPUT="$out"
if assert_no_leak "value-extraction failure" "$out"; then
  ok "value-extraction failure output contains no secret values"
fi

# 14. Rejection output never contains a secret value.
new_case leak_probe 'MIDTRANS_ENABLED=false' 'JWT_ACCESS_SECRET=staging-jwt-access'
expect "JWT match rejected (leak probe)" reject
if assert_no_leak "leak probe" "$LAST_OUTPUT"; then
  ok "rejection output contains no secret values"
fi

# 15. More forward fail-closed paths.
new_case app_empty 'MIDTRANS_ENABLED=false'
: > "$CASE/app.env"
expect "empty production app env -> rejected" reject

new_case compose_empty 'MIDTRANS_ENABLED=false'
: > "$CASE/compose.env"
expect "empty production compose env -> rejected" reject

# Portable stand-in for "unreadable" where chmod 000 has no effect: the path
# exists but cannot be read as an env file.
new_case staging_is_dir 'MIDTRANS_ENABLED=false'
rm -f "$CASE/staging.env"; mkdir "$CASE/staging.env"
expect "staging env path is a directory -> rejected" reject

# ------------------------------------------------- rollback (function level) ---
echo
echo "secret-reuse: rollback variant (check_secret_reuse_rollback)"

# expect_skip_warn <label>: the last allowed rollback must have said, loudly,
# that the staging comparison was NOT performed.
expect_skip_warn() {
  if [[ "$LAST_OUTPUT" == *"staging secret-reuse comparison NOT performed"* ]]; then
    ok "$1: explicit WARN that staging comparison was not performed"
  else
    bad "$1: missing the 'comparison NOT performed' warning"
  fi
}

new_case rb_distinct 'MIDTRANS_ENABLED=false'
expect_rb "rollback: staging usable + all secrets distinct -> allowed" allow
if [[ "$LAST_OUTPUT" == *"NOT performed"* ]]; then
  bad "rollback: usable staging must be compared, not skipped"
else
  ok "rollback: usable staging is compared (no skip warning)"
fi

new_case rb_staging_missing 'MIDTRANS_ENABLED=false'
rm -f "$CASE/staging.env"
expect_rb "rollback: staging missing + production valid -> allowed" allow
expect_skip_warn "rollback: staging missing"

new_case rb_staging_empty 'MIDTRANS_ENABLED=false'
: > "$CASE/staging.env"
expect_rb "rollback: staging empty + production valid -> allowed" allow
expect_skip_warn "rollback: staging empty"

new_case rb_staging_parse_error 'MIDTRANS_ENABLED=false'
printf 'this line is not a KEY=VALUE assignment\n' >> "$CASE/staging.env"
expect_rb "rollback: staging unparseable + production valid -> allowed" allow
expect_skip_warn "rollback: staging unparseable"

new_case rb_staging_is_dir 'MIDTRANS_ENABLED=false'
rm -f "$CASE/staging.env"; mkdir "$CASE/staging.env"
expect_rb "rollback: staging path is a directory + production valid -> allowed" allow
expect_skip_warn "rollback: staging path is a directory"

new_case rb_staging_unreadable 'MIDTRANS_ENABLED=false'
if make_unreadable "$CASE/staging.env"; then
  expect_rb "rollback: staging unreadable + production valid -> allowed" allow
  expect_skip_warn "rollback: staging unreadable"
else
  skip "rollback: unreadable staging env (platform keeps files readable after chmod 000; directory case above covers the not-usable path)"
fi

# Production inputs stay mandatory - with staging present AND with it missing.
for staging_state in present missing; do
  new_case "rb_app_missing_$staging_state" 'MIDTRANS_ENABLED=false'
  [[ "$staging_state" == missing ]] && rm -f "$CASE/staging.env"
  rm -f "$CASE/app.env"
  expect_rb "rollback: production app env missing (staging $staging_state) -> rejected" reject

  new_case "rb_compose_missing_$staging_state" 'MIDTRANS_ENABLED=false'
  [[ "$staging_state" == missing ]] && rm -f "$CASE/staging.env"
  rm -f "$CASE/compose.env"
  expect_rb "rollback: production compose env missing (staging $staging_state) -> rejected" reject

  new_case "rb_app_empty_$staging_state" 'MIDTRANS_ENABLED=false'
  [[ "$staging_state" == missing ]] && rm -f "$CASE/staging.env"
  : > "$CASE/app.env"
  expect_rb "rollback: production app env empty (staging $staging_state) -> rejected" reject

  new_case "rb_app_dir_$staging_state" 'MIDTRANS_ENABLED=false'
  [[ "$staging_state" == missing ]] && rm -f "$CASE/staging.env"
  rm -f "$CASE/app.env"; mkdir "$CASE/app.env"
  expect_rb "rollback: production app env is a directory (staging $staging_state) -> rejected" reject

  new_case "rb_app_parse_$staging_state" 'MIDTRANS_ENABLED=false'
  [[ "$staging_state" == missing ]] && rm -f "$CASE/staging.env"
  printf 'JWT_ACCESS_SECRET prod-secret-without-equals\n' >> "$CASE/app.env"
  expect_rb "rollback: production app env unparseable (staging $staging_state) -> rejected" reject

  new_case "rb_compose_parse_$staging_state" 'MIDTRANS_ENABLED=false'
  [[ "$staging_state" == missing ]] && rm -f "$CASE/staging.env"
  printf 'POSTGRES_PASSWORD prod-secret-without-equals\n' >> "$CASE/compose.env"
  expect_rb "rollback: production compose env unparseable (staging $staging_state) -> rejected" reject
done

new_case rb_app_unreadable 'MIDTRANS_ENABLED=false'
rm -f "$CASE/staging.env"
if make_unreadable "$CASE/app.env"; then
  expect_rb "rollback: production app env unreadable -> rejected" reject
else
  skip "rollback: unreadable production app env (platform keeps files readable after chmod 000; directory case above covers it)"
fi

# With staging usable, rollback enforces exactly the forward rules.
new_case rb_jwt_match 'MIDTRANS_ENABLED=false' 'JWT_ACCESS_SECRET=staging-jwt-access'
expect_rb "rollback: staging usable + matching JWT_ACCESS_SECRET -> rejected" reject

new_case rb_postgres_match 'MIDTRANS_ENABLED=false'
set_kv "$CASE/compose.env" 'POSTGRES_PASSWORD=staging-postgres'
expect_rb "rollback: staging usable + matching POSTGRES_PASSWORD -> rejected" reject

new_case rb_midtrans_disabled_match 'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect_rb "rollback: MIDTRANS_ENABLED=false + matching MIDTRANS_SERVER_KEY -> allowed" allow

new_case rb_midtrans_enabled_match 'MIDTRANS_ENABLED=true' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect_rb "rollback: MIDTRANS_ENABLED=true + matching MIDTRANS_SERVER_KEY -> rejected" reject

new_case rb_midtrans_flag_missing 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect_rb "rollback: missing MIDTRANS_ENABLED + matching MIDTRANS_SERVER_KEY -> rejected" reject

new_case rb_qontak_resend_match 'MIDTRANS_ENABLED=true' 'QONTAK_API_TOKEN=staging-qontak' 'RESEND_API_KEY=staging-resend'
expect_rb "rollback: matching QONTAK_API_TOKEN + RESEND_API_KEY -> allowed (unchanged exemption)" allow

new_case rb_qontak_plus_jwt 'MIDTRANS_ENABLED=false' 'QONTAK_API_TOKEN=staging-qontak' 'JWT_REFRESH_SECRET=staging-jwt-refresh'
expect_rb "rollback: matching QONTAK_API_TOKEN + matching JWT_REFRESH_SECRET -> rejected" reject

# The forward check is NOT relaxed by the rollback variant's existence.
new_case fwd_still_strict 'MIDTRANS_ENABLED=false'
rm -f "$CASE/staging.env"
expect "forward check after rollback variant loaded: staging missing -> still rejected" reject

# Calling the checks in THIS shell (not a subshell) leaves no state behind.
new_case env_state 'MIDTRANS_ENABLED=false'
rm -f "$CASE/staging.env"
env_before="$(env | grep -v '^_=' | sort)"
check_secret_reuse_rollback "$CASE/app.env" "$CASE/staging.env" "$CASE/compose.env" 2>/dev/null
check_secret_reuse "$CASE/app.env" "$CASE/staging.env" "$CASE/compose.env" 2>/dev/null
env_after="$(env | grep -v '^_=' | sort)"
leaked_vars=""
for v_name in reason midtrans_enabled staging_vals rc k v; do
  declare -p "$v_name" >/dev/null 2>&1 && leaked_vars+=" $v_name"
done
if [[ "$env_before" == "$env_after" && -z "$leaked_vars" ]]; then
  ok "checks leave the environment and shell variables unchanged"
else
  bad "checks changed the environment or leaked shell variables"
fi

# ------------------------------------------------- deploy.sh dispatch -------
echo
echo "deploy.sh dispatch (sandbox copy, stubbed dc/docker/git; nothing real is run)"

# Static guard: the rollback preflight is reachable only from the --rollback
# branch; there is no flag or variable that selects it on a forward deploy.
DEPLOY_SRC="$(sed 's/\r$//' "$HERE/deploy.sh")"
rb_start="$(grep -nF 'if [[ "$MODE" == rollback ]]; then' <<<"$DEPLOY_SRC" | cut -d: -f1)"
rb_end="$(awk -v s="${rb_start:-0}" 'NR > s && /^fi$/ { print NR; exit }' <<<"$DEPLOY_SRC")"
rb_calls="$(grep -nE '^[[:space:]]*preflight_rollback([[:space:]]|$)' <<<"$DEPLOY_SRC" | cut -d: -f1)"
# Strict `preflight` is called twice in deploy.sh (forward and --check), never
# inside the rollback block; the rollback library check is reached only through
# preflight_rollback in lib/preflight.sh.
fwd_lines="$(grep -nE '^[[:space:]]*preflight([[:space:]]|$)' <<<"$DEPLOY_SRC" | cut -d: -f1)"
fwd_calls="$(wc -w <<<"$fwd_lines")"
fwd_in_rb=0
for l in $fwd_lines; do (( l > rb_start && l < rb_end )) && fwd_in_rb=1; done
PREFLIGHT_SRC="$(sed 's/\r$//' "$HERE/lib/preflight.sh")"
lib_calls="$( { grep -vE '^[[:space:]]*#' <<<"$DEPLOY_SRC"; grep -vE '^[[:space:]]*#' <<<"$PREFLIGHT_SRC"; } | grep -c 'check_secret_reuse_rollback')"
lib_in_fn="$(awk '/^preflight_rollback\(\) \{/{f=1} f && /check_secret_reuse_rollback/{print "yes"} /^\}/{f=0}' <<<"$PREFLIGHT_SRC")"
if [[ -n "$rb_start" && -n "$rb_end" && "$(wc -w <<<"$rb_calls")" == 1 ]] \
   && (( rb_calls > rb_start && rb_calls < rb_end )) && [[ "$fwd_calls" == 2 && "$fwd_in_rb" == 0 && "$lib_calls" == 1 && "$lib_in_fn" == yes ]]; then
  ok "static: preflight_rollback is called once, only inside the --rollback branch; forward and --check call the strict preflight"
else
  bad "static: unexpected preflight dispatch (rollback calls: ${rb_calls:-none}, forward calls: $fwd_calls, rollback lib calls: $lib_calls)"
fi
# Static guard: argument validation is the first executable block - it comes
# before HERE/sourcing and before any git, docker, compose or preflight line -
# and the main dispatch reads MODE, never $1.
argcase_line="$(grep -nE '^case \$# in$' <<<"$DEPLOY_SRC" | head -n1 | cut -d: -f1)"
first_op_line="$(grep -nE '^(HERE=|\. |PREV=|TAG=)|git -C|docker |prd_compose|^[[:space:]]*(preflight|prd_[a-z_]+)([[:space:]]|$)' <<<"$DEPLOY_SRC" \
  | grep -vE '^[0-9]+:[[:space:]]*#' | head -n1 | cut -d: -f1)"
dollar1_after="$(grep -vnE '^[[:space:]]*#' <<<"$DEPLOY_SRC" | awk -F: -v s="${argcase_line:-0}" '$1 > s + 4' \
  | grep -E '"\$\{1:-\}"|\[\[ "\$1"' || true)"
if [[ -n "$argcase_line" && -n "$first_op_line" ]] && (( argcase_line < first_op_line )) && [[ -z "$dollar1_after" ]]; then
  ok "static: argument validation (line $argcase_line) precedes the first operational line ($first_op_line); dispatch uses MODE"
else
  bad "static: argument validation missing or after operational code (case: ${argcase_line:-none}, first op: ${first_op_line:-none}) ${dollar1_after:+/ \$1 dispatch remains}"
fi
if grep -vE '^[[:space:]]*#' <<<"$DEPLOY_SRC" | grep -qE -- '--force|--yes|--skip|--no-preflight'; then
  bad "static: deploy.sh accepts a force/skip style option"
else
  ok "static: no force/skip style option in deploy.sh"
fi
if grep -vE '^[[:space:]]*#' <<<"$DEPLOY_SRC" | grep -qE 'SKIP_|_BYPASS|NO_STAGING|ALLOW_STAGING'; then
  bad "static: deploy.sh contains a bypass-style variable"
else
  ok "static: no bypass-style variable in deploy.sh"
fi

# ---------------------------------------- static docker-call gate (first) ---
# Runs BEFORE any copy of deploy.sh or dc is executed: the dispatch tests below
# rely on every docker call going through PATH (to the stub) and carrying the
# pin. A call by absolute path, through command/env/exec/backslash, or without
# the pin would bypass the stub and could reach a real daemon - so the whole
# suite stops here instead of running it.
echo
echo "static docker-call gate (before any sandbox execution)"
GATE_FILES=(deploy.sh dc lib/preflight.sh lib/secret-reuse.sh lib/prd-root.sh)
gate_src() { sed 's/\r$//' "$HERE/$1" | grep -nvE '^[[:space:]]*#' | grep -vE '^[0-9]+:[[:space:]]*#'; }
docker_lines="$(for f in "${GATE_FILES[@]}"; do
  gate_src "$f" | grep -E '(^|[^_a-zA-Z-])docker[[:space:]]' | grep -v 'fail "' | sed "s|^|$f:|"; done)"
# Every call must be exactly `docker -H "$PRD_DOCKER_HOST"` preceded by start,
# whitespace, '(' or '$(' - not by a path, a backslash or another word.
unpinned="$(grep -vE '(^[0-9]+:|[[:space:](])docker -H "\$PRD_DOCKER_HOST"' <<<"$docker_lines" | grep . || true)"
outside="$(grep -v '^lib/preflight.sh:' <<<"$docker_lines" | grep . || true)"
indirect="$(for f in "${GATE_FILES[@]}"; do
  gate_src "$f" | grep -E '[/\\]docker([[:space:]"'"'"';)]|$)|(command|env|exec|builtin|nohup|xargs|sudo)[[:space:]]+(-[^[:space:]]+[[:space:]]+)*docker([[:space:]]|$)' \
    | grep -vE 'exec docker -H "\$PRD_DOCKER_HOST" compose' | sed "s|^|$f:|"; done)"
gate_ok=1
if [[ -n "$docker_lines" && -z "$unpinned" && -z "$outside" && -z "$indirect" ]]; then
  ok "static gate: every docker call is 'docker -H \"\$PRD_DOCKER_HOST\"' via PATH inside lib/preflight.sh ($(grep -c . <<<"$docker_lines") call sites)"
else
  bad "static gate: unpinned, indirect or out-of-library docker call: $(tr '\n' ';' <<<"$unpinned$outside$indirect")"
  gate_ok=0
fi
if sed 's/\r$//' "$HERE/lib/preflight.sh" | grep -qx 'PRD_DOCKER_HOST=unix:///var/run/docker.sock'; then
  ok "static gate: PRD_DOCKER_HOST is exactly unix:///var/run/docker.sock"
else
  bad "static gate: PRD_DOCKER_HOST is not the approved local socket"
  gate_ok=0
fi
if (( ! gate_ok )); then
  echo "ABORTING before any sandbox execution: an unexpected docker call could bypass the stubs"
  exit 1
fi

SANDBOX="$T/sandbox"
BIN="$T/bin"
mkdir -p "$SANDBOX/deploy/prd/lib" "$BIN"
# CRs stripped so the copy equals the committed (LF) blob on Windows checkouts.
# The REAL deploy.sh, dc, libraries and docker-compose.yml are copied; only
# lib/prd-root.sh (per case) and the docker/git binaries are stand-ins.
sed 's/\r$//' "$HERE/deploy.sh" > "$SANDBOX/deploy/prd/deploy.sh"
sed 's/\r$//' "$HERE/dc" > "$SANDBOX/deploy/prd/dc"
sed 's/\r$//' "$LIB" > "$SANDBOX/deploy/prd/lib/secret-reuse.sh"
sed 's/\r$//' "$HERE/lib/preflight.sh" > "$SANDBOX/deploy/prd/lib/preflight.sh"
sed 's/\r$//' "$HERE/docker-compose.yml" > "$SANDBOX/deploy/prd/docker-compose.yml"

# Stub docker. `docker compose -p .. --env-file .. -f .. <cmd> ...` is logged as
# "dc <cmd> ..." (the pinned project/env-file/file arguments stripped); nothing
# real runs. For deploy.sh: config/ps succeed, `up --no-build` succeeds, build
# exits 97 (forward deploy reached the build stage: stop there), anything else
# 96/98. With DOCKER_STUB_COMPOSE_OK=1 (dc tests) every compose call succeeds.
cat > "$BIN/docker" <<'EOF'
#!/usr/bin/env bash
# Record the daemon target of EVERY call: the -H value (or NONE) and the
# DOCKER_HOST it inherited (or NONE). The tests require both to be the pin.
host=NONE
if [[ "${1:-}" == -H || "${1:-}" == --host ]]; then host="${2:-}"; shift 2; fi
printf '%s %s\n' "$host" "${DOCKER_HOST:-NONE}" >> "$STUB_LOG.hosts"
if [[ "${1:-}" == compose ]]; then
  shift
  while (( $# )); do case "$1" in -p|--env-file|-f) shift 2 ;; *) break ;; esac; done
  printf 'dc %s\n' "$*" >> "$STUB_LOG"
  printf '%s %s\n' "${1:-}" "${IMAGE_TAG:-NONE}" >> "$STUB_LOG.tag"
  # `ps -q` prints one synthetic container id (none with STUB_PS_EMPTY=1, two
  # with STUB_PS_TWO=1, and exits 1 with STUB_PS_FAIL=1).
  if [[ "${1:-}" == ps && " $* " == *" -q "* ]]; then
    [[ "${STUB_PS_FAIL:-0}" == 1 ]] && exit 1
    [[ "${STUB_PS_EMPTY:-0}" != 1 ]] && echo 0123456789abcdef0123
    [[ "${STUB_PS_TWO:-0}" == 1 ]] && echo 0123456789abcdef0456
  fi
  [[ "${DOCKER_STUB_COMPOSE_OK:-0}" == 1 ]] && exit 0
  case "${1:-}" in
    config|ps) exit 0 ;;
    up) [[ " $* " == *" --no-build "* ]] && exit 0; exit 96 ;;
    build) exit 97 ;;
    *) exit 98 ;;
  esac
fi
printf 'docker %s\n' "$*" >> "$STUB_LOG"
# `image inspect` succeeds unless its argument contains STUB_MISSING_IMAGE.
if [[ "${1:-} ${2:-}" == "image inspect" ]]; then
  [[ -n "${STUB_MISSING_IMAGE:-}" && "$*" == *"$STUB_MISSING_IMAGE"* ]] && exit 1
  exit 0
fi
exit 98
EOF
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$STUB_LOG"
case " $* " in
  *" rev-parse "*) echo 0123456789ab ;;
  *" log "*) echo "0123456 synthetic commit" ;;
  *" status "*) : ;;
  *) exit 98 ;;
esac
EOF
chmod +x "$SANDBOX/deploy/prd/dc" "$BIN/docker" "$BIN/git"

# deploy.sh requires `stat -c %a` == 600. Where the filesystem cannot represent
# that mode (NTFS under MSYS reports 644 for everything) a stat stub reports
# 600, or the mode written in "<file>.mode", and defers everything else.
probe="$T/mode-probe"; : > "$probe"; chmod 600 "$probe"
if [[ "$(stat -c %a "$probe" 2>/dev/null)" == 600 ]]; then
  STAT_STUB=0
else
  STAT_STUB=1
  # Modes: "<path>.mode" sidecar, else 700 for a directory and 600 for a file.
  # Owners: "<path>.uid" sidecar, else the real owner. Everything else: real stat.
  cat > "$BIN/stat" <<'EOF'
#!/usr/bin/env bash
deref=()
if [[ "${1:-}" == -L ]]; then deref=(-L); shift; fi
if [[ "${1:-}" == -c && -n "${3:-}" ]]; then
  case "$2" in
    %a) if [[ -f "$3.mode" ]]; then cat "$3.mode"; elif [[ -d "$3" ]]; then echo 700; else echo 600; fi; exit 0 ;;
    %u) if [[ -f "$3.uid" ]]; then cat "$3.uid"; exit 0; fi ;;
  esac
fi
PATH="$STUB_ORIG_PATH" exec stat "${deref[@]}" "$@"
EOF
  chmod +x "$BIN/stat"
  echo "  NOTE  filesystem does not keep chmod 600; file-mode check exercised via stat stub"
fi
set_mode() { chmod "$2" "$1"; (( STAT_STUB )) && echo "$2" > "$1.mode"; return 0; }

# A non-root user cannot create files owned by someone else, so a few owner
# cases are EMULATED (labelled as such): this stub reports "<path>.uid" for
# `stat -c %u` and defers everything else to the stub above / the real stat.
OWNERBIN="$T/ownerbin"
mkdir -p "$OWNERBIN"
cat > "$OWNERBIN/stat" <<'EOF'
#!/usr/bin/env bash
args=("$@"); [[ "${args[0]:-}" == -L ]] && args=("${args[@]:1}")
if [[ "${args[0]:-}" == -c && "${args[1]:-}" == %u && -f "${args[2]:-}.uid" ]]; then
  cat "${args[2]}.uid"; exit 0
fi
PATH="$STUB_BIN:$STUB_ORIG_PATH" exec stat "$@"
EOF
chmod +x "$OWNERBIN/stat"

if [[ "$(PATH="$BIN:$PATH" command -v docker)" == "$BIN/docker" && "$(PATH="$BIN:$PATH" command -v git)" == "$BIN/git" ]]; then
  ok "dispatch: docker and git resolve to stubs"
else
  bad "dispatch: docker/git do not resolve to stubs - aborting dispatch tests"
  exit 1
fi

# Dispatch fixtures: they must pass deploy.sh's own production checks (32+
# alphanumeric passwords, no staging/sandbox words in app.env).
SECRET_VALUES+=(
  PgProdSynthetic000000000000000000000001 OwnerProdSynthetic00000000000000000001
  AppProdSynthetic0000000000000000000001 RedisProdSynthetic00000000000000000001
  RabbitProdSynthetic0000000000000000001
  stg-jwt-access stg-jwt-refresh stg-jwt-admin stg-cookie stg-paxel-api
  stg-paxel-webhook stg-midtrans-key stg-qontak stg-resend
  StgPostgresSynthetic000000000000000001 StgRabbitSynthetic00000000000000000001
)
cat > "$T/d_compose.base" <<'EOF'
POSTGRES_PASSWORD=PgProdSynthetic000000000000000000000001
APP_DB_OWNER_PASSWORD=OwnerProdSynthetic00000000000000000001
APP_DB_APP_PASSWORD=AppProdSynthetic0000000000000000000001
REDIS_PASSWORD=RedisProdSynthetic00000000000000000001
RABBITMQ_PASSWORD=RabbitProdSynthetic0000000000000000001
EOF
cat > "$T/d_staging.env" <<'EOF'
JWT_ACCESS_SECRET=stg-jwt-access
JWT_REFRESH_SECRET=stg-jwt-refresh
JWT_ADMIN_ACCESS_SECRET=stg-jwt-admin
COOKIE_SECRET=stg-cookie
PAXEL_API_SECRET=stg-paxel-api
PAXEL_WEBHOOK_SECRET=stg-paxel-webhook
MIDTRANS_SERVER_KEY=stg-midtrans-key
QONTAK_API_TOKEN=stg-qontak
RESEND_API_KEY=stg-resend
POSTGRES_PASSWORD=StgPostgresSynthetic000000000000000001
RABBITMQ_PASSWORD=StgRabbitSynthetic00000000000000000001
EOF

# new_dcase <name> [extra app.env lines...]
new_dcase() {
  local name="$1"; shift
  DCASE="$T/d_case_$name"
  mkdir -p "$DCASE/conf"
  chmod 700 "$DCASE/conf"          # trusted-root policy: owner-only directory
  cp "$T/app.base" "$DCASE/conf/app.env"
  cp "$T/d_compose.base" "$DCASE/conf/compose.env"
  cp "$T/d_staging.env" "$DCASE/staging.env"
  printf 'IMAGE_TAG=cur000000001\nPREVIOUS_IMAGE_TAG=prev00000001\nDEPLOYED_AT=2026-01-01T00:00:00Z\n' > "$DCASE/conf/release.env"
  local line
  for line in "$@"; do set_kv "$DCASE/conf/app.env" "$line"; done
  set_mode "$DCASE/conf/app.env" 600
  set_mode "$DCASE/conf/compose.env" 600
  # The fixture staging file is selected through the TRUSTED path file in the
  # production config dir - the only supported override.
  printf '%s\n' "$DCASE/staging.env" > "$DCASE/conf/staging-env.path"
  set_mode "$DCASE/conf/staging-env.path" 600
  : > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"; : > "$DCASE/stub.log.tag"
}

# Hashes of every file in the case's conf dir + staging path (release.env is
# reported separately because a successful rollback rewrites it).
snap() {
  local f
  for f in "$DCASE"/conf/* "$DCASE/staging.env"; do
    [[ -f "$f" ]] || continue
    [[ "$f" == */release.env && "${1:-}" == no-release ]] && continue
    if [[ -r "$f" ]]; then
      printf '%s %s\n' "$(sha256sum < "$f" | cut -d' ' -f1)" "${f##*/}"
    else
      # Deliberately unreadable fixture: compare metadata instead of content.
      printf 'unreadable size=%s mtime=%s %s\n' "$(stat -c %s "$f")" "$(stat -c %Y "$f")" "${f##*/}"
    fi
  done
  ls -A "$DCASE" "$DCASE/conf" 2>/dev/null | tr '\n' ' '
}

# run_deploy [deploy.sh args...]. RUN_ENV (array) adds environment entries,
# RUN_BASH_FLAGS (string, e.g. -x) is passed to bash, RUN_PATH_PREFIX is put in
# front of PATH (emulated-owner stub); all default to empty.
#
# The production config root is NOT passed through the environment (deploy.sh
# refuses that): the sandbox copy's lib/prd-root.sh is rewritten to name this
# case's conf dir - the same seam as the stub ./dc. RUN_REAL_ROOT=1 keeps the
# repository's own prd-root.sh (/etc/mas-sular-prd) instead.
RUN_ENV=()
RUN_BASH_FLAGS=""
RUN_PATH_PREFIX=""
RUN_REAL_ROOT=0

# Every docker call a case made must have targeted the pinned daemon: the stub
# recorded "<-H value> <inherited DOCKER_HOST>" per call, and the number of
# records must equal the number of docker calls in the stub log.
PIN="unix:///var/run/docker.sock"
pin_problems() {
  local hosts calls
  hosts="$(cat "$DCASE/stub.log.hosts" 2>/dev/null || true)"
  calls="$(grep -cE '^(dc|docker) ' "$DCASE/stub.log" 2>/dev/null || true)"
  if grep -vxF "$PIN $PIN" <<<"$hosts" | grep -q .; then printf ' docker-not-pinned'; fi
  [[ "$(grep -c . <<<"$hosts")" == "${calls:-0}" ]] || printf ' pin-record-mismatch'
  return 0
}
run_deploy() {
  if (( RUN_REAL_ROOT )); then
    sed 's/\r$//' "$HERE/lib/prd-root.sh" > "$SANDBOX/deploy/prd/lib/prd-root.sh"
  else
    printf 'PRD_TRUSTED_CONF_DIR=%s\n' "$DCASE/conf" > "$SANDBOX/deploy/prd/lib/prd-root.sh"
  fi
  # shellcheck disable=SC2086
  DOUT="$(cd "$DCASE" && env -u IMAGE_TAG -u ALLOW_DIRTY -u STAGING_ENV_FILE -u SHELLOPTS -u PRD_CONF_DIR \
    -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u COMPOSE_PROFILES -u BUILDX_BUILDER -u BUILDX_CONFIG -u KEEP_IMAGES \
    PATH="${RUN_PATH_PREFIX:+$RUN_PATH_PREFIX:}$BIN:$PATH" STUB_ORIG_PATH="$PATH" STUB_BIN="$BIN" STUB_LOG="$DCASE/stub.log" \
    BACKUP_DIR="$DCASE/backups" BACKUP_KEY_FILE="$DCASE/backup.key" \
    MIN_FREE_MB_FOR_BUILD=0 "${RUN_ENV[@]}" \
    bash $RUN_BASH_FLAGS "$SANDBOX/deploy/prd/deploy.sh" "$@" 2>&1)"
  DRC=$?
}

# expect_deploy <label> <fwd-pass|rb-pass|fail> [deploy.sh args...]
expect_deploy() {
  local label="$1" want="$2"; shift 2
  local before_all before_norel after_all after_norel log problems=""
  before_all="$(snap)"; before_norel="$(snap no-release)"
  run_deploy "$@"
  log="$(cat "$DCASE/stub.log")"
  after_all="$(snap)"; after_norel="$(snap no-release)"
  LAST_OUTPUT="$DOUT"
  assert_no_leak "$label (output)" "$DOUT" || return
  assert_no_leak "$label (stub log)" "$log" || return
  problems+="$(pin_problems)"
  [[ -e "$DCASE/backups" ]] && problems+=" backup-dir-created"
  [[ "$log" == *"dc run"* ]] && problems+=" migration-invoked"
  case "$want" in
    fwd-pass)
      (( DRC == 97 )) || problems+=" exit=$DRC(want 97: reached build)"
      [[ "$log" == *"dc config --quiet"* ]] || problems+=" no-compose-config"
      [[ "$log" == *"dc build"* ]] || problems+=" build-not-reached"
      [[ "$log" == *"dc up"* ]] && problems+=" rollout-invoked"
      [[ "$before_all" == "$after_all" ]] || problems+=" files-changed"
      ;;
    rb-pass)
      (( DRC == 0 )) || problems+=" exit=$DRC(want 0)"
      [[ "$DOUT" == *"preflight (rollback)"* ]] || problems+=" rollback-preflight-not-used"
      [[ "$log" == *"dc config --quiet"* ]] || problems+=" no-compose-config"
      [[ "$log" == *"dc up -d --no-build"* ]] || problems+=" no-rollout"
      [[ "$log" == *"dc build"* ]] && problems+=" build-invoked"
      grep -qx 'IMAGE_TAG=prev00000001' "$DCASE/conf/release.env" \
        && grep -qx 'PREVIOUS_IMAGE_TAG=cur000000001' "$DCASE/conf/release.env" \
        || problems+=" release.env-not-recorded"
      [[ "$before_norel" == "$after_norel" ]] || problems+=" non-release-files-changed"
      ;;
    argerr)
      # Rejected command line: exit 2, usage shown, and NOTHING executed - the
      # stub log must stay empty (no dc, docker or git call of any kind).
      (( DRC == 2 )) || problems+=" exit=$DRC(want 2)"
      [[ "$DOUT" == *"ABORT:"* ]] || problems+=" no-ABORT-message"
      [[ "$DOUT" == *"Usage:"* ]] || problems+=" no-usage"
      [[ "$DOUT" == *"==>"* ]] && problems+=" script-progressed"
      [[ -z "$log" ]] || problems+=" commands-invoked($(tr '\n' ';' <<<"$log"))"
      [[ "$before_all" == "$after_all" ]] || problems+=" files-changed"
      ;;
    fail)
      (( DRC == 1 )) || problems+=" exit=$DRC(want 1)"
      [[ "$DOUT" == *"ABORT:"* ]] || problems+=" no-ABORT-message"
      [[ "$log" == *"dc up"* ]] && problems+=" rollout-invoked"
      [[ "$log" == *"dc build"* ]] && problems+=" build-invoked"
      [[ "$before_all" == "$after_all" ]] || problems+=" files-changed"
      ;;
  esac
  if [[ -z "$problems" ]]; then ok "$label"; else bad "$label:$problems"; fi
}

# --- forward deploy (no argument)
new_dcase fwd_valid 'MIDTRANS_ENABLED=false'
expect_deploy "dispatch forward: all files valid -> preflight passes, reaches build" fwd-pass

new_dcase fwd_staging_missing 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"
expect_deploy "dispatch forward: staging missing -> aborts before build" fail
[[ "$LAST_OUTPUT" == *"staging env file is missing"* ]] \
  && ok "dispatch forward: staging-missing abort names the file role" \
  || bad "dispatch forward: staging-missing abort message unclear"

new_dcase fwd_staging_unreadable 'MIDTRANS_ENABLED=false'
if make_unreadable "$DCASE/staging.env"; then
  expect_deploy "dispatch forward: staging unreadable -> aborts" fail
else
  skip "dispatch forward: unreadable staging (chmod 000 has no effect here; directory case below)"
fi

new_dcase fwd_staging_dir 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"; mkdir "$DCASE/staging.env"
expect_deploy "dispatch forward: staging path is a directory -> aborts" fail

new_dcase fwd_staging_malformed 'MIDTRANS_ENABLED=false'
printf 'not an assignment\n' >> "$DCASE/staging.env"
expect_deploy "dispatch forward: staging malformed -> aborts" fail

new_dcase fwd_app_missing 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/conf/app.env" "$DCASE/conf/app.env.mode"
expect_deploy "dispatch forward: production app env missing -> aborts" fail

new_dcase fwd_compose_missing 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/conf/compose.env" "$DCASE/conf/compose.env.mode"
expect_deploy "dispatch forward: production compose env missing -> aborts" fail

new_dcase fwd_app_empty 'MIDTRANS_ENABLED=false'
: > "$DCASE/conf/app.env"
expect_deploy "dispatch forward: production app env empty -> aborts" fail

new_dcase fwd_app_malformed 'MIDTRANS_ENABLED=false'
printf 'JWT_ACCESS_SECRET prod-secret-without-equals\n' >> "$DCASE/conf/app.env"
expect_deploy "dispatch forward: production app env malformed -> aborts" fail

new_dcase fwd_mode_644 'MIDTRANS_ENABLED=false'
set_mode "$DCASE/conf/compose.env" 644
expect_deploy "dispatch forward: compose.env not chmod 600 -> aborts" fail

new_dcase fwd_midtrans_disabled 'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=stg-midtrans-key'
expect_deploy "dispatch forward: MIDTRANS_ENABLED=false + shared Midtrans key -> passes" fwd-pass

new_dcase fwd_midtrans_enabled 'MIDTRANS_ENABLED=true' 'MIDTRANS_IS_PRODUCTION=true' 'MIDTRANS_SERVER_KEY=stg-midtrans-key'
expect_deploy "dispatch forward: MIDTRANS_ENABLED=true + shared Midtrans key -> aborts" fail

new_dcase fwd_qontak_resend 'MIDTRANS_ENABLED=false' 'QONTAK_API_TOKEN=stg-qontak' 'RESEND_API_KEY=stg-resend'
expect_deploy "dispatch forward: shared Qontak + Resend -> passes (unchanged exemption)" fwd-pass

new_dcase fwd_jwt_shared 'MIDTRANS_ENABLED=false' 'JWT_ACCESS_SECRET=stg-jwt-access'
expect_deploy "dispatch forward: shared JWT_ACCESS_SECRET -> aborts" fail

# --- rollback (--rollback)
new_dcase rb_valid 'MIDTRANS_ENABLED=false'
expect_deploy "dispatch rollback: all files valid -> rolls back" rb-pass --rollback

new_dcase rb_staging_missing 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"
expect_deploy "dispatch rollback: staging missing + production valid -> rolls back" rb-pass --rollback
[[ "$LAST_OUTPUT" == *"staging secret-reuse comparison NOT performed"* ]] \
  && ok "dispatch rollback: skipped staging comparison is announced (WARN)" \
  || bad "dispatch rollback: staging comparison skipped silently"

new_dcase rb_staging_dir 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"; mkdir "$DCASE/staging.env"
expect_deploy "dispatch rollback: staging path is a directory -> rolls back with WARN" rb-pass --rollback

new_dcase rb_staging_malformed 'MIDTRANS_ENABLED=false'
printf 'not an assignment\n' >> "$DCASE/staging.env"
expect_deploy "dispatch rollback: staging malformed -> rolls back with WARN" rb-pass --rollback

new_dcase rb_app_missing 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env" "$DCASE/conf/app.env" "$DCASE/conf/app.env.mode"
expect_deploy "dispatch rollback: production app env missing -> aborts" fail --rollback

new_dcase rb_compose_missing 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env" "$DCASE/conf/compose.env" "$DCASE/conf/compose.env.mode"
expect_deploy "dispatch rollback: production compose env missing -> aborts" fail --rollback

new_dcase rb_release_missing 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/conf/release.env"
expect_deploy "dispatch rollback: release.env missing -> aborts" fail --rollback

new_dcase rb_app_empty 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"; : > "$DCASE/conf/app.env"
expect_deploy "dispatch rollback: production app env empty -> aborts" fail --rollback

new_dcase rb_app_malformed 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"
printf 'JWT_ACCESS_SECRET prod-secret-without-equals\n' >> "$DCASE/conf/app.env"
expect_deploy "dispatch rollback: production app env malformed -> aborts" fail --rollback

new_dcase rb_compose_malformed 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"
printf 'POSTGRES_PASSWORD prod-secret-without-equals\n' >> "$DCASE/conf/compose.env"
expect_deploy "dispatch rollback: production compose env malformed -> aborts" fail --rollback

new_dcase rb_mode_644 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"
set_mode "$DCASE/conf/compose.env" 644
expect_deploy "dispatch rollback: compose.env not chmod 600 -> aborts (common checks apply)" fail --rollback

new_dcase rb_placeholder 'MIDTRANS_ENABLED=false' 'SOME_KEY=CHANGE_ME'
rm -f "$DCASE/staging.env"
expect_deploy "dispatch rollback: app.env placeholder -> aborts (common checks apply)" fail --rollback

new_dcase rb_midtrans_disabled 'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=stg-midtrans-key'
expect_deploy "dispatch rollback: MIDTRANS_ENABLED=false + shared Midtrans key -> rolls back" rb-pass --rollback

new_dcase rb_midtrans_enabled 'MIDTRANS_ENABLED=true' 'MIDTRANS_IS_PRODUCTION=true' 'MIDTRANS_SERVER_KEY=stg-midtrans-key'
expect_deploy "dispatch rollback: MIDTRANS_ENABLED=true + shared Midtrans key (staging usable) -> aborts" fail --rollback

new_dcase rb_qontak_resend 'MIDTRANS_ENABLED=true' 'MIDTRANS_IS_PRODUCTION=true' 'QONTAK_API_TOKEN=stg-qontak' 'RESEND_API_KEY=stg-resend'
expect_deploy "dispatch rollback: shared Qontak + Resend -> rolls back (unchanged exemption)" rb-pass --rollback

new_dcase rb_jwt_shared 'MIDTRANS_ENABLED=false' 'JWT_ACCESS_SECRET=stg-jwt-access'
expect_deploy "dispatch rollback: shared JWT_ACCESS_SECRET (staging usable) -> aborts" fail --rollback

# --- command-line validation. Every case uses fully VALID fixtures, so if the
#     argument were ignored the script would run a forward deploy or rollback
#     (exit 97 / 0) instead of being rejected with exit 2.
echo
echo "deploy.sh command-line validation (fail closed)"
bad_args=(
  "--rollbak" "--rollbak=true" "--rollback=true" "--force" "--help" "-r"
  "deploy" "rollback" "" "--" "--ROLLBACK" " --rollback" "--rollback "
)
# expect_abort_line <label> <argc>: the output has exactly ONE ABORT line and it
# is the fixed message - so the rejected value itself is never echoed.
expect_abort_line() {
  local label="$1" argc="$2" lines want
  want="ABORT: invalid command line ($argc argument(s) given); accepted: no argument, exactly --check, or exactly --rollback"
  lines="$(grep '^ABORT:' <<<"$LAST_OUTPUT")"
  if [[ "$lines" == "$want" ]]; then
    ok "$label: fixed ABORT text, argument value not echoed"
  else
    bad "$label: unexpected ABORT output"
  fi
}

i=0
for arg in "${bad_args[@]}"; do
  i=$((i + 1))
  new_dcase "arg_single_$i" 'MIDTRANS_ENABLED=false'
  expect_deploy "cli: unknown argument $(printf '%q' "$arg") -> exit 2, nothing executed" argerr "$arg"
  expect_abort_line "cli: unknown argument $(printf '%q' "$arg")" 1
done

combo_label=(
  "--rollback --force" "--force --rollback" "--rollback --rollback"
  "--rollback extra" "-- --rollback" "--rollback ''"
)
combo_args=(
  "--rollback|--force" "--force|--rollback" "--rollback|--rollback"
  "--rollback|extra" "--|--rollback" "--rollback|"
)
for i in "${!combo_args[@]}"; do
  IFS='|' read -r a1 a2 <<<"${combo_args[$i]}"
  new_dcase "arg_combo_$i" 'MIDTRANS_ENABLED=false'
  expect_deploy "cli: combination ${combo_label[$i]} -> exit 2, nothing executed" argerr "$a1" "$a2"
  expect_abort_line "cli: combination ${combo_label[$i]}" 2
done

new_dcase arg_many 'MIDTRANS_ENABLED=false'
expect_deploy "cli: three arguments -> exit 2, nothing executed" argerr --rollback a b
expect_abort_line "cli: three arguments" 3

# A credential pasted as an argument must never reach the output. These
# synthetic values join SECRET_VALUES, so expect_deploy's leak check fails the
# case if any part of the output contains them.
SECRET_VALUES+=(
  cliPastedTokenSynthetic0000000000000000000000000000000000000001
  cli-pasted-key-synthetic-0002
)
new_dcase arg_secret_positional 'MIDTRANS_ENABLED=false'
expect_deploy "cli: pasted token as positional argument -> exit 2, value not echoed" argerr \
  cliPastedTokenSynthetic0000000000000000000000000000000000000001
expect_abort_line "cli: pasted token as positional argument" 1

new_dcase arg_secret_option 'MIDTRANS_ENABLED=false'
expect_deploy "cli: --key=<pasted key> -> exit 2, value not echoed" argerr \
  --key=cli-pasted-key-synthetic-0002
expect_abort_line "cli: --key=<pasted key>" 1

new_dcase arg_secret_combo 'MIDTRANS_ENABLED=false'
expect_deploy "cli: --rollback + pasted token -> exit 2, value not echoed" argerr \
  --rollback cliPastedTokenSynthetic0000000000000000000000000000000000000001
expect_abort_line "cli: --rollback + pasted token" 2

# Valid forms still dispatch correctly (also covered above).
new_dcase arg_none 'MIDTRANS_ENABLED=false'
expect_deploy "cli: no argument -> forward deploy (reaches build stub)" fwd-pass
new_dcase arg_rollback 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"
expect_deploy "cli: --rollback -> rollback preflight + rollout" rb-pass --rollback

# ------------------------------------------------ secret output redaction ---
echo
echo "secret output redaction (synthetic value must never appear in any output)"
LEAK=SYNTHETIC_SECRET_DO_NOT_LEAK_123
SECRET_VALUES+=("$LEAK")

# expect_keys_only <label> <KEY>: the ABORT context names the key, not a value.
expect_key_named() {
  if [[ "$LAST_OUTPUT" == *"$2"* ]]; then ok "$1: diagnostic names $2"; else bad "$1: diagnostic does not name $2"; fi
}

for mode in fwd rb; do
  args=(); [[ "$mode" == rb ]] && args=(--rollback)

  new_dcase "red_placeholder_$mode" 'MIDTRANS_ENABLED=false' "PAXEL_API_SECRET=${LEAK}_CHANGE_ME"
  expect_deploy "redaction $mode: CHANGE_ME placeholder -> aborts, value hidden" fail "${args[@]}"
  expect_key_named "redaction $mode: CHANGE_ME placeholder" "app.env:5 PAXEL_API_SECRET"

  new_dcase "red_angle_$mode" 'MIDTRANS_ENABLED=false' "PAXEL_WEBHOOK_SECRET=${LEAK}<WEBHOOK_SECRET>"
  expect_deploy "redaction $mode: <PLACEHOLDER> -> aborts, value hidden" fail "${args[@]}"
  expect_key_named "redaction $mode: <PLACEHOLDER>" "PAXEL_WEBHOOK_SECRET"

  new_dcase "red_stagingword_$mode" 'MIDTRANS_ENABLED=false' "COOKIE_SECRET=${LEAK}-staging"
  expect_deploy "redaction $mode: staging word in a value -> aborts, value hidden" fail "${args[@]}"
  expect_key_named "redaction $mode: staging word in a value" "app.env:4 COOKIE_SECRET"

  new_dcase "red_malformed_word_$mode" 'MIDTRANS_ENABLED=false'
  printf 'stage-%s\n' "$LEAK" >> "$DCASE/conf/app.env"
  expect_deploy "redaction $mode: malformed line with stage- word -> aborts, line hidden" fail "${args[@]}"
  expect_key_named "redaction $mode: malformed line with stage- word" "(not a KEY=VALUE line)"

  new_dcase "red_malformed_$mode" 'MIDTRANS_ENABLED=false'
  printf '%s\n' "$LEAK" >> "$DCASE/conf/app.env"
  expect_deploy "redaction $mode: malformed bare-value line -> aborts, line hidden" fail "${args[@]}"
  expect_key_named "redaction $mode: malformed bare-value line" "unparseable line at"

  new_dcase "red_dup_app_$mode" 'MIDTRANS_ENABLED=false'
  printf 'JWT_ACCESS_SECRET=%s\n' "$LEAK" >> "$DCASE/conf/app.env"
  expect_deploy "redaction $mode: duplicate key in app.env -> aborts, value hidden" fail "${args[@]}"
  expect_key_named "redaction $mode: duplicate key in app.env" "assigns JWT_ACCESS_SECRET more than once"

  new_dcase "red_dup_compose_$mode" 'MIDTRANS_ENABLED=false'
  printf 'EXTRA_TOKEN=first\nEXTRA_TOKEN=%s\n' "$LEAK" >> "$DCASE/conf/compose.env"
  expect_deploy "redaction $mode: duplicate key in compose.env -> aborts, value hidden" fail "${args[@]}"
  expect_key_named "redaction $mode: duplicate key in compose.env" "assigns EXTRA_TOKEN more than once"

  new_dcase "red_shared_$mode" 'MIDTRANS_ENABLED=false' "JWT_ADMIN_ACCESS_SECRET=$LEAK"
  set_kv "$DCASE/staging.env" "JWT_ADMIN_ACCESS_SECRET=$LEAK"
  expect_deploy "redaction $mode: shared secret with staging -> aborts, value hidden" fail "${args[@]}"
  expect_key_named "redaction $mode: shared secret with staging" "JWT_ADMIN_ACCESS_SECRET is the SAME as staging"
done

# Duplicates in the STAGING file are tolerated (it belongs to the staging
# stack), but EVERY assignment is compared, so an earlier value cannot hide.
new_dcase red_staging_dup_fwd 'MIDTRANS_ENABLED=false' "JWT_REFRESH_SECRET=$LEAK"
printf 'JWT_REFRESH_SECRET=%s\nJWT_REFRESH_SECRET=stg-later-value\n' "$LEAK" >> "$DCASE/staging.env"
expect_deploy "staging duplicate key: earlier assignment matching production -> aborts" fail
expect_key_named "staging duplicate key" "JWT_REFRESH_SECRET is the SAME as staging"

new_case fn_staging_dup 'MIDTRANS_ENABLED=false' 'JWT_REFRESH_SECRET=staging-jwt-refresh'
printf 'JWT_REFRESH_SECRET=staging-later-value\n' >> "$CASE/staging.env"
expect "function: staging duplicate key, first value shared -> rejected" reject
expect_rb "function rollback: staging duplicate key, first value shared -> rejected" reject

# Shell tracing cannot expose values: deploy.sh switches xtrace off first.
new_dcase red_xtrace_flag 'MIDTRANS_ENABLED=false' "PAXEL_API_SECRET=$LEAK"
RUN_BASH_FLAGS="-x"
expect_deploy "redaction: bash -x deploy.sh (valid config) -> passes, value never traced" fwd-pass
RUN_BASH_FLAGS=""
[[ "$LAST_OUTPUT" == *"+ set +x"* ]] && ok "redaction: tracing was really on before set +x" \
  || bad "redaction: bash -x did not trace - the xtrace test proves nothing"

new_dcase red_xtrace_env 'MIDTRANS_ENABLED=false' "PAXEL_API_SECRET=$LEAK"
RUN_ENV=(SHELLOPTS=xtrace)
expect_deploy "redaction: exported SHELLOPTS=xtrace -> rolls back, value never traced" rb-pass --rollback
RUN_ENV=()

# --------------------------------------------------- staging path policy ----
echo
echo "staging path integrity (trusted path file only; STAGING_ENV_FILE refused)"
DEFAULT_STAGING=/home/massular/apps/mas-sular/production.env

# Function level, with the stat stub on PATH where the filesystem needs it.
resolve() { ( PATH="${RESOLVE_PATH_PREFIX:+$RESOLVE_PATH_PREFIX:}$BIN:$PATH"; STUB_ORIG_PATH="$STUB_PATH_SAVE"; STUB_BIN="$BIN"; export STUB_ORIG_PATH STUB_BIN
              resolve_staging_env_path "$@" ) 2>&1; }
STUB_PATH_SAVE="$PATH"
new_dcase pol_fn 'MIDTRANS_ENABLED=false'
PCONF="$DCASE/conf"
rm -f "$PCONF/staging-env.path" "$PCONF/staging-env.path.mode"
out="$(resolve "$PCONF" "$DEFAULT_STAGING")"; rc=$?
[[ $rc == 0 && "$out" == "$DEFAULT_STAGING" ]] && ok "policy: no path file -> built-in default staging path" \
  || bad "policy: default path not selected (rc=$rc)"

out="$( ( STAGING_ENV_FILE="$DCASE/staging.env"; export STAGING_ENV_FILE; resolve "$PCONF" "$DEFAULT_STAGING" ) )"; rc=$?
[[ $rc != 0 && "$out" == *"STAGING_ENV_FILE is not supported"* ]] && ok "policy: STAGING_ENV_FILE in the environment -> refused" \
  || bad "policy: STAGING_ENV_FILE was accepted (rc=$rc)"

pol_case() { # pol_case <label> <want ok|refuse> <path-file content> [mode]
  local label="$1" want="$2" content="$3" mode="${4:-600}" out rc
  printf '%s' "$content" > "$PCONF/staging-env.path"
  rm -f "$PCONF/staging-env.path.mode"; set_mode "$PCONF/staging-env.path" "$mode"
  out="$(resolve "$PCONF" "$DEFAULT_STAGING")"; rc=$?
  assert_no_leak "$label" "$out" || return
  if [[ "$want" == ok && $rc == 0 ]] || [[ "$want" == refuse && $rc != 0 && "$out" == *"ABORT:"* ]]; then
    ok "$label"
  else
    bad "$label (want $want, rc=$rc)"
  fi
  POL_OUT="$out"
}
pol_case "policy: valid path file -> accepted" ok "$DCASE/staging.env"$'\n'
[[ "$POL_OUT" == "$DCASE/staging.env" ]] && ok "policy: valid path file -> exactly that path" || bad "policy: wrong path resolved"
pol_case "policy: path file with comment + one path -> accepted" ok "# staging env"$'\n'"$DCASE/staging.env"$'\n'
pol_case "policy: path file chmod 644 -> refused" refuse "$DCASE/staging.env"$'\n' 644
pol_case "policy: empty path file -> refused" refuse ""
pol_case "policy: two path lines -> refused" refuse "$DCASE/staging.env"$'\n'"$DCASE/other.env"$'\n'
pol_case "policy: relative path -> refused" refuse "staging.env"$'\n'
pol_case "policy: '..' component -> refused" refuse "$DCASE/conf/../staging.env"$'\n'
pol_case "policy: path with a space -> refused" refuse "$DCASE/my staging.env"$'\n'
pol_case "policy: secret pasted into path file -> refused, content not shown" refuse "$LEAK"$'\n'
pol_case "policy: path inside the production config dir -> refused" refuse "$PCONF/staging.env"$'\n'
pol_case "policy: path is production app.env -> refused" refuse "$PCONF/app.env"$'\n'
rm -f "$PCONF/staging-env.path" "$PCONF/staging-env.path.mode"; mkdir "$PCONF/staging-env.path"
out="$(resolve "$PCONF" "$DEFAULT_STAGING")"; rc=$?
[[ $rc != 0 ]] && ok "policy: path file is a directory -> refused" || bad "policy: directory path file accepted"
rmdir "$PCONF/staging-env.path"
if ln "$PCONF/app.env" "$T/hardlink-app.env" 2>/dev/null && [[ "$T/hardlink-app.env" -ef "$PCONF/app.env" ]]; then
  pol_case "policy: path is a hard link to production app.env -> refused" refuse "$T/hardlink-app.env"$'\n'
else
  skip "policy: hard link to app.env (hard links not available here; inside-config-dir case covers the direct path)"
fi

# Dispatch: the policy is enforced by deploy.sh itself, before any command.
expect_nothing_ran() {
  if [[ -z "$(cat "$DCASE/stub.log")" ]]; then ok "$1: aborted before git/docker/compose"; else bad "$1: commands ran before the abort"; fi
}
for mode in fwd rb; do
  args=(); [[ "$mode" == rb ]] && args=(--rollback)
  new_dcase "pol_envvar_$mode" 'MIDTRANS_ENABLED=false'
  RUN_ENV=(STAGING_ENV_FILE="$DCASE/staging.env")
  expect_deploy "dispatch $mode: STAGING_ENV_FILE set (even to a valid file) -> aborts" fail "${args[@]}"
  RUN_ENV=()
  expect_nothing_ran "dispatch $mode: STAGING_ENV_FILE set"

  new_dcase "pol_badfile_$mode" 'MIDTRANS_ENABLED=false'
  printf 'staging.env\n' > "$DCASE/conf/staging-env.path"
  expect_deploy "dispatch $mode: invalid trusted path file -> aborts" fail "${args[@]}"
  expect_nothing_ran "dispatch $mode: invalid trusted path file"

  new_dcase "pol_samefile_$mode" 'MIDTRANS_ENABLED=false'
  if ln "$DCASE/conf/app.env" "$DCASE/app-link.env" 2>/dev/null && [[ "$DCASE/app-link.env" -ef "$DCASE/conf/app.env" ]]; then
    printf '%s\n' "$DCASE/app-link.env" > "$DCASE/conf/staging-env.path"
    expect_deploy "dispatch $mode: staging path is production app.env (hard link) -> aborts" fail "${args[@]}"
  else
    skip "dispatch $mode: staging path = app.env hard link (hard links not available here)"
  fi
done

# An arbitrary non-staging file (no staging role keys) is never accepted as
# the staging copy: forward aborts, rollback WARNs that it did NOT compare.
new_dcase pol_arbitrary_fwd 'MIDTRANS_ENABLED=false'
printf 'SOME_SETTING=1\n' > "$DCASE/staging.env"
expect_deploy "dispatch forward: trusted path -> arbitrary non-staging file -> aborts" fail
expect_key_named "dispatch forward: arbitrary non-staging file" "does not assign JWT_ACCESS_SECRET"

new_dcase pol_arbitrary_rb 'MIDTRANS_ENABLED=false'
printf 'SOME_SETTING=1\n' > "$DCASE/staging.env"
expect_deploy "dispatch rollback: trusted path -> arbitrary non-staging file -> rolls back with WARN" rb-pass --rollback
expect_skip_warn "dispatch rollback: arbitrary non-staging file"

new_case fn_role_missing 'MIDTRANS_ENABLED=false'
grep -v '^RABBITMQ_PASSWORD=' "$CASE/staging.env" > "$CASE/s.tmp"; cat "$CASE/s.tmp" > "$CASE/staging.env"
expect "function: staging file without RABBITMQ_PASSWORD -> rejected (not a staging file)" reject
expect_rb "function rollback: staging file without RABBITMQ_PASSWORD -> allowed with WARN" allow
expect_skip_warn "function rollback: staging file without a role key"

new_case fn_staging_is_app 'MIDTRANS_ENABLED=false'
if out="$(check_secret_reuse_rollback "$CASE/app.env" "$CASE/app.env" "$CASE/compose.env" 2>&1)"; then
  bad "function rollback: staging path = production app.env -> accepted"
else
  ok "function rollback: staging path = production app.env -> rejected (wrong role)"
fi
if out="$(check_secret_reuse "$CASE/app.env" "$CASE/compose.env" "$CASE/compose.env" 2>&1)"; then
  bad "function forward: staging path = production compose.env -> accepted"
else
  ok "function forward: staging path = production compose.env -> rejected"
fi

# The built-in default is what deploy.sh uses without a path file.
if [[ -e "$DEFAULT_STAGING" ]]; then
  skip "dispatch: default staging path exists on this machine - default-path dispatch cases not run"
else
  new_dcase pol_default_fwd 'MIDTRANS_ENABLED=false'
  rm -f "$DCASE/conf/staging-env.path" "$DCASE/conf/staging-env.path.mode"
  expect_deploy "dispatch forward: no path file -> compares against the default path (missing here) -> aborts" fail
  expect_key_named "dispatch forward: default path" "staging env file is missing: $DEFAULT_STAGING"

  new_dcase pol_default_rb 'MIDTRANS_ENABLED=false'
  rm -f "$DCASE/conf/staging-env.path" "$DCASE/conf/staging-env.path.mode"
  expect_deploy "dispatch rollback: no path file, default staging unavailable -> rolls back with WARN" rb-pass --rollback
  expect_skip_warn "dispatch rollback: default path unavailable"
  expect_key_named "dispatch rollback: default path" "$DEFAULT_STAGING"
fi

if grep -vE '^[[:space:]]*#' <<<"$(sed 's/\r$//' "$HERE/deploy.sh")" | grep -q 'STAGING_ENV_FILE:-'; then
  bad "static: deploy.sh still reads STAGING_ENV_FILE as an override"
else
  ok "static: deploy.sh no longer reads STAGING_ENV_FILE as an override"
fi

# ------------------------------------------------ trusted config root -------
echo
echo "trusted production config root (lib/prd-root.sh; PRD_CONF_DIR cannot redirect it)"

repo_root_line="$(sed 's/\r$//' "$HERE/lib/prd-root.sh" | grep -vE '^[[:space:]]*(#|$)')"
[[ "$repo_root_line" == "PRD_TRUSTED_CONF_DIR=/etc/mas-sular-prd" ]] \
  && ok "static: repository lib/prd-root.sh names exactly /etc/mas-sular-prd" \
  || bad "static: repository lib/prd-root.sh does not name exactly /etc/mas-sular-prd"
if sed 's/\r$//' "$HERE/deploy.sh" "$HERE/dc" "$HERE/lib/preflight.sh" | grep -vE '^[[:space:]]*#' | grep -q 'PRD_CONF_DIR:-'; then
  bad "static: deploy.sh, dc or lib/preflight.sh still takes PRD_CONF_DIR as a default-able override"
else
  ok "static: deploy.sh, dc and lib/preflight.sh no longer take PRD_CONF_DIR as an override"
fi

for mode in fwd rb; do
  args=(); [[ "$mode" == rb ]] && args=(--rollback)
  # The trusted config shares JWT_ACCESS_SECRET with staging (forward would
  # abort). A copied config dir whose staging-env.path names a forged staging
  # file would hide that - if PRD_CONF_DIR were followed.
  new_dcase "root_copy_$mode" 'MIDTRANS_ENABLED=false' 'JWT_ACCESS_SECRET=stg-jwt-access'
  cp -r "$DCASE/conf" "$DCASE/copy"; chmod 700 "$DCASE/copy"
  sed 's/stg-jwt-access/stg-forged-0001/' "$DCASE/staging.env" > "$DCASE/forged-staging.env"
  printf '%s\n' "$DCASE/forged-staging.env" > "$DCASE/copy/staging-env.path"; set_mode "$DCASE/copy/staging-env.path" 600
  RUN_ENV=(PRD_CONF_DIR="$DCASE/copy")
  expect_deploy "root $mode: PRD_CONF_DIR -> copied config dir with forged staging -> aborts" fail "${args[@]}"
  RUN_ENV=()
  expect_nothing_ran "root $mode: PRD_CONF_DIR -> copied config dir"
  expect_key_named "root $mode: PRD_CONF_DIR -> copied config dir" "PRD_CONF_DIR override is not supported"
done

new_dcase root_same 'MIDTRANS_ENABLED=false'
RUN_ENV=(PRD_CONF_DIR="$DCASE/conf")
expect_deploy "root: PRD_CONF_DIR equal to the trusted root -> accepted (forward reaches build)" fwd-pass
RUN_ENV=()

if [[ -e /etc/mas-sular-prd ]]; then
  skip "root: /etc/mas-sular-prd exists on this machine - real-default-root case not run"
else
  new_dcase root_real_default 'MIDTRANS_ENABLED=false'
  RUN_REAL_ROOT=1
  expect_deploy "root: PRD_CONF_DIR unset + repository prd-root.sh -> uses /etc/mas-sular-prd (missing here) -> aborts" fail
  RUN_REAL_ROOT=0
  expect_nothing_ran "root: real default root missing"
  expect_key_named "root: real default root" "trusted config root /etc/mas-sular-prd is missing"
fi

# verify_trusted_conf_root, function level.
vroot() { ( PATH="${VROOT_PATH_PREFIX:+$VROOT_PATH_PREFIX:}$BIN:$PATH"; STUB_ORIG_PATH="$STUB_PATH_SAVE"; STUB_BIN="$BIN"
            export STUB_ORIG_PATH STUB_BIN; verify_trusted_conf_root "$1" ) 2>&1; }
vexpect() { # vexpect <label> <ok|refuse> <dir> [needle]
  local out rc=0
  out="$(vroot "$3")" || rc=$?
  if [[ "$2" == ok && $rc == 0 ]] || [[ "$2" == refuse && $rc != 0 && "$out" == *"${4:-ABORT:}"* ]]; then ok "$1"; else bad "$1 (want $2, rc=$rc)"; fi
}
VR="$T/vroot"; mkdir -p "$VR/p_ok/conf"; chmod 700 "$VR/p_ok/conf"
vexpect "root policy: owner-only dir in a safe parent -> accepted" ok "$VR/p_ok/conf"
vexpect "root policy: missing root -> refused" refuse "$VR/p_ok/none" "is missing"
vexpect "root policy: relative root -> refused" refuse "relative/conf" "absolute path"
mkdir -p "$VR/p_755/conf"; set_mode "$VR/p_755/conf" 755
vexpect "root policy: root chmod 755 -> refused" refuse "$VR/p_755/conf" "must be chmod 700"
mkdir -p "$VR/p_ww/conf"; chmod 700 "$VR/p_ww/conf"; set_mode "$VR/p_ww" 777
vexpect "root policy: parent writable by group/others -> refused" refuse "$VR/p_ww/conf" "must not be writable by group or others"
set_mode "$VR/p_ww" 700
mkdir -p "$VR/p_ln/real"; chmod 700 "$VR/p_ln/real"
if ln -s "$VR/p_ln/real" "$VR/p_ln/conf" 2>/dev/null && [[ -L "$VR/p_ln/conf" ]]; then
  vexpect "root policy: root is a symlink -> refused" refuse "$VR/p_ln/conf" "must not be a symlink"
else
  skip "root policy: symlinked root (symlinks not available here)"
fi
if [[ "$(stat -c %u /etc 2>/dev/null)" != "$(id -u)" && -d /etc ]]; then
  vexpect "root policy: root owned by another uid (real: /etc) -> refused" refuse /etc "must be owned by the deploy user"
else
  skip "root policy: real foreign-owner root (/etc is owned by this user here)"
fi
mkdir -p "$VR/p_own/conf"; chmod 700 "$VR/p_own/conf"; echo 4242 > "$VR/p_own/conf.uid"
VROOT_PATH_PREFIX="$OWNERBIN"
vexpect "root policy: root owned by another uid (emulated) -> refused" refuse "$VR/p_own/conf" "must be owned by the deploy user"
rm -f "$VR/p_own/conf.uid"; echo 4242 > "$VR/p_own.uid"
vexpect "root policy: parent owned by another non-root uid (emulated) -> refused" refuse "$VR/p_own/conf" "must be owned by root or the deploy user"
VROOT_PATH_PREFIX=""

for mode in fwd rb; do
  args=(); [[ "$mode" == rb ]] && args=(--rollback)
  new_dcase "root_mode_$mode" 'MIDTRANS_ENABLED=false'
  set_mode "$DCASE/conf" 755
  expect_deploy "dispatch $mode: trusted root chmod 755 -> aborts" fail "${args[@]}"
  expect_nothing_ran "dispatch $mode: trusted root chmod 755"
done

# The real ./dc honours the same root and refuses PRD_CONF_DIR overrides.
DCBOX="$T/dcbox"; mkdir -p "$DCBOX/deploy/prd/lib" "$DCBOX/conf" "$DCBOX/bin"; chmod 700 "$DCBOX/conf"
sed 's/\r$//' "$HERE/dc" > "$DCBOX/deploy/prd/dc"; chmod +x "$DCBOX/deploy/prd/dc"
sed 's/\r$//' "$LIB" > "$DCBOX/deploy/prd/lib/secret-reuse.sh"
sed 's/\r$//' "$HERE/lib/preflight.sh" > "$DCBOX/deploy/prd/lib/preflight.sh"
printf 'PRD_TRUSTED_CONF_DIR=%s\n' "$DCBOX/conf" > "$DCBOX/deploy/prd/lib/prd-root.sh"
: > "$DCBOX/deploy/prd/docker-compose.yml"
printf 'POSTGRES_PASSWORD=x\n' > "$DCBOX/conf/compose.env"
cat > "$DCBOX/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf 'docker %s | PRD_CONF_DIR=%s\n' "$*" "${PRD_CONF_DIR:-}" >> "$DC_LOG"
EOF
chmod +x "$DCBOX/bin/docker"
DC_LOG="$DCBOX/docker.log"; : > "$DC_LOG"
out="$(env -u PRD_CONF_DIR -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u COMPOSE_PROFILES PATH="$DCBOX/bin:$PATH" DC_LOG="$DC_LOG" bash "$DCBOX/deploy/prd/dc" ps 2>&1)"; rc=$?
dlog="$(cat "$DC_LOG")"
if [[ $rc == 0 && "$dlog" == "docker -H unix:///var/run/docker.sock compose "* && "$dlog" == *"--env-file $DCBOX/conf/compose.env"* &&"$dlog" == *"PRD_CONF_DIR=$DCBOX/conf" ]]; then
  ok "dc: PRD_CONF_DIR unset -> trusted root env files, trusted root exported to compose"
else
  bad "dc: trusted-root invocation wrong (rc=$rc)"
fi
: > "$DC_LOG"
out="$(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u COMPOSE_PROFILES PRD_CONF_DIR="$T/elsewhere" PATH="$DCBOX/bin:$PATH" DC_LOG="$DC_LOG" bash "$DCBOX/deploy/prd/dc" ps 2>&1)"; rc=$?
if [[ $rc != 0 && "$out" == *"PRD_CONF_DIR override is not supported"* && ! -s "$DC_LOG" ]]; then
  ok "dc: PRD_CONF_DIR -> other dir -> refused, docker never called"
else
  bad "dc: PRD_CONF_DIR override not refused (rc=$rc)"
fi

# ------------------------------------------------ trusted path integrity ---
echo
echo "trusted staging path integrity (path file, staging file trust, symlinks)"
new_dcase tpi 'MIDTRANS_ENABLED=false'
PCONF="$DCASE/conf"
printf '%s\n' "$DCASE/staging.env" > "$T/real-path-file"
rm -f "$PCONF/staging-env.path" "$PCONF/staging-env.path.mode"
if ln -s "$T/real-path-file" "$PCONF/staging-env.path" 2>/dev/null && [[ -L "$PCONF/staging-env.path" ]]; then
  out="$(resolve "$PCONF" "$DEFAULT_STAGING")"; rc=$?
  [[ $rc != 0 && "$out" == *"must not be a symlink"* ]] && ok "path file: symlinked staging-env.path -> refused" \
    || bad "path file: symlinked staging-env.path accepted (rc=$rc)"
else
  skip "path file: symlinked staging-env.path (symlinks not available here)"
fi
rm -f "$PCONF/staging-env.path"
printf '%s\n' "$DCASE/staging.env" > "$PCONF/staging-env.path"; set_mode "$PCONF/staging-env.path" 600
echo 4242 > "$PCONF/staging-env.path.uid"
RESOLVE_PATH_PREFIX="$OWNERBIN"
out="$(resolve "$PCONF" "$DEFAULT_STAGING")"; rc=$?
RESOLVE_PATH_PREFIX=""
rm -f "$PCONF/staging-env.path.uid"
[[ $rc != 0 && "$out" == *"must be owned by the deploy user"* ]] && ok "path file: owned by another uid (emulated) -> refused" \
  || bad "path file: foreign-owned staging-env.path accepted (rc=$rc)"

: > "$PCONF/notes.txt"
if ln -s "$PCONF/notes.txt" "$DCASE/into-root.env" 2>/dev/null && [[ -L "$DCASE/into-root.env" ]]; then
  pol_case "path file: staging path is a symlink into the config root -> refused" refuse "$DCASE/into-root.env"$'\n'
else
  skip "path file: symlink into the config root (symlinks not available here)"
fi
# Only the canonical (realpath) containment check catches these two: the
# same-file loop sees neither a file in a SUBdirectory nor a dangling target.
mkdir -p "$PCONF/sub"; : > "$PCONF/sub/inner.env"
if ln -s "$PCONF/sub/inner.env" "$DCASE/into-subdir.env" 2>/dev/null && [[ -L "$DCASE/into-subdir.env" ]]; then
  pol_case "path file: staging path is a symlink into a SUBdirectory of the root -> refused" refuse "$DCASE/into-subdir.env"$'\n'
  [[ "$POL_OUT" == *"resolves inside"* ]] && ok "path file: subdirectory symlink refused by the canonical containment rule" \
    || bad "path file: subdirectory symlink not refused by canonical containment"
else
  skip "path file: symlink into a root subdirectory (symlinks not available here)"
fi
if ln -s "$PCONF/not-yet-there.env" "$DCASE/dangling.env" 2>/dev/null && [[ -L "$DCASE/dangling.env" ]]; then
  pol_case "path file: staging path is a dangling symlink into the root -> refused" refuse "$DCASE/dangling.env"$'\n'
else
  skip "path file: dangling symlink into the root (symlinks not available here)"
fi
rm -rf "$PCONF/sub"
if ln "$PCONF/notes.txt" "$DCASE/hardlink-notes.env" 2>/dev/null && [[ "$DCASE/hardlink-notes.env" -ef "$PCONF/notes.txt" ]]; then
  pol_case "path file: staging path is a hard link to ANY file in the root -> refused" refuse "$DCASE/hardlink-notes.env"$'\n'
else
  skip "path file: hard link to a root file (hard links not available here)"
fi
rm -f "$PCONF/notes.txt"

# Six role keys alone do not make a file trusted: owner and write bits count.
for mode in fwd rb; do
  args=(); want=fail; [[ "$mode" == rb ]] && { args=(--rollback); want=rb-pass; }
  new_dcase "trust_ww_$mode" 'MIDTRANS_ENABLED=false'
  set_mode "$DCASE/staging.env" 666
  expect_deploy "staging file $mode: has all role keys but is world-writable -> $( [[ $mode == fwd ]] && echo aborts || echo 'rolls back with WARN')" "$want" "${args[@]}"
  expect_key_named "staging file $mode: world-writable" "writable by group or others"

  new_dcase "trust_owner_$mode" 'MIDTRANS_ENABLED=false'
  echo 4242 > "$DCASE/staging.env.uid"
  RUN_PATH_PREFIX="$OWNERBIN"
  expect_deploy "staging file $mode: has all role keys but foreign owner (emulated) -> $( [[ $mode == fwd ]] && echo aborts || echo 'rolls back with WARN')" "$want" "${args[@]}"
  RUN_PATH_PREFIX=""
  expect_key_named "staging file $mode: foreign owner" "is owned by uid 4242"
done
expect_skip_warn "staging file rb: foreign owner"

# ------------------------------------------------ value canonicalization ----
echo
echo "env value canonicalization (KEY=v, KEY=\"v\", KEY='v' are one secret; ambiguous fails closed)"
new_case can_dq_app 'MIDTRANS_ENABLED=false' 'JWT_ACCESS_SECRET="staging-jwt-access"'
expect "canon: app \"double-quoted\" == staging plain -> rejected (shared)" reject
new_case can_sq_app 'MIDTRANS_ENABLED=false' "JWT_ACCESS_SECRET='staging-jwt-access'"
expect "canon: app 'single-quoted' == staging plain -> rejected (shared)" reject
new_case can_dq_staging 'MIDTRANS_ENABLED=false'
set_kv "$CASE/staging.env" 'COOKIE_SECRET="prod-cookie"'
expect "canon: staging \"double-quoted\" == app plain -> rejected (shared)" reject
expect_rb "canon rollback: staging \"double-quoted\" == app plain -> rejected (shared)" reject
new_case can_sq_comment_staging 'MIDTRANS_ENABLED=false'
set_kv "$CASE/staging.env" "PAXEL_WEBHOOK_SECRET='prod-paxel-webhook'  # rotated"
expect "canon: staging 'quoted' + comment == app plain -> rejected (shared)" reject
new_case can_comment_app 'MIDTRANS_ENABLED=false' 'JWT_REFRESH_SECRET=staging-jwt-refresh # rotated?'
expect "canon: app plain + inline comment == staging -> rejected (shared)" reject
new_case can_compose_dq 'MIDTRANS_ENABLED=false'
set_kv "$CASE/compose.env" 'RABBITMQ_PASSWORD="staging-rabbitmq"'
expect "canon: compose \"quoted\" == staging plain -> rejected (shared)" reject
new_case can_mt_false_dq 'MIDTRANS_ENABLED="false"' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "canon: MIDTRANS_ENABLED=\"false\" + shared Midtrans key -> allowed (canonical false)" allow
new_case can_mt_true_sq "MIDTRANS_ENABLED='true'" 'MIDTRANS_SERVER_KEY="SB-Mid-server-STAGING"'
expect "canon: MIDTRANS_ENABLED='true' + quoted shared Midtrans key -> rejected" reject
new_case can_qontak_dq 'MIDTRANS_ENABLED=false' 'QONTAK_API_TOKEN="staging-qontak"' "RESEND_API_KEY='staging-resend'"
expect "canon: quoted shared Qontak/Resend -> allowed (exemption unchanged)" allow
new_case can_dup_staging_quoted 'MIDTRANS_ENABLED=false'
printf 'JWT_ADMIN_ACCESS_SECRET="prod-jwt-admin"\n' >> "$CASE/staging.env"
expect "canon: staging duplicate, quoted copy == app -> rejected" reject

# Empty and whitespace-only values are "not set" and never match.
new_case can_empty 'MIDTRANS_ENABLED=false' 'PAXEL_API_SECRET='
set_kv "$CASE/staging.env" 'PAXEL_API_SECRET='
expect "canon: empty value on both sides -> allowed (nothing to compare)" allow
new_case can_ws_only 'MIDTRANS_ENABLED=false' 'PAXEL_API_SECRET=   '
set_kv "$CASE/staging.env" 'PAXEL_API_SECRET=""'
expect "canon: whitespace-only vs \"\" -> allowed (both empty)" allow
new_case can_role_ws 'MIDTRANS_ENABLED=false'
set_kv "$CASE/staging.env" 'RABBITMQ_PASSWORD="   "'
expect "canon: staging role key whitespace-only -> rejected (not a staging file)" reject
expect_rb "canon rollback: staging role key whitespace-only -> allowed with WARN" allow
expect_skip_warn "canon rollback: staging role key whitespace-only"

# Ambiguous / unsupported syntax in a key the guard reads fails closed and
# never prints the value - in production on BOTH paths.
amb_vals=(
  "\"${LEAK}"            # unterminated quote
  "\"${LEAK}\"tail"      # text after the closing quote
  "${LEAK}\$HOME"        # interpolation
  "\"${LEAK}\${X}\""     # interpolation inside double quotes
  "${LEAK}\\n"           # backslash
  "'${LEAK}\\n'"         # backslash inside single quotes
  " ${LEAK}"             # leading space
  "${LEAK}#frag"         # '#' without a preceding space
  "${LEAK}\`id\`"        # backtick
  "${LEAK}\"mid"         # stray quote
)
i=0
for amb in "${amb_vals[@]}"; do
  i=$((i + 1))
  new_case "can_amb_$i" 'MIDTRANS_ENABLED=false' "JWT_ACCESS_SECRET=$amb"
  expect "canon: ambiguous production value #$i -> rejected, value hidden" reject
  expect_key_named "canon: ambiguous production value #$i" "JWT_ACCESS_SECRET has unsupported or ambiguous value syntax"
  rm -f "$CASE/staging.env"
  expect_rb "canon rollback: ambiguous production value #$i (staging missing) -> rejected" reject
done

new_case can_amb_staging 'MIDTRANS_ENABLED=false'
set_kv "$CASE/staging.env" "COOKIE_SECRET=\"${LEAK}"
expect "canon: ambiguous staging value in a compared key -> rejected" reject
expect_rb "canon rollback: ambiguous staging value in a compared key -> allowed with WARN" allow
expect_skip_warn "canon rollback: ambiguous staging value"

new_case can_unrelated 'MIDTRANS_ENABLED=false'
printf 'APP_NAME="Bakso $X \\ %s\n' "$LEAK" >> "$CASE/staging.env"
printf 'SOME_LABEL="unterminated\n' >> "$CASE/app.env"
expect "canon: odd syntax in keys the guard does not read -> not interpreted, allowed" allow
expect_rb "canon rollback: odd syntax in unread keys -> allowed" allow
[[ "$LAST_OUTPUT" != *"NOT performed"* ]] && ok "canon rollback: unread-key syntax does not make staging unusable" \
  || bad "canon rollback: unread-key syntax wrongly skipped the comparison"

# Dispatch: deploy.sh's own flag checks read canonical values too.
new_dcase can_flag_quoted 'MIDTRANS_ENABLED="true"'
expect_deploy "dispatch: MIDTRANS_ENABLED=\"true\" without MIDTRANS_IS_PRODUCTION -> aborts (quote no longer hides it)" fail
expect_key_named "dispatch: quoted MIDTRANS_ENABLED" "requires MIDTRANS_IS_PRODUCTION=true"
new_dcase can_flag_amb "MIDTRANS_ENABLED=\"${LEAK}\$X\""
expect_deploy "dispatch: ambiguous MIDTRANS_ENABLED -> aborts, value hidden" fail
expect_key_named "dispatch: ambiguous MIDTRANS_ENABLED" "MIDTRANS_ENABLED has unsupported or ambiguous value syntax"
for mode in fwd rb; do
  args=(); [[ "$mode" == rb ]] && args=(--rollback)
  new_dcase "can_shared_dq_$mode" 'MIDTRANS_ENABLED=false' "JWT_ACCESS_SECRET=\"$LEAK\""
  set_kv "$DCASE/staging.env" "JWT_ACCESS_SECRET='$LEAK'"
  expect_deploy "dispatch $mode: \"quoted\" app vs 'quoted' staging, same secret -> aborts, value hidden" fail "${args[@]}"
  expect_key_named "dispatch $mode: quoted shared secret" "JWT_ACCESS_SECRET is the SAME as staging"
done
new_dcase can_compose_pw_dq 'MIDTRANS_ENABLED=false'
set_kv "$DCASE/conf/compose.env" 'POSTGRES_PASSWORD="PgProdSynthetic000000000000000000000001"'
expect_deploy "dispatch: compose password in double quotes -> canonical value passes the 32-alnum check" fwd-pass
new_dcase can_compose_pw_shared 'MIDTRANS_ENABLED=false'
set_kv "$DCASE/conf/compose.env" 'POSTGRES_PASSWORD="PgProdSynthetic000000000000000000000001"'
set_kv "$DCASE/staging.env" 'POSTGRES_PASSWORD=PgProdSynthetic000000000000000000000001'
expect_deploy "dispatch: quoted compose password == staging plain -> aborts" fail
expect_key_named "dispatch: quoted compose password shared" "POSTGRES_PASSWORD is the SAME as staging"

# ------------------------------------------------ deploy.sh --check ---------
echo
echo "deploy.sh --check (preflight only: nothing built, migrated, backed up or started)"

# expect_check <label> <pass|fail>: the ONLY compose call allowed is the
# read-only `config --quiet` inside the preflight; no git, no image, no backup.
expect_check() {
  local label="$1" want="$2" before after log others problems=""
  before="$(snap)"
  run_deploy --check
  after="$(snap)"
  log="$(cat "$DCASE/stub.log")"
  LAST_OUTPUT="$DOUT"
  assert_no_leak "$label (output)" "$DOUT" || return
  assert_no_leak "$label (stub log)" "$log" || return
  problems+="$(pin_problems)"
  others="$(grep -vx 'dc config --quiet' <<<"$log" | grep -v '^$' || true)"
  [[ -z "$others" ]] || problems+=" unexpected-commands($(tr '\n' ';' <<<"$others"))"
  [[ -e "$DCASE/backups" ]] && problems+=" backup-dir-created"
  [[ "$before" == "$after" ]] || problems+=" files-changed"
  if [[ "$want" == pass ]]; then
    (( DRC == 0 )) || problems+=" exit=$DRC(want 0)"
    [[ "$log" == *"dc config --quiet"* ]] || problems+=" compose-config-not-validated"
    [[ "$DOUT" == *"preflight OK"* ]] || problems+=" no-OK-message"
  else
    (( DRC == 1 )) || problems+=" exit=$DRC(want 1)"
    [[ "$DOUT" == *"ABORT:"* ]] || problems+=" no-ABORT-message"
  fi
  if [[ -z "$problems" ]]; then ok "$label"; else bad "$label:$problems"; fi
}

new_dcase chk_valid 'MIDTRANS_ENABLED=false'
expect_check "--check: valid synthetic configuration -> exit 0, only 'config --quiet' ran" pass
new_dcase chk_placeholder 'MIDTRANS_ENABLED=false' "PAXEL_API_SECRET=${LEAK}_CHANGE_ME"
expect_check "--check: invalid production config (placeholder) -> fails, value hidden" fail
new_dcase chk_shared 'MIDTRANS_ENABLED=false' "JWT_ACCESS_SECRET=$LEAK"
set_kv "$DCASE/staging.env" "JWT_ACCESS_SECRET='$LEAK'"
expect_check "--check: shared secret with staging -> fails, value hidden" fail
expect_key_named "--check: shared secret" "JWT_ACCESS_SECRET is the SAME as staging"
new_dcase chk_staging_missing 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"
expect_check "--check: staging env missing -> fails (strict forward policy, no WARN-and-continue)" fail
new_dcase chk_staging_bad 'MIDTRANS_ENABLED=false'
printf 'not an assignment\n' >> "$DCASE/staging.env"
expect_check "--check: staging env malformed -> fails" fail
new_dcase chk_root 'MIDTRANS_ENABLED=false'
set_mode "$DCASE/conf" 755
expect_check "--check: trusted root chmod 755 -> fails" fail
new_dcase chk_envvar 'MIDTRANS_ENABLED=false'
RUN_ENV=(RABBITMQ_PASSWORD=RabbitShellOverride00000000000000000001)
expect_check "--check: compose variable exported in the shell -> fails (would override compose.env)" fail
RUN_ENV=()
expect_key_named "--check: compose variable exported" "environment variable RABBITMQ_PASSWORD is set"
new_dcase chk_composeenvfiles 'MIDTRANS_ENABLED=false'
RUN_ENV=(COMPOSE_ENV_FILES="$DCASE/other.env")
expect_check "--check: COMPOSE_ENV_FILES exported -> fails" fail
RUN_ENV=()

# ------------------------------------------------ direct dc enforcement -----
echo
echo "deploy/prd/dc: configuration-applying commands run the preflight in-process"

# run_dc [dc args...]: the REAL dc from the sandbox, stub docker (every compose
# call succeeds and is logged as "dc <cmd> ...").
run_dc() {
  printf 'PRD_TRUSTED_CONF_DIR=%s\n' "$DCASE/conf" > "$SANDBOX/deploy/prd/lib/prd-root.sh"
  DOUT="$(cd "$DCASE" && env -u IMAGE_TAG -u STAGING_ENV_FILE -u SHELLOPTS -u PRD_CONF_DIR \
    -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_CONFIG -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u COMPOSE_PROFILES -u BUILDX_BUILDER -u BUILDX_CONFIG -u KEEP_IMAGES \
    PATH="$BIN:$PATH" STUB_ORIG_PATH="$PATH" STUB_BIN="$BIN" STUB_LOG="$DCASE/stub.log" \
    DOCKER_STUB_COMPOSE_OK=1 "${RUN_ENV[@]}" \
    bash "$SANDBOX/deploy/prd/dc" "$@" 2>&1)"
  DRC=$?
}

# expect_dc <label> <ran|refused> <validated|direct> [dc args...]
#   ran:      exit 0 and the compose command itself reached docker
#   refused:  non-zero, ABORT, and NO compose command other than the
#             preflight's `config --quiet` reached docker
#   validated / direct: whether the preflight ran (its "==> preflight" banner)
expect_dc() {
  local label="$1" want="$2" val="$3"; shift 3
  local before after log sub="${1:-}" others problems=""
  before="$(snap)"
  run_dc "$@"
  after="$(snap)"
  log="$(cat "$DCASE/stub.log")"
  LAST_OUTPUT="$DOUT"
  assert_no_leak "$label (output)" "$DOUT" || return
  assert_no_leak "$label (stub log)" "$log" || return
  problems+="$(pin_problems)"
  # Read-only image checks (dc's applying class) are not "commands" here.
  others="$(grep -vx 'dc config --quiet' <<<"$log" | grep -v '^docker image inspect ' | grep -v '^$' || true)"
  [[ "$before" == "$after" ]] || problems+=" files-changed"
  if [[ "$want" == ran ]]; then
    (( DRC == 0 )) || problems+=" exit=$DRC(want 0)"
    [[ "$others" == "dc $sub"* || ( "$sub" == config && "$log" == *"dc config --quiet"* ) ]] || problems+=" command-not-executed"
  else
    (( DRC != 0 )) || problems+=" exit=0(want refusal)"
    [[ "$DOUT" == *"ABORT:"* ]] || problems+=" no-ABORT-message"
    [[ -z "$others" ]] || problems+=" command-reached-docker($(tr '\n' ';' <<<"$others"))"
  fi
  if [[ "$val" == validated ]]; then
    [[ "$DOUT" == *"==> preflight"* ]] || problems+=" preflight-not-run"
  else
    [[ "$DOUT" != *"==> preflight"* ]] || problems+=" unexpected-preflight"
  fi
  if [[ -z "$problems" ]]; then ok "$label"; else bad "$label:$problems"; fi
}

# applying: up / create / run -> STRICT preflight in the same process.
new_dcase dc_up_ok 'MIDTRANS_ENABLED=false'
expect_dc "dc up (valid config) -> strict preflight, then compose up" ran validated up -d --no-deps --force-recreate backend
new_dcase dc_up_shared 'MIDTRANS_ENABLED=false' "JWT_ACCESS_SECRET=$LEAK"
set_kv "$DCASE/staging.env" "JWT_ACCESS_SECRET=$LEAK"
expect_dc "dc up with a secret shared with staging -> refused before compose up, value hidden" refused validated up -d --no-deps --force-recreate backend
new_dcase dc_up_placeholder 'MIDTRANS_ENABLED=false' "COOKIE_SECRET=${LEAK}<COOKIE_SECRET>"
expect_dc "dc up with a placeholder in app.env -> refused" refused validated up -d backend
new_dcase dc_up_nostaging 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"
expect_dc "dc up with staging unavailable -> refused (strict policy)" refused validated up -d backend
new_dcase dc_create_shared 'MIDTRANS_ENABLED=false' "COOKIE_SECRET=$LEAK"
set_kv "$DCASE/staging.env" "COOKIE_SECRET=\"$LEAK\""
expect_dc "dc create with a shared secret -> refused" refused validated create backend
new_dcase dc_run_ok 'MIDTRANS_ENABLED=false'
expect_dc "dc run --rm -e BOOTSTRAP_ADMIN_EMAIL (documented) -> strict preflight, then run" ran validated \
  run --rm -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD backend node dist/prisma/bootstrap-production.js
new_dcase dc_run_seed 'MIDTRANS_ENABLED=false'
expect_dc "dc run --rm backend-migrate <seed command> (documented) -> runs after preflight" ran validated \
  run --rm backend-migrate node node_modules/tsx/dist/cli.mjs prisma/seed-address.ts
new_dcase dc_run_shared 'MIDTRANS_ENABLED=false' "JWT_REFRESH_SECRET=$LEAK"
set_kv "$DCASE/staging.env" "JWT_REFRESH_SECRET=$LEAK"
expect_dc "dc run with a shared secret -> refused" refused validated run --rm backend-migrate true

# restarting: start / restart / unpause -> rollback-policy preflight.
new_dcase dc_restart_shared 'MIDTRANS_ENABLED=false' "JWT_ADMIN_ACCESS_SECRET=$LEAK"
set_kv "$DCASE/staging.env" "JWT_ADMIN_ACCESS_SECRET=$LEAK"
expect_dc "dc restart with a secret shared with staging -> refused, value hidden" refused validated restart backend
new_dcase dc_restart_bad 'MIDTRANS_ENABLED=false' 'SOME_KEY=CHANGE_ME'
rm -f "$DCASE/staging.env"
expect_dc "dc restart with invalid production config -> refused" refused validated restart backend
new_dcase dc_restart_nostaging 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/staging.env"
expect_dc "dc restart with staging unavailable, production valid -> WARN, then restart" ran validated restart backend
expect_skip_warn "dc restart with staging unavailable"
new_dcase dc_start_ok 'MIDTRANS_ENABLED=false'
expect_dc "dc start (valid config) -> rollback-policy preflight, then start" ran validated start backend
new_dcase dc_unpause_shared 'MIDTRANS_ENABLED=false' "COOKIE_SECRET=$LEAK"
set_kv "$DCASE/staging.env" "COOKIE_SECRET=$LEAK"
expect_dc "dc unpause with a shared secret -> refused" refused validated unpause backend
new_dcase dc_root_bad 'MIDTRANS_ENABLED=false'
set_mode "$DCASE/conf" 755
expect_dc "dc up with an untrusted config root (chmod 755) -> refused" refused direct up -d backend

# Options that would change WHAT is applied are refused before anything runs.
new_dcase dc_opts 'MIDTRANS_ENABLED=false'
dc_refusals=(
  "up --build backend"                       # builds outside deploy.sh
  "up -d --env-file /tmp/other.env backend"  # extra env file (compose global option)
  "up -d -f /tmp/override.yml backend"       # extra compose file
  "up -d -p other backend"                   # other project
  "up -d --profile x backend"
  "--env-file /tmp/other.env up -d backend"  # global option before the command
  "run --rm -e JWT_ACCESS_SECRET=x backend true"
  "run --rm -e JWT_ACCESS_SECRET backend true"
  "run --rm -e BOOTSTRAP_ADMIN_EMAIL=x backend true"
  "run --rm --env-file /tmp/e backend true"
  "run --rm --entrypoint sh backend"
  "restart -f /tmp/override.yml backend"
  "up -d ../backend"
  "ps -- postgres"                           # '--' is refused, not skipped
  "logs -f -- backend"
  "config"                                   # would print every secret
  "config --services"
  "down -v"
  "down --volumes"
  "down --rmi all"
  "rm -v backend"
  "build backend"
  "pull"
  "push"
  "cp backend:/app/x /tmp/x"
  "scale backend=2"
  "watch"
)
for args in "${dc_refusals[@]}"; do
  : > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"
  read -r -a argv <<<"$args"
  expect_dc "dc ${args} -> refused, nothing reached docker" refused direct "${argv[@]}"
done
: > "$DCASE/stub.log"
expect_dc "dc with no command -> refused" refused direct
: > "$DCASE/stub.log"
expect_dc "dc unknown command -> refused, name not echoed" refused direct "${LEAK}"
: > "$DCASE/stub.log"
expect_dc "dc run -e <pasted secret> -> refused, value not echoed" refused direct run --rm -e "JWT_ACCESS_SECRET=$LEAK" backend true

# read-only / access / stopping: run directly, even with a configuration that
# would fail the preflight (diagnostics and incident response stay available).
new_dcase dc_diag 'MIDTRANS_ENABLED=false' "JWT_ACCESS_SECRET=$LEAK"
set_kv "$DCASE/staging.env" "JWT_ACCESS_SECRET=$LEAK"
dc_direct=(
  "ps"
  "ps -a"
  "logs -f --tail=200 backend"
  "logs --tail 50 --since 10m backend"
  "top backend"
  "images"
  "port backend 3001"
  "stats --no-stream"
  "config --quiet"
  "version --short"
  "exec postgres psql -U mas_sular_admin -d mas_sular"
  "exec -T backend node -e 1"
  "stop backend"
  "stop -t 30 backend"
  "kill -s SIGTERM backend"
  "pause backend"
  "down --remove-orphans"
  "rm -f -s backend"
)
for args in "${dc_direct[@]}"; do
  : > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"
  read -r -a argv <<<"$args"
  expect_dc "dc ${args} -> runs directly (no preflight, no config applied)" ran direct "${argv[@]}"
done

new_dcase dc_envvar 'MIDTRANS_ENABLED=false'
RUN_ENV=(POSTGRES_PASSWORD=PgShellOverride000000000000000000000001)
expect_dc "dc up with POSTGRES_PASSWORD exported in the shell -> refused before any preflight or docker call" refused direct up -d backend
expect_nothing_ran "dc up with POSTGRES_PASSWORD exported"
: > "$DCASE/stub.log"
expect_dc "dc ps with POSTGRES_PASSWORD exported in the shell -> refused (compose would read it)" refused direct ps
RUN_ENV=()

# Static: deploy.sh drives compose only through prd_compose (never ./dc), and
# dc runs the preflight only for the restarting / applying classes.
if sed 's/\r$//' "$HERE/deploy.sh" | grep -vE '^[[:space:]]*#' | grep -qE '"\$DC"|/dc |docker compose'; then
  bad "static: deploy.sh calls compose other than through prd_compose"
else
  ok "static: deploy.sh calls compose only through prd_compose"
fi
dc_src="$(sed 's/\r$//' "$HERE/dc" | grep -vE '^[[:space:]]*#')"
if grep -qE '^[[:space:]]*restarting\)' <<<"$dc_src" && grep -A3 -E '^[[:space:]]*applying\)' <<<"$dc_src" | grep -qE '^[[:space:]]*preflight$' \
   && [[ "$(grep -c 'prd_compose_exec' <<<"$dc_src")" == 1 ]] && ! grep -qE '(^|[^_])exec docker|docker compose' <<<"$dc_src"; then
  ok "static: dc reaches docker only through prd_compose_exec, after the class checks"
else
  bad "static: dc has another path to docker or no applying-class preflight"
fi

# ------------------------------------------------ docker daemon pin ---------
echo
echo "docker daemon pin (unix:///var/run/docker.sock; redirecting variables refused)"
# (The static docker-call scan runs BEFORE any sandbox execution; see the top.)

# Each redirecting variable is refused by every entry point before anything
# runs (no git, no docker), and its value is never echoed.
pin_vars=(
  "DOCKER_HOST=tcp://${LEAK}.invalid:2376"
  "DOCKER_CONTEXT=${LEAK}"
  "DOCKER_CONFIG=/tmp/${LEAK}"
  "DOCKER_TLS_VERIFY=1${LEAK}"
  "DOCKER_CERT_PATH=/tmp/${LEAK}"
  "COMPOSE_PROFILES=${LEAK}"
  "BUILDX_BUILDER=${LEAK}"
  "BUILDX_CONFIG=/tmp/${LEAK}"
)
for kv in "${pin_vars[@]}"; do
  var="${kv%%=*}"
  for entry in forward check rollback dc-ps dc-up; do
    new_dcase "pin_${var}_${entry}" 'MIDTRANS_ENABLED=false'
    RUN_ENV=("$kv")
    case "$entry" in
      forward)  expect_deploy "pin: $var set -> forward deploy refused" fail ;;
      rollback) expect_deploy "pin: $var set -> rollback refused" fail --rollback ;;
      check)    expect_check  "pin: $var set -> --check refused" fail ;;
      dc-ps)    expect_dc     "pin: $var set -> dc ps refused" refused direct ps ;;
      dc-up)    expect_dc     "pin: $var set -> dc up refused before any preflight" refused direct up -d backend ;;
    esac
    RUN_ENV=()
    expect_nothing_ran "pin: $var set ($entry)"
    expect_key_named "pin: $var set ($entry)" "environment variable $var is set"
  done
done
new_dcase pin_empty 'MIDTRANS_ENABLED=false'
RUN_ENV=("DOCKER_HOST=")
expect_check "pin: DOCKER_HOST set but EMPTY -> refused too (set means set)" fail
RUN_ENV=()

# A context saved with `docker context use` (currentContext in the CLI config
# of $HOME) cannot redirect: every call still carries -H <pin> and inherits
# DOCKER_HOST=<pin>, both of which the Docker CLI ranks above a saved context.
FAKEHOME="$T/fakehome"
mkdir -p "$FAKEHOME/.docker/contexts/meta/0123456789abcdef"
printf '{"currentContext":"redirect-ctx"}\n' > "$FAKEHOME/.docker/config.json"
printf '{"Name":"redirect-ctx","Endpoints":{"docker":{"Host":"tcp://203.0.113.10:2376"}}}\n' \
  > "$FAKEHOME/.docker/contexts/meta/0123456789abcdef/meta.json"
new_dcase pin_ctx_fwd 'MIDTRANS_ENABLED=false'
RUN_ENV=(HOME="$FAKEHOME")
expect_deploy "pin: saved docker context present -> forward deploy still pinned" fwd-pass
new_dcase pin_ctx_rb 'MIDTRANS_ENABLED=false'
expect_deploy "pin: saved docker context present -> rollback (image inspect + up) still pinned" rb-pass --rollback
new_dcase pin_ctx_chk 'MIDTRANS_ENABLED=false'
expect_check "pin: saved docker context present -> --check (config --quiet) still pinned" pass
new_dcase pin_ctx_dcup 'MIDTRANS_ENABLED=false'
expect_dc "pin: saved docker context present -> dc up (preflight config + up) still pinned" ran validated up -d --no-deps --force-recreate backend
new_dcase pin_ctx_dcps 'MIDTRANS_ENABLED=false'
expect_dc "pin: saved docker context present -> dc ps still pinned" ran direct ps
RUN_ENV=()

# Preflight and execution use the SAME pinned daemon: dc up issues
# `config --quiet` (preflight) and then `up` - both records must be the pin.
new_dcase pin_same_target 'MIDTRANS_ENABLED=false'
run_dc up -d backend
want_same=$'dc config --quiet\ndocker image inspect mas-sular-prd/backend-migrate:cur000000001\ndocker image inspect mas-sular-prd/backend:cur000000001\ndocker image inspect mas-sular-prd/frontend:cur000000001\ndocker image inspect mas-sular-prd/admin:cur000000001\ndc up --no-build -d backend'
if [[ "$(grep -c . "$DCASE/stub.log.hosts")" == 6 && "$(sort -u "$DCASE/stub.log.hosts")" == "$PIN $PIN" ]] \
   && [[ "$(cat "$DCASE/stub.log")" == "$want_same" ]]; then
  ok "pin: dc up - preflight 'config --quiet', image checks and 'up --no-build' all went to the pinned daemon"
else
  bad "pin: dc up preflight/execution daemon targets differ or are unpinned"
fi

# The WHOLE forward path with every compose call succeeding: build, data
# services, pre-migrate backup (a stub backup.sh records the DOCKER_HOST it
# inherits), migrate, rollout, image prune, final ps - all pinned.
new_dcase pin_full_forward 'MIDTRANS_ENABLED=false'
: > "$DCASE/backup.key"
mkdir -p "$SANDBOX/scripts/backup"
cat > "$SANDBOX/scripts/backup/backup.sh" <<'EOF'
#!/usr/bin/env bash
printf 'backup DOCKER_HOST=%s\n' "${DOCKER_HOST:-NONE}" >> "$STUB_LOG"
printf 'backup POSTGRES_CONTAINER=%s\n' "${POSTGRES_CONTAINER:-NONE}" >> "$STUB_LOG"
printf 'backup KEEP=%s/%s COMPOSE_FILE=%s ENV_FILE=%s POSTGRES_SERVICE=%s LABEL=%s\n' "${KEEP_POSTGRES:-NONE}" "${KEEP_UPLOADS:-NONE}" \
  "${COMPOSE_FILE:-NONE}" "${ENV_FILE:-NONE}" "${POSTGRES_SERVICE:-NONE}" "${BACKUP_LABEL:-NONE}" >> "$STUB_LOG"
EOF
chmod +x "$SANDBOX/scripts/backup/backup.sh"
# A builder saved with `docker buildx use --global` must not be used either.
mkdir -p "$FAKEHOME/.docker/buildx"
printf '{"Key":"","Name":"redirect-builder","Global":true}\n' > "$FAKEHOME/.docker/buildx/current"
# The operator's shell carries backup.sh overrides: deploy.sh must not pass them on.
RUN_ENV=(DOCKER_STUB_COMPOSE_OK=1 HOME="$FAKEHOME" KEEP_POSTGRES=1 KEEP_UPLOADS='BASH_VERSINFO[$(touch /nonexistent)0]'
         COMPOSE_FILE=/tmp/operator-compose.yml ENV_FILE=/tmp/operator.env POSTGRES_SERVICE=other)
run_deploy
RUN_ENV=()
full_log="$(cat "$DCASE/stub.log")"
if grep -qx 'backup KEEP=14/14 COMPOSE_FILE=/nonexistent/compose-not-used.yml ENV_FILE=/nonexistent/env-not-used POSTGRES_SERVICE=postgres LABEL=pre-migrate' <<<"$full_log"; then
  ok "F1: pre-migrate backup gets fixed retention (14/14) and fallback settings, not the operator's KEEP_*/COMPOSE_FILE/ENV_FILE/POSTGRES_SERVICE"
else
  bad "F1: pre-migrate backup inherited operator overrides: $(grep '^backup KEEP' <<<"$full_log")"
fi
full_problems="$(pin_problems)"
assert_no_leak "pin: full forward path" "$DOUT$full_log" || true
for want in "dc config --quiet" "dc build --builder default backend-migrate" "dc build --builder default backend" \
            "dc build --builder default frontend" "dc build --builder default admin" \
            "dc up -d --wait --wait-timeout 180 postgres redis rabbitmq" \
            "dc ps -q postgres" "backup DOCKER_HOST=$PIN" "backup POSTGRES_CONTAINER=0123456789abcdef0123" \
            "dc run --rm --no-deps backend-migrate" \
            "dc up -d --no-build --no-deps --wait --wait-timeout 300 backend frontend admin" "docker image ls mas-sular-prd/backend"; do
  [[ "$full_log" == *"$want"* ]] || full_problems+=" missing($want)"
done
if (( DRC == 0 )) && [[ -z "$full_problems" ]]; then
  ok "pin: full forward deploy (build, backup.sh, migrate, rollout, prune, ps) - every docker call pinned, backup.sh inherits the pin"
else
  bad "pin: full forward deploy path: exit=$DRC$full_problems"
fi
rm -rf "$SANDBOX/scripts"

# ------------------------------------------------ service / builder lists ---
echo
echo "service lists and builder pin match docker-compose.yml and deploy.sh"
COMPOSE_SRC="$(sed 's/\r$//' "$HERE/docker-compose.yml")"
yml_services="$(awk '/^services:/{s=1; next} /^[^[:space:]#]/{s=0} s && /^  [a-z0-9][a-z0-9_-]*:[[:space:]]*$/{sub(/^  /,""); sub(/:.*/,""); print}' <<<"$COMPOSE_SRC" | sort | tr '\n' ' ')"
yml_built="$(awk '/^services:/{s=1; next} /^[^[:space:]#]/{s=0} s && /^  [a-z0-9][a-z0-9_-]*:[[:space:]]*$/{svc=$1; sub(/:$/,"",svc)} s && /^    build:/{print svc}' <<<"$COMPOSE_SRC" | sort | tr '\n' ' ')"
lib_services="$( ( . "$HERE/lib/preflight.sh" 2>/dev/null; printf '%s\n' "${PRD_SERVICES[@]}" ) | sed 's/\r$//' | sort | tr '\n' ' ')"
lib_built="$( ( . "$HERE/lib/preflight.sh" 2>/dev/null; printf '%s\n' "${PRD_BUILT_SERVICES[@]}" ) | sed 's/\r$//' | sort | tr '\n' ' ')"
[[ -n "$yml_services" && "$yml_services" == "$lib_services" ]] \
  && ok "static: PRD_SERVICES equals the services of docker-compose.yml ($yml_services)" \
  || bad "static: PRD_SERVICES ($lib_services) differs from docker-compose.yml ($yml_services)"
[[ -n "$yml_built" && "$yml_built" == "$lib_built" ]] \
  && ok "static: PRD_BUILT_SERVICES equals the services with a build: section ($yml_built)" \
  || bad "static: PRD_BUILT_SERVICES ($lib_built) differs from build: services ($yml_built)"
if sed 's/\r$//' "$HERE/lib/preflight.sh" | grep -qx 'PRD_BUILDX_BUILDER=default' \
   && [[ "$(grep -vE '^[[:space:]]*#' <<<"$DEPLOY_SRC" | grep -c 'prd_compose build')" == 1 ]] \
   && grep -vE '^[[:space:]]*#' <<<"$DEPLOY_SRC" | grep -q 'prd_compose build --builder "\$PRD_BUILDX_BUILDER" "\$svc"'; then
  ok "static: deploy.sh builds only with --builder \"\$PRD_BUILDX_BUILDER\" (= default)"
else
  bad "static: deploy.sh build does not pin the builder to default"
fi

# ------------------------------------------------ B2: dc never builds -------
echo
echo "dc never builds or pulls application images (--no-build, image existence)"
LEAKALPHA=syntheticsecretdonotleakalpha
LEAKHEX=3f9a1c0d5e7b2a4c6d8e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5
SECRET_VALUES+=("$LEAKALPHA" "$LEAKHEX")
inspects_for() { local t="$1" s; for s in backend-migrate backend frontend admin; do printf 'docker image inspect mas-sular-prd/%s:%s\n' "$s" "$t"; done; }
# expect_dc_log <label> <exact expected stub log>
expect_dc_log() {
  if [[ "$(cat "$DCASE/stub.log")" == "$2" ]]; then ok "$1"; else bad "$1: stub log was: $(tr '\n' ';' < "$DCASE/stub.log")"; fi
}
new_dcase b2_up 'MIDTRANS_ENABLED=false'
expect_dc "B2: dc up -> strict preflight, image checks, then up" ran validated up -d --no-deps --force-recreate backend
expect_dc_log "B2: dc up always carries --no-build, after checking every application image" \
  "dc config --quiet"$'\n'"$(inspects_for cur000000001)"$'\n'"dc up --no-build -d --no-deps --force-recreate backend"
grep -qx 'up cur000000001' "$DCASE/stub.log.tag" && ok "B2: dc up passes the VERIFIED tag to compose" || bad "B2: dc up did not pass the verified tag"
new_dcase b2_up_bare 'MIDTRANS_ENABLED=false'
expect_dc "B2: dc up (no options) -> --no-build added" ran validated up
grep -qx 'dc up --no-build' "$DCASE/stub.log" && ok "B2: bare dc up -> 'up --no-build'" || bad "B2: bare dc up without --no-build"
new_dcase b2_create 'MIDTRANS_ENABLED=false'
expect_dc "B2: dc create -> preflight, image checks, then create" ran validated create backend
expect_dc_log "B2: dc create always carries --no-build" \
  "dc config --quiet"$'\n'"$(inspects_for cur000000001)"$'\n'"dc create --no-build backend"
new_dcase b2_run 'MIDTRANS_ENABLED=false'
expect_dc "B2: dc run (images present) -> runs" ran validated run --rm backend-migrate true
expect_dc_log "B2: dc run checks every application image before running" \
  "dc config --quiet"$'\n'"$(inspects_for cur000000001)"$'\n'"dc run --rm backend-migrate true"
for missing in backend-migrate backend frontend admin; do
  for sub in "up -d backend" "create backend" "run --rm backend-migrate true"; do
    new_dcase "b2_missing_${missing}_${sub%% *}" 'MIDTRANS_ENABLED=false'
    RUN_ENV=(STUB_MISSING_IMAGE="mas-sular-prd/$missing:")
    read -r -a argv <<<"$sub"
    expect_dc "B2: dc ${sub%% *} with image $missing missing -> refused, never reaches compose ${sub%% *}" refused validated "${argv[@]}"
    RUN_ENV=()
  done
done
new_dcase b2_envtag_missing 'MIDTRANS_ENABLED=false'
RUN_ENV=(IMAGE_TAG=nosuchtag0001 STUB_MISSING_IMAGE=":nosuchtag0001")
expect_dc "B2: IMAGE_TAG exported to a tag without images -> dc up refused (no build from the working tree)" refused validated up -d backend
RUN_ENV=()
[[ "$LAST_OUTPUT" != *nosuchtag0001* ]] && ok "B2: tag from the environment is not echoed" || bad "B2: environment tag echoed"
new_dcase b2_envtag_ok 'MIDTRANS_ENABLED=false'
RUN_ENV=(IMAGE_TAG=other0000001)
expect_dc "B2: IMAGE_TAG exported to an existing tag -> checked and used" ran validated run --rm backend true
RUN_ENV=()
[[ "$(grep -c 'other0000001' "$DCASE/stub.log")" == 4 ]] && grep -qx 'run other0000001' "$DCASE/stub.log.tag" \
  && ok "B2: environment IMAGE_TAG is the one verified and the one compose gets" || bad "B2: environment IMAGE_TAG not verified/used consistently"
for badtag in "" "../x" "a b" ".x" "x:y" "$(printf 'x%.0s' {1..130})"; do
  new_dcase b2_badtag 'MIDTRANS_ENABLED=false'
  RUN_ENV=(IMAGE_TAG="$badtag")
  expect_dc "B2: malformed IMAGE_TAG (${#badtag} chars) -> refused before any image check" refused validated up -d backend
  RUN_ENV=()
  grep -q '^docker image inspect' "$DCASE/stub.log" && bad "B2: malformed tag reached image inspect" || true
done
new_dcase b2_undeployed 'MIDTRANS_ENABLED=false'
rm -f "$DCASE/conf/release.env"
expect_dc "B2: nothing deployed (no release.env, no IMAGE_TAG) -> dc run refused" refused validated run --rm backend true
new_dcase b2_refusals 'MIDTRANS_ENABLED=false'
for args in "create --build backend" "run --build --rm backend true" "up -d --pull always backend" \
            "up -d --pull=always backend" "run --rm --pull always backend true" "create --pull missing backend"; do
  : > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"
  read -r -a argv <<<"$args"
  expect_dc "B2: dc ${args} -> refused, nothing reached docker" refused direct "${argv[@]}"
done
# Across EVERY dc case of this run: no build ever reached docker, and every
# up/create that did carries --no-build as its first option.
dc_logs=("$T"/d_case_dc_*/stub.log "$T"/d_case_b2_*/stub.log "$T"/d_case_l[0-9]_*/stub.log)
if ! cat "${dc_logs[@]}" 2>/dev/null | grep -qE '^dc build|^dc [a-z]+ (.* )?--build( |=|$)'; then
  ok "B2: no dc case ever reached a compose build"
else
  bad "B2: a dc case reached a compose build"
fi
if ! cat "${dc_logs[@]}" 2>/dev/null | grep -E '^dc (up|create)( |$)' | grep -qvE '^dc (up|create) --no-build( |$)'; then
  ok "B2: every dc up/create that reached docker had --no-build"
else
  bad "B2: a dc up/create reached docker without --no-build"
fi

# ------------------------------------------------ L1-L3: dc arguments -------
echo
echo "dc argument handling: exact option matching, service allow-list, nothing echoed"
new_dcase l1_args 'MIDTRANS_ENABLED=false'
for args in "ps -p$LEAKALPHA" "ps --$LEAKALPHA" "ps --$LEAKALPHA=1" "logs -$LEAKALPHA backend" "up -d --build=$LEAKALPHA backend"; do
  : > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"
  read -r -a argv <<<"$args"
  expect_dc "L1: dc ${args%%$LEAKALPHA*}<secret>... -> refused, rejected text not echoed" refused direct "${argv[@]}"
done
[[ "$LAST_OUTPUT" == *"option --build is not allowed"* ]] && ok "L1: a known option NAME is still named (--build), its value is not" \
  || bad "L1: known option name not reported"
: > "$DCASE/stub.log"
expect_dc "L1: unknown option -> '(not shown)'" refused direct ps "-p$LEAKALPHA"
[[ "$LAST_OUTPUT" == *"(not shown)"* ]] && ok "L1: unknown option reported as (not shown)" || bad "L1: unknown option not redacted"
for args in "logs $LEAKHEX" "logs backend $LEAKHEX" "exec $LEAKHEX sh" "run --rm $LEAKHEX true" "port backend $LEAKALPHA" \
            "port $LEAKHEX 3001" "port backend" "port backend 3001 3002" "top $LEAKALPHA" "restart $LEAKHEX"; do
  : > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"
  read -r -a argv <<<"$args"
  expect_dc "L2: dc ${args//$LEAKHEX/<hex secret>} -> refused (not a compose service), nothing echoed" refused direct "${argv[@]}"
done
new_dcase l2_ok 'MIDTRANS_ENABLED=false' "JWT_ACCESS_SECRET=$LEAK"
set_kv "$DCASE/staging.env" "JWT_ACCESS_SECRET=$LEAK"
for args in "port backend 3001" "logs postgres redis rabbitmq backend-migrate backend frontend admin" "exec admin sh -c true" "top frontend"; do
  : > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"
  read -r -a argv <<<"$args"
  expect_dc "L2: dc ${args} -> real service names still accepted" ran direct "${argv[@]}"
done
new_dcase l3_args 'MIDTRANS_ENABLED=false'
for tok in "-f --follow" "--no-color -t" "-a --all" "--tail -n"; do
  : > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"
  expect_dc "L3: dc logs '$tok' (two options in ONE argument) -> refused" refused direct logs "$tok" backend
done
: > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"
expect_dc "L3: dc up '-d --detach' (one argument) -> refused before preflight" refused direct up "-d --detach" backend
: > "$DCASE/stub.log"; : > "$DCASE/stub.log.hosts"
expect_dc "L3: dc ps '-q ' (trailing space) -> refused" refused direct ps "-q "

# ------------------------------------------------ L4: numeric env -----------
echo
echo "L4: KEEP_IMAGES / MIN_FREE_MB_FOR_BUILD are never evaluated as arithmetic"
for var in KEEP_IMAGES MIN_FREE_MB_FOR_BUILD; do
  for mode in fwd rb chk; do
    args=(); [[ "$mode" == rb ]] && args=(--rollback); [[ "$mode" == chk ]] && args=(--check)
    new_dcase "l4_${var}_$mode" 'MIDTRANS_ENABLED=false'
    marker="$DCASE/../l4_pwned_${var}_$mode"
    rm -f "$marker"
    # BASH_VERSINFO is always set, so this payload runs even under `set -u`
    # (an unset name such as x[...] would abort as unbound before expanding).
    RUN_ENV=("$var=BASH_VERSINFO[\$(touch $marker)0]")
    expect_deploy "L4: $var=BASH_VERSINFO[\$(touch ..)0] ($mode) -> refused" fail "${args[@]}"
    RUN_ENV=()
    [[ ! -e "$marker" ]] && ok "L4: $var payload ($mode) did NOT execute (no marker file)" || bad "L4: $var payload EXECUTED ($mode)"
    expect_nothing_ran "L4: $var payload ($mode)"
    [[ "$LAST_OUTPUT" != *'touch'* ]] && ok "L4: $var value not echoed ($mode)" || bad "L4: $var value echoed ($mode)"
  done
done
for kv in KEEP_IMAGES=0 KEEP_IMAGES=21 KEEP_IMAGES=-1 KEEP_IMAGES=3a KEEP_IMAGES=" 3" KEEP_IMAGES=0x3 KEEP_IMAGES=1+1 \
          MIN_FREE_MB_FOR_BUILD=65537 MIN_FREE_MB_FOR_BUILD=-5 MIN_FREE_MB_FOR_BUILD=1e3 MIN_FREE_MB_FOR_BUILD=1200MB; do
  new_dcase l4_bounds 'MIDTRANS_ENABLED=false'
  RUN_ENV=("$kv")
  expect_deploy "L4: ${kv} -> refused before anything runs" fail
  RUN_ENV=()
  expect_nothing_ran "L4: ${kv}"
done
for kv in KEEP_IMAGES=1 KEEP_IMAGES=08 KEEP_IMAGES=20 KEEP_IMAGES= MIN_FREE_MB_FOR_BUILD=0 MIN_FREE_MB_FOR_BUILD=000; do
  new_dcase l4_valid 'MIDTRANS_ENABLED=false'
  RUN_ENV=("$kv")
  expect_deploy "L4: ${kv} (valid decimal) -> forward deploy proceeds to build" fwd-pass
  RUN_ENV=()
done

# ------------------------------------------------ L5: backup container id ----
echo
echo "L5: pre-migrate backup needs exactly one production postgres container"
mkdir -p "$SANDBOX/scripts/backup"
cat > "$SANDBOX/scripts/backup/backup.sh" <<'EOF'
#!/usr/bin/env bash
printf 'backup POSTGRES_CONTAINER=%s\n' "${POSTGRES_CONTAINER:-NONE}" >> "$STUB_LOG"
EOF
chmod +x "$SANDBOX/scripts/backup/backup.sh"
new_dcase l5_empty 'MIDTRANS_ENABLED=false'
: > "$DCASE/backup.key"
RUN_ENV=(DOCKER_STUB_COMPOSE_OK=1 STUB_PS_EMPTY=1)
run_deploy
RUN_ENV=()
l5_log="$(cat "$DCASE/stub.log")"
if (( DRC == 1 )) && [[ "$DOUT" == *"expected exactly one production postgres container"* && "$l5_log" == *"dc ps -q postgres"* \
      && "$l5_log" != *"backup "* && "$l5_log" != *"dc run"* && "$l5_log" != *"--no-build --no-deps --wait"* ]]; then
  ok "L5: empty postgres container id -> ABORT before backup.sh, no migration, no rollout"
else
  bad "L5: empty postgres container id not refused (exit=$DRC, log: $(tr '\n' ';' <<<"$l5_log"))"
fi
# F7: two container ids, and a failing `ps -q`, must fail closed the same way.
for variant in two fail; do
  new_dcase "l5_$variant" 'MIDTRANS_ENABLED=false'
  : > "$DCASE/backup.key"
  if [[ "$variant" == two ]]; then RUN_ENV=(DOCKER_STUB_COMPOSE_OK=1 STUB_PS_TWO=1); want_msg="expected exactly one production postgres container"
  else RUN_ENV=(DOCKER_STUB_COMPOSE_OK=1 STUB_PS_FAIL=1); want_msg="could not resolve the production postgres container"; fi
  run_deploy
  RUN_ENV=()
  l5_log="$(cat "$DCASE/stub.log")"
  if (( DRC == 1 )) && [[ "$DOUT" == *"$want_msg"* && "$l5_log" == *"dc ps -q postgres"* \
        && "$l5_log" != *"backup "* && "$l5_log" != *"dc run"* && "$l5_log" != *"--no-build --no-deps --wait"* ]]; then
    ok "L5: postgres 'ps -q' $variant -> ABORT before backup.sh, no migration, no rollout"
  else
    bad "L5: postgres 'ps -q' $variant not refused (exit=$DRC, log: $(tr '\n' ';' <<<"$l5_log"))"
  fi
done
# L4 on the FULL forward path: KEEP_IMAGES is only used by the final image
# prune, so this is the case where a payload would actually be evaluated.
new_dcase l4_fullpath 'MIDTRANS_ENABLED=false'
: > "$DCASE/backup.key"
marker="$T/l4_pwned_fullpath"; rm -f "$marker"
RUN_ENV=(DOCKER_STUB_COMPOSE_OK=1 "KEEP_IMAGES=BASH_VERSINFO[\$(touch $marker)0]")
run_deploy
RUN_ENV=()
if (( DRC == 1 )) && [[ ! -e "$marker" && -z "$(cat "$DCASE/stub.log")" ]]; then
  ok "L4: KEEP_IMAGES payload on the full forward path (build..prune) -> refused up front, never evaluated"
else
  bad "L4: KEEP_IMAGES payload on the full forward path: exit=$DRC marker=$([[ -e "$marker" ]] && echo CREATED || echo absent)"
fi
rm -rf "$SANDBOX/scripts"

# ------------------------------------------------ F7: rollback target image --
echo
echo "rollback refuses a target tag whose images are gone (never builds or pulls)"
for svc in backend frontend admin; do
  new_dcase "rb_missing_$svc" 'MIDTRANS_ENABLED=false'
  RUN_ENV=(STUB_MISSING_IMAGE="mas-sular-prd/$svc:prev00000001")
  expect_deploy "rollback: image mas-sular-prd/$svc:<previous tag> missing -> ABORT, no rollout" fail --rollback
  RUN_ENV=()
  grep -q '^dc ' "$DCASE/stub.log" && bad "rollback with missing $svc image reached compose" || ok "rollback with missing $svc image: no compose call at all"
done

# ------------------------------------------------ F1: backup.sh retention ----
# The REAL scripts/backup/backup.sh (copied), with a stub docker that must never
# be reached: invalid KEEP_* values are refused before any lock, docker or
# arithmetic; a payload never executes.
echo
echo "F1: backup.sh accepts only plain decimal KEEP_POSTGRES / KEEP_UPLOADS"
BACKUP_SH="$HERE/../../scripts/backup/backup.sh"
if [[ ! -r "$BACKUP_SH" ]]; then
  bad "F1: $BACKUP_SH is not readable (run the suite from a full checkout: deploy/prd and scripts/backup)"
else
  F1BOX="$T/f1box"; mkdir -p "$F1BOX/bin" "$F1BOX/bk"; : > "$F1BOX/key"
  sed 's/\r$//' "$BACKUP_SH" > "$F1BOX/backup.sh"
  cat > "$F1BOX/bin/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "$F1BOX/docker.log"; exit 1
EOF
  chmod +x "$F1BOX/bin/docker" "$F1BOX/backup.sh"
  f1_run() { ( cd "$F1BOX" && env -i HOME="$FAKEHOME" PATH="$F1BOX/bin:/usr/bin:/bin" BACKUP_DIR="$F1BOX/bk" BACKUP_KEY_FILE="$F1BOX/key" "$@" bash "$F1BOX/backup.sh" ) 2>&1; }
  for var in KEEP_POSTGRES KEEP_UPLOADS; do
    for val in 'BASH_VERSINFO[$(touch '"$F1BOX"'/pwned)0]' 0 -1 1000 abc " 7" 0x10 1+1 ""; do
      rm -f "$F1BOX/pwned" "$F1BOX/docker.log"; rm -rf "$F1BOX/bk/.backup.lock"
      out="$(f1_run "$var=$val")"; rc=$?
      [[ -z "$val" ]] && continue   # empty = unset-equivalent default (checked below)
      if (( rc == 1 )) && [[ "$out" == *"$var must be a whole number from 1 to 999 (value not shown)"* && ! -e "$F1BOX/pwned" \
            && ! -e "$F1BOX/docker.log" && ! -e "$F1BOX/bk/.backup.lock" && "$out" != *"touch"* ]]; then
        ok "F1: backup.sh $var=<${#val}-char invalid value> -> refused before lock/docker, payload not executed, value hidden"
      else
        bad "F1: backup.sh $var invalid value not refused cleanly (rc=$rc, marker=$([[ -e "$F1BOX/pwned" ]] && echo CREATED || echo absent))"
      fi
    done
  done
  for val in 1 014 999 ""; do
    rm -f "$F1BOX/docker.log"; rm -rf "$F1BOX/bk/.backup.lock"
    out="$(f1_run "KEEP_POSTGRES=$val" "KEEP_UPLOADS=$val")"
    if [[ "$out" != *"must be a whole number"* && -e "$F1BOX/docker.log" ]]; then
      ok "F1: backup.sh KEEP_*='$val' accepted (proceeds to its docker preflight, stub docker fails it)"
    else
      bad "F1: backup.sh KEEP_*='$val' wrongly refused or did not proceed"
    fi
  done
  if sed 's/\r$//' "$RUNBOOK" 2>/dev/null | tr '\n' ' ' | grep -qE '`KEEP_UPLOADS` \(each a whole number +1–999'; then
    ok "F1/R2: RUNBOOK documents the accepted KEEP_POSTGRES/KEEP_UPLOADS range (1–999)"
  else
    bad "F1/R2: RUNBOOK does not document the KEEP_* range"
  fi
fi

# ------------------------------------------------ B1: README commands -------
echo
echo "B1: README standalone docker commands (cron backup, restore drill, proxy) pin the daemon"
README_SRC="$(sed 's/\r$//' "$HERE/README.md")"
README_CODE="$(awk '/^```/{f=!f; next} f' <<<"$README_SRC" | grep -vE '^[[:space:]]*#')"
n_docker="$(grep -oE '(^|[[:space:];&|(])docker[[:space:]]+[^[:space:]]+' <<<"$README_CODE" | grep -c . || true)"
n_pinned="$(grep -oE '(^|[[:space:];&|(])docker[[:space:]]+-H[[:space:]]+unix:///var/run/docker\.sock([[:space:]]|$)' <<<"$README_CODE" | grep -c . || true)"
if (( n_docker > 0 )) && [[ "$n_docker" == "$n_pinned" ]]; then
  ok "B1: every docker invocation in README code blocks is 'docker -H unix:///var/run/docker.sock' ($n_docker)"
else
  bad "B1: README code blocks contain unpinned docker invocations ($n_pinned of $n_docker pinned)"
fi
cron_lines="$(grep -E '^[0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ .*backup\.sh' <<<"$README_CODE" || true)"
if [[ "$(grep -c . <<<"$cron_lines")" == 1 && "$cron_lines" == *" DOCKER_HOST=unix:///var/run/docker.sock "*"./scripts/backup/backup.sh"* \
      && "$cron_lines" == *" POSTGRES_CONTAINER=mas-sular-prd-postgres-1 "* && "$cron_lines" != *'$('* && "$cron_lines" != *'`'* \
      && "$cron_lines" != *"docker ps"* && "$cron_lines" != *"name="* ]]; then
  ok "B1: cron line pins DOCKER_HOST for backup.sh and names the container exactly (no docker ps filter)"
else
  bad "B1: cron line does not pin the daemon / select the container exactly"
fi
B1BOX="$T/b1box"; mkdir -p "$B1BOX/scripts/backup" "$B1BOX/backups" "$B1BOX/bin" "$B1BOX/sudobin"; : > "$B1BOX/backup.key"
B1LOG="$B1BOX/calls.log"; : > "$B1LOG"
# Stubs with the log path baked in (sudo emulation wipes the environment).
cat > "$B1BOX/bin/docker" <<EOF
#!/usr/bin/env bash
h=NONE; [[ "\${1:-}" == -H ]] && { h="\$2"; shift 2; }
printf 'docker -H=%s DOCKER_HOST=%s %s\n' "\$h" "\${DOCKER_HOST:-NONE}" "\$*" >> "$B1LOG"
exit 0
EOF
for s in backup restore-drill; do
  cat > "$B1BOX/scripts/backup/$s.sh" <<EOF
#!/usr/bin/env bash
printf '$s DOCKER_HOST=%s POSTGRES_CONTAINER=%s BACKUP_KEY_FILE=%s args=%s\n' "\${DOCKER_HOST:-NONE}" "\${POSTGRES_CONTAINER:-NONE}" "\${BACKUP_KEY_FILE:-NONE}" "\$*" >> "$B1LOG"
docker info >/dev/null
EOF
done
# sudo emulation: env_reset + secure_path - NOTHING from the caller's environment survives.
cat > "$B1BOX/sudobin/sudo" <<EOF
#!/usr/bin/env bash
exec env -i PATH="$B1BOX/bin:/usr/bin:/bin" HOME="$FAKEHOME" "\$@"
EOF
chmod +x "$B1BOX/bin/docker" "$B1BOX/scripts/backup/"*.sh "$B1BOX/sudobin/sudo"
b1_subst() {
  local s="$1"
  s="${s//\/home\/massular\/apps\/mas-sular-prd/$B1BOX}"
  s="${s//\/srv\/backups\/mas-sular-prd/$B1BOX/backups}"
  s="${s//\/etc\/mas-sular-prd\/backup.key/$B1BOX/backup.key}"
  s="${s//<TS>/20260101-000000Z}"
  printf '%s' "$s"
}
b1_run() { ( cd "$B1BOX" && env -i HOME="$FAKEHOME" PATH="$B1BOX/sudobin:$B1BOX/bin:/usr/bin:/bin" sh -c "$1" ) >/dev/null 2>&1; }
# cron: run the documented line verbatim (paths mapped into the sandbox) with a
# minimal cron-like environment and a HOME holding a saved docker context.
: > "$B1LOG"
b1_run "$(b1_subst "$(cut -d' ' -f6- <<<"$cron_lines")")"
if grep -qx "backup DOCKER_HOST=$PIN POSTGRES_CONTAINER=mas-sular-prd-postgres-1 BACKUP_KEY_FILE=$B1BOX/backup.key args=" "$B1LOG" \
   && grep -qx "docker -H=NONE DOCKER_HOST=$PIN info" "$B1LOG" && [[ "$(grep -c '^docker ' "$B1LOG")" == 1 ]]; then
  ok "B1: documented cron line -> backup.sh and its docker calls inherit DOCKER_HOST=$PIN (saved context present), exact container name"
else
  bad "B1: documented cron line does not pin backup.sh: $(tr '\n' ';' < "$B1LOG")"
fi
# restore drill: one plain and one sudo form, both pinned; sudo form survives env reset.
rd_plain="$(grep -E '^env DOCKER_HOST=unix:///var/run/docker\.sock .*scripts/backup/restore-drill\.sh ' <<<"$README_CODE" || true)"
rd_sudo="$(grep -E '^sudo env DOCKER_HOST=unix:///var/run/docker\.sock .*scripts/backup/restore-drill\.sh ' <<<"$README_CODE" || true)"
rd_all="$(grep -E 'restore-drill\.sh' <<<"$README_CODE" || true)"
if [[ "$(grep -c . <<<"$rd_plain")" == 1 && "$(grep -c . <<<"$rd_sudo")" == 1 && "$(grep -c . <<<"$rd_all")" == 2 ]]; then
  ok "B1: README documents exactly the two pinned restore-drill forms (plain, sudo env)"
else
  bad "B1: restore-drill commands in README are not exactly the two pinned forms"
fi
for form in plain sudo; do
  line="$rd_plain"; [[ "$form" == sudo ]] && line="$rd_sudo"
  : > "$B1LOG"
  b1_run "$(b1_subst "$line")"
  if grep -qE "^restore-drill DOCKER_HOST=$PIN POSTGRES_CONTAINER=NONE BACKUP_KEY_FILE=$B1BOX/backup.key args=$B1BOX/backups/mas-sular-postgres-20260101-000000Z\.dump\.enc $B1BOX/backups/manifest-20260101-000000Z\.json\$" "$B1LOG" \
     && grep -qx "docker -H=NONE DOCKER_HOST=$PIN info" "$B1LOG"; then
    ok "B1: documented restore drill ($form) -> DOCKER_HOST=$PIN reaches the drill and its docker calls"
  else
    bad "B1: documented restore drill ($form) not pinned: $(tr '\n' ';' < "$B1LOG")"
  fi
done
# Control: the sudo emulation really drops a variable set in front of sudo.
: > "$B1LOG"
b1_run "DOCKER_HOST=$PIN sudo bash scripts/backup/restore-drill.sh x"
grep -q '^restore-drill DOCKER_HOST=NONE ' "$B1LOG" && ok "B1: control - 'DOCKER_HOST=... sudo cmd' loses the pin under env_reset (why README uses 'sudo env')" \
  || bad "B1: control - sudo emulation did not reset the environment"
if grep -qE 'DRILL_EXTRA_SQL=' <<<"$README_CODE"; then
  bad "B1: README restore instructions set DRILL_EXTRA_SQL (could print customer data)"
else
  ok "B1: README restore instructions print counts only (no DRILL_EXTRA_SQL)"
fi

# ------------------------------------------------ B1: RUNBOOK commands ------
# scripts/backup/RUNBOOK.md (the staging stack's backup/restore runbook, linked
# from the production README) is read from the repository itself: its code
# blocks (backslash continuations joined, comments dropped) and inline code.
echo
echo "B1: scripts/backup/RUNBOOK.md - every docker, backup and restore command pins the daemon"
if [[ ! -r "$RUNBOOK" ]]; then
  bad "B1 runbook: $RUNBOOK is not readable (run the suite from a full checkout: deploy/prd and scripts/backup)"
else
  RB_SRC="$(sed 's/\r$//' "$RUNBOOK")"
  RB_CODE="$(awk '/^```/{f=!f; next} f' <<<"$RB_SRC" | grep -vE '^[[:space:]]*#' \
    | awk '{ if (sub(/\\$/, "")) { buf = buf $0 " "; next } print buf $0; buf = "" }')"
  # Inline code outside code blocks. `docker context use` is the one span that
  # names a docker feature in prose rather than giving a command to run.
  RB_INLINE="$(awk '/^```/{f=!f; next} !f' <<<"$RB_SRC" | grep -oE '`[^`]+`' | tr -d '`' | grep -vx 'docker context use' || true)"
  RB_ALL="$RB_CODE"$'\n'"$RB_INLINE"
  rb_docker="$(grep -oE '(^|[[:space:];&|("])docker[[:space:]]+[^[:space:]]+' <<<"$RB_ALL" | grep -c . || true)"
  rb_pinned="$(grep -oE '(^|[[:space:];&|("])docker[[:space:]]+-H[[:space:]]+unix:///var/run/docker\.sock([[:space:]]|$)' <<<"$RB_ALL" | grep -c . || true)"
  if (( rb_docker >= 10 )) && [[ "$rb_docker" == "$rb_pinned" ]]; then
    ok "B1 runbook: every direct docker / docker compose command is 'docker -H unix:///var/run/docker.sock' ($rb_docker)"
  else
    bad "B1 runbook: unpinned docker commands ($rb_pinned of $rb_docker pinned): $(grep -E '(^|[[:space:];&|("])docker[[:space:]]' <<<"$RB_ALL" | grep -v 'docker -H unix:///var/run/docker.sock' | tr '\n' ';')"
  fi
  if grep -qE '^C="docker -H unix:///var/run/docker\.sock compose ' <<<"$RB_CODE" && [[ "$(grep -cE '^[A-Z_]+="?docker' <<<"$RB_CODE")" == 1 ]] \
     && grep -qE '^\$C ' <<<"$RB_CODE"; then
    ok "B1 runbook: the compose variable \$C carries the pin and is the only docker command variable"
  else
    bad "B1 runbook: compose command variable missing or unpinned"
  fi
  rb_scripts="$(grep -E '(bash |\./)scripts/backup/(backup|restore-drill)\.sh' <<<"$RB_ALL" || true)"
  rb_cron="$(grep -E '^[0-9*/,-]+( [0-9*/,-]+){4} root ' <<<"$RB_CODE" || true)"
  rb_unpinned_scripts="$(grep -vE '^sudo env DOCKER_HOST=unix:///var/run/docker\.sock [^|;&]*bash scripts/backup/(backup|restore-drill)\.sh' <<<"$rb_scripts" \
    | grep -vE '^[0-9*/,-]+( [0-9*/,-]+){4} root [^|;]* DOCKER_HOST=unix:///var/run/docker\.sock [^|;&]*bash scripts/backup/backup\.sh' | grep . || true)"
  if (( $(grep -c . <<<"$rb_scripts") >= 5 )) && [[ -z "$rb_unpinned_scripts" ]]; then
    ok "B1 runbook: every backup.sh / restore-drill.sh invocation is 'sudo env DOCKER_HOST=<pin> ...' or the pinned root cron ($(grep -c . <<<"$rb_scripts"))"
  else
    bad "B1 runbook: backup/restore invocation without the sudo-env pin: $(tr '\n' ';' <<<"$rb_unpinned_scripts")"
  fi
  if grep -qE '(^|[[:space:];&|(])sudo[[:space:]]+[A-Za-z_][A-Za-z0-9_]*=|DOCKER_HOST=[^[:space:]]*[[:space:]]+sudo([[:space:]]|$)|export[[:space:]]+DOCKER_HOST' <<<"$RB_ALL"; then
    bad "B1 runbook: a command sets a variable in a form that sudo drops (sudo VAR=, VAR=.. sudo, export)"
  else
    ok "B1 runbook: no 'sudo VAR=', 'DOCKER_HOST=.. sudo' or 'export DOCKER_HOST' form"
  fi
  if [[ "$(grep -c . <<<"$rb_cron")" == 1 && "$rb_cron" == *" root "*" DOCKER_HOST=unix:///var/run/docker.sock "*"bash scripts/backup/backup.sh"* ]]; then
    ok "B1 runbook: the root cron entry sets DOCKER_HOST=<pin> for backup.sh"
  else
    bad "B1 runbook: root cron entry missing the pin"
  fi
  if grep -E 'DRILL_EXTRA_SQL=' <<<"$RB_SRC" | grep -qvE "DRILL_EXTRA_SQL='select (max|min|count)\("; then
    bad "B1 runbook: a DRILL_EXTRA_SQL example is not an aggregate (could print customer data)"
  else
    ok "B1 runbook: DRILL_EXTRA_SQL examples are aggregates only"
  fi
  # F4: builds in the runbook use the pinned daemon's own builder; no `up --build`.
  rb_up_build="$(grep -E 'compose[^;&|]*[[:space:]]up([[:space:]][^;&|]*)?[[:space:]]--build([[:space:]=]|$)' <<<"$RB_ALL" || true)"
  rb_builds="$(grep -oE 'compose[^;&|]*[[:space:]]build([[:space:]][^;&|]*)?' <<<"$RB_ALL" || true)"
  if [[ -z "$rb_up_build" && -n "$rb_builds" ]] && ! grep -qv -- '--builder default' <<<"$rb_builds"; then
    ok "B1 runbook: every image build uses '--builder default' and no command uses 'up --build' ($(grep -c . <<<"$rb_builds") build)"
  else
    bad "B1 runbook: build without '--builder default' or an 'up --build': $(tr '\n' ';' <<<"$rb_up_build$rb_builds")"
  fi
  # Run the documented commands themselves (paths mapped into the sandbox),
  # sudo forms through the env-wiping sudo emulation, the cron line as cron would.
  rb_subst() {
    local s="$1"
    s="${s//\/opt\/mas-sular/$B1BOX}"
    s="${s//\/srv\/backups\/mas-sular/$B1BOX/backups}"
    s="${s//\/etc\/mas-sular\/backup.key/$B1BOX/backup.key}"
    s="${s//\/var\/log\/mas-sular-backup.log/$B1BOX/backup.log}"
    s="${s//<TS>/20260101-000000Z}"
    printf '%s' "$s"
  }
  rb_n=0; rb_bad=""
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    rb_n=$((rb_n + 1))
    [[ "$line" =~ ^[0-9*/,-]+(\ [0-9*/,-]+){4}\ root\ (.*)$ ]] && line="${BASH_REMATCH[2]}"
    : > "$B1LOG"
    b1_run "$(rb_subst "$line")"
    script="backup"; [[ "$line" == *restore-drill.sh* ]] && script="restore-drill"
    if ! grep -qE "^$script DOCKER_HOST=$PIN POSTGRES_CONTAINER=NONE BACKUP_KEY_FILE=$B1BOX/backup.key args=" "$B1LOG" \
       || ! grep -qx "docker -H=NONE DOCKER_HOST=$PIN info" "$B1LOG"; then
      rb_bad+=" [$script: $(tr '\n' ';' < "$B1LOG")]"
    fi
  done <<<"$rb_scripts"
  if (( rb_n >= 5 )) && [[ -z "$rb_bad" ]]; then
    ok "B1 runbook: all $rb_n documented backup/restore commands, run as written (sudo env-reset emulated, cron env), deliver DOCKER_HOST=<pin> to the script and its docker calls"
  else
    bad "B1 runbook: documented commands did not deliver the pin:$rb_bad"
  fi
fi

# ------------------------------------------------ follow-up register --------
echo
echo "README follow-up register: open findings recorded with severity and classification"
reg="$(awk '/^## Register tindak lanjut keamanan/{f=1; next} /^## /{f=0} f' <<<"$README_SRC")"
reg_missing=""
for id in V1 D2 S1 M3 M2 C; do
  row="$(grep -E "^\| $id \|" <<<"$reg" || true)"
  [[ "$(grep -c . <<<"$row")" == 1 && "$row" =~ \|\ (INFO|LOW|MEDIUM|HIGH)[^|]*\| && "$row" =~ (Track\ 1|Pasca-deploy) ]] || reg_missing+=" $id"
done
if [[ -n "$reg" && -z "$reg_missing" ]] && grep -q 'Tidak ada yang dianggap' <<<"$reg" \
   && ! grep -qiE '\|[[:space:]]*\**(selesai|done|closed|resolved|fixed)\**[[:space:]]*\|' <<<"$reg"; then
  ok "README register lists V1, D2, S1, M3, M2 and C as open, each with a severity and a Track 1 / post-deploy classification"
else
  bad "README register incomplete:${reg_missing:- (section missing or marks an item done)}"
fi
# F2/F3: the Track 1 checklist has concrete commands with defined pass criteria.
chk="$(awk '/^### Pemeriksaan Track 1/{f=1; next} /^## |^### /{f=0} f' <<<"$README_SRC")"
chk_missing=""
for needle in 'compose version' 'buildx version' 'for f in --no-build --no-deps --wait --wait-timeout' 'compose create --help' \
              'compose run --help' 'compose build --help' 'MISSING:' 'BASH_FUNC_' 'BASH_ENV' 'KEEP_' 'BACKUP_' 'declare -Fx' \
              "bash -c 'type -a git stat id sed awk grep realpath" '.docker/cli-plugins' 'cliPluginsExtraDirs|proxies' "stat -c '%U %a %n'"; do
  [[ "$chk" == *"$needle"* ]] || chk_missing+=" [$needle]"
done
if [[ -n "$chk" && -z "$chk_missing" && "$(grep -c '# harus' <<<"$chk")" -ge 6 ]]; then
  ok "README Track 1 checklist: V1 flags (incl. rollback's --wait/--wait-timeout), D2 env/functions/binaries/plugins, S1 path - each with a pass criterion"
else
  bad "README Track 1 checklist incomplete:$chk_missing"
fi
# F8: the prune-cron fix is followed by a check that it actually applied.
if grep -A1 -F 'sudo sed -i' <<<"$README_CODE" | grep -qF "sudo grep -F 'label!=id.baksomassular.stack=mas-sular-prd' /etc/cron.d/docker-image-prune"; then
  ok "F8: README verifies the prune-cron exclusion with grep right after the sed"
else
  bad "F8: README prune-cron sed is not followed by a verifying grep"
fi

# --- the real repository files are untouched by the whole run
REPO_AFTER="$(sha256sum "$HERE/deploy.sh" "$LIB" "$HERE/lib/prd-root.sh" "$HERE/lib/preflight.sh" "$HERE/dc" "$HERE/docker-compose.yml" "$HERE/README.md" "$RUNBOOK" 2>/dev/null)"
if [[ "$REPO_AFTER" == "$REPO_BEFORE" ]]; then
  ok "repository deploy files unchanged by the test run"
else
  bad "repository deploy files changed during the test run"
fi

echo
if (( FAILS > 0 )); then
  echo "FAILED: $FAILS failure(s), $PASS passed, $SKIPS skipped"
  exit 1
fi
echo "OK: $PASS checks passed, $SKIPS skipped"
