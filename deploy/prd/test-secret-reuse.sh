#!/usr/bin/env bash
#
# Offline test for deploy/prd/lib/secret-reuse.sh.
#
# Exercises the production secret-reuse guard with synthetic env files. No
# Docker, no production config and no real secret is read or written.
#
# Usage (repo root):  bash deploy/prd/test-secret-reuse.sh
#
set -Euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB="$HERE/lib/secret-reuse.sh"
T="$(mktemp -d)"
PASS=0
FAILS=0

ok()  { PASS=$((PASS + 1)); echo "  PASS  $*"; }
bad() { FAILS=$((FAILS + 1)); echo "  FAIL  $*"; }
cleanup() { rm -rf "$T"; }
trap cleanup EXIT

# deploy.sh provides these; the test supplies lightweight equivalents so a
# rejection returns instead of exiting the whole test run.
warn() { :; }
fail() { echo "ABORT: $*" >&2; return 1; }
# shellcheck source=lib/secret-reuse.sh
. "$LIB"

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

# new_case <name> [extra app.env lines...]
new_case() {
  local name="$1"; shift
  CASE="$T/$name"
  mkdir -p "$CASE"
  cp "$T/app.base" "$CASE/app.env"
  cp "$T/compose.base" "$CASE/compose.env"
  cp "$T/staging.env" "$CASE/staging.env"
  local line
  for line in "$@"; do printf '%s\n' "$line" >> "$CASE/app.env"; done
}

# expect <label> <allow|reject>
expect() {
  local label="$1" want="$2" got
  if check_secret_reuse "$CASE/app.env" "$CASE/staging.env" "$CASE/compose.env" >/dev/null 2>&1; then
    got=allow
  else
    got=reject
  fi
  if [[ "$got" == "$want" ]]; then
    ok "$label"
  else
    bad "$label (expected $want, got $got)"
  fi
}

echo "secret-reuse: MIDTRANS_SERVER_KEY exception"

# 1. Midtrans disabled + matching key: allowed.
new_case midtrans_disabled_match \
  'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "MIDTRANS_ENABLED=false + matching MIDTRANS_SERVER_KEY -> allowed" allow

# 2. Midtrans enabled + matching key: rejected.
new_case midtrans_enabled_match \
  'MIDTRANS_ENABLED=true' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "MIDTRANS_ENABLED=true + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 3. Flag missing + matching key: rejected (fail closed).
new_case midtrans_flag_missing \
  'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "missing MIDTRANS_ENABLED + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 4. Flag invalid + matching key: rejected (fail closed).
new_case midtrans_flag_invalid \
  'MIDTRANS_ENABLED=yes' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "invalid MIDTRANS_ENABLED + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 4b. Wrong case is invalid, not "disabled": rejected.
new_case midtrans_flag_wrong_case \
  'MIDTRANS_ENABLED=FALSE' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "MIDTRANS_ENABLED=FALSE + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 4c. Empty flag is invalid: rejected.
new_case midtrans_flag_empty \
  'MIDTRANS_ENABLED=' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "empty MIDTRANS_ENABLED + matching MIDTRANS_SERVER_KEY -> rejected" reject

# 5. Disabled Midtrans does not exempt any other shared app secret.
new_case qontak_match 'MIDTRANS_ENABLED=false' 'QONTAK_API_TOKEN=staging-qontak'
expect "MIDTRANS_ENABLED=false + matching QONTAK_API_TOKEN -> rejected" reject

new_case resend_match 'MIDTRANS_ENABLED=false' 'RESEND_API_KEY=staging-resend'
expect "MIDTRANS_ENABLED=false + matching RESEND_API_KEY -> rejected" reject

new_case jwt_match 'MIDTRANS_ENABLED=false' 'JWT_ACCESS_SECRET=staging-jwt-access'
expect "MIDTRANS_ENABLED=false + matching JWT_ACCESS_SECRET -> rejected" reject

# 6. Disabled Midtrans does not exempt shared infrastructure passwords.
new_case postgres_match 'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=prod-midtrans'
printf 'POSTGRES_PASSWORD=staging-postgres\n' >> "$CASE/compose.env"
expect "MIDTRANS_ENABLED=false + matching POSTGRES_PASSWORD -> rejected" reject

new_case rabbitmq_match 'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=prod-midtrans'
printf 'RABBITMQ_PASSWORD=staging-rabbitmq\n' >> "$CASE/compose.env"
expect "MIDTRANS_ENABLED=false + matching RABBITMQ_PASSWORD -> rejected" reject

# 7. Non-matching Midtrans key stays allowed regardless of the flag.
new_case midtrans_disabled_no_match \
  'MIDTRANS_ENABLED=false' 'MIDTRANS_SERVER_KEY=prod-midtrans'
expect "MIDTRANS_ENABLED=false + non-matching key -> allowed" allow

# 8. Inline comment after the flag is stripped, so it still reads as false.
new_case midtrans_disabled_comment \
  'MIDTRANS_ENABLED=false  # gateway not live yet' 'MIDTRANS_SERVER_KEY=SB-Mid-server-STAGING'
expect "MIDTRANS_ENABLED=false with inline comment + matching key -> allowed" allow

echo
if (( FAILS > 0 )); then
  echo "FAILED: $FAILS failure(s), $PASS passed"
  exit 1
fi
echo "OK: $PASS checks passed"
