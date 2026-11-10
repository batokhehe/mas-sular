#!/usr/bin/env bash
# Secret-reuse guard shared by deploy/prd/deploy.sh and its offline test.
#
# Values are read with deploy.sh's rule: the last assignment wins, an inline
# " # comment" is dropped and trailing whitespace is trimmed.
#
# MIDTRANS_SERVER_KEY is allowed to match staging ONLY while MIDTRANS_ENABLED is
# exactly "false" (the value the app validates: z.enum(['true', 'false'])).
# A missing, empty, differently-cased or otherwise invalid flag fails closed:
# the key is still treated as a reused secret. Every other secret is unchanged.

_secret_reuse_val() {
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n1 | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'
}

check_secret_reuse() {
  local app_env="$1" staging_env="$2" compose_env="$3"
  local k v midtrans_enabled
  midtrans_enabled="$(_secret_reuse_val "$app_env" MIDTRANS_ENABLED)"

  if [[ ! -r "$staging_env" ]]; then
    warn "staging env $staging_env not readable - secret-reuse check skipped"
    return 0
  fi

  for k in JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_ADMIN_ACCESS_SECRET COOKIE_SECRET \
           PAXEL_API_SECRET PAXEL_WEBHOOK_SECRET MIDTRANS_SERVER_KEY QONTAK_API_TOKEN RESEND_API_KEY; do
    v="$(_secret_reuse_val "$app_env" "$k")"
    if [[ -n "$v" && "$v" == "$(_secret_reuse_val "$staging_env" "$k")" ]]; then
      if [[ "$k" == MIDTRANS_SERVER_KEY && "$midtrans_enabled" == false ]]; then
        warn "app.env $k is the SAME as staging - allowed because MIDTRANS_ENABLED=false"
        continue
      fi
      fail "app.env $k is the SAME as staging - generate a new one"
      return 1
    fi
  done

  for k in POSTGRES_PASSWORD RABBITMQ_PASSWORD; do
    v="$(_secret_reuse_val "$compose_env" "$k")"
    if [[ -n "$v" && "$v" == "$(_secret_reuse_val "$staging_env" "$k")" ]]; then
      fail "compose.env $k is the SAME as staging"
      return 1
    fi
  done
}
