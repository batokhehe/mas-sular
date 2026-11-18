#!/usr/bin/env bash
# Secret-reuse guard shared by deploy/prd/deploy.sh and its offline test.
#
# check_secret_reuse (forward deploy): all three env files are REQUIRED. A
# missing or unreadable file, an empty file, an unparseable line, an
# unsupported value syntax, or a failed value extraction aborts the check with
# a non-zero status (fail closed). Error messages name the file role, key and
# line only - never a value.
#
# Value syntax (see _secret_reuse_canon): all three files are read by Docker
# Compose's dotenv parser, which handles quotes, escapes and ${VAR}
# interpolation; this guard compares CANONICAL values and only accepts the forms
# whose meaning is identical under both readers:
#   KEY=value           plain value; optional " # comment" after whitespace;
#                       trailing whitespace dropped
#   KEY="value"         double-quoted, no backslash, $ or backtick inside
#   KEY='value'         single-quoted, no backslash inside
# so KEY=s, KEY="s" and KEY='s' are the SAME secret. Anything else in a key
# this guard reads (an unterminated quote, text after the closing quote, $ or
# a backslash, a leading space, a '#' not preceded by whitespace) is ambiguous
# and fails closed. Keys the guard does not read are not interpreted at all.
# The last assignment of a production key wins, but production files may not
# assign a key twice; every assignment in the staging file is compared.
#
# MIDTRANS_SERVER_KEY is allowed to match staging ONLY while MIDTRANS_ENABLED is
# exactly "false" (the value the app validates: z.enum(['true', 'false'])).
# A missing, empty, differently-cased or otherwise invalid flag fails closed:
# the key is still treated as a reused secret.
#
# QONTAK_API_TOKEN and RESEND_API_KEY may match staging under an explicit,
# recorded OWNER authorization (2026-11-10): production deliberately runs on
# the SAME Qontak account (one channel integration id, shared approved
# templates) and shares the Resend key while the two stacks coexist. This is
# the intent, not an oversight, so unlike Midtrans it carries no feature-flag
# condition - but it covers ONLY these two keys. Every other secret is
# unchanged and still fails closed on a staging match.
#
# check_secret_reuse_rollback (deploy.sh --rollback only) keeps the production
# requirements but does not require the staging file; see its comment below.

# Secrets compared against staging (app.env / compose.env), and the keys every
# real staging env file assigns (template production.env.example).
SECRET_REUSE_APP_KEYS=(JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_ADMIN_ACCESS_SECRET COOKIE_SECRET
  PAXEL_API_SECRET PAXEL_WEBHOOK_SECRET MIDTRANS_SERVER_KEY QONTAK_API_TOKEN RESEND_API_KEY)
SECRET_REUSE_COMPOSE_KEYS=(POSTGRES_PASSWORD RABBITMQ_PASSWORD)
SECRET_REUSE_STAGING_ROLE_KEYS=(JWT_ACCESS_SECRET JWT_REFRESH_SECRET JWT_ADMIN_ACCESS_SECRET
  COOKIE_SECRET POSTGRES_PASSWORD RABBITMQ_PASSWORD)

# --------------------------------------------------------- value syntax ----
# _secret_reuse_canon <raw value after "KEY=">: print the canonical value.
# Returns 3 when the syntax is unsupported or ambiguous. Prints nothing else.
_secret_reuse_canon() {
  local raw="${1%$'\r'}" body inner rest q
  case "$raw" in
    \"*|\'*)
      q="${raw:0:1}"
      body="${raw:1}"
      [[ "$body" == *"$q"* ]] || return 3                 # unterminated quote
      inner="${body%%"$q"*}"
      rest="${body#*"$q"}"
      [[ "$rest" =~ ^[[:space:]]*(#.*)?$ ]] || return 3   # text after the closing quote
      [[ "$inner" == *\\* ]] && return 3                  # escapes differ between readers
      if [[ "$q" == '"' && ( "$inner" == *'$'* || "$inner" == *'`'* ) ]]; then
        return 3                                          # interpolation inside "..."
      fi
      printf '%s\n' "$inner"
      ;;
    *)
      body="$raw"
      if [[ "$body" == *'#'* ]]; then
        inner="${body%%#*}"
        # A '#' starts a comment only after whitespace; anything else is ambiguous.
        [[ "$inner" =~ [[:space:]]$ ]] || return 3
        body="$inner"
      fi
      body="${body%"${body##*[![:space:]]}"}"             # drop trailing whitespace
      [[ -z "$body" ]] && { printf '\n'; return 0; }
      [[ "$body" =~ ^[[:space:]] ]] && return 3           # leading whitespace
      [[ "$body" == *[\"\'\\\$\`]* ]] && return 3         # quotes, escapes, interpolation
      printf '%s\n' "$body"
      ;;
  esac
}

# Raw text after "KEY=" for every assignment of KEY (one per line). Returns 2
# when the file cannot be read or the extractor fails.
_secret_reuse_raw() {
  local file="$1" key="$2"
  [[ -f "$file" && -r "$file" ]] || return 2
  sed -n "s/^$key=//p" "$file" 2>/dev/null || return 2
}

# Canonical value of the LAST assignment of KEY (empty when unassigned).
# Returns 2 (unreadable / extractor failed) or 3 (unsupported syntax).
_secret_reuse_val() {
  local out line last="" seen=0
  out="$(_secret_reuse_raw "$1" "$2")" || return 2
  [[ -n "$out" ]] || return 0
  while IFS= read -r line; do last="$line"; seen=1; done <<<"$out"
  (( seen )) || return 0
  _secret_reuse_canon "$last"
}

# Canonical value of EVERY assignment of KEY, one per line. Used for the
# staging side so a duplicated key cannot hide an earlier value. Any
# unsupported assignment makes the whole read fail (3).
_secret_reuse_vals() {
  local out line canon
  out="$(_secret_reuse_raw "$1" "$2")" || return 2
  [[ -n "$out" ]] || return 0
  while IFS= read -r line; do
    canon="$(_secret_reuse_canon "$line")" || return 3
    printf '%s\n' "$canon"
  done <<<"$out"
}

# fail with a value-free message for a _secret_reuse_val/_vals failure.
_secret_reuse_value_fail() {
  local rc="$1" role="$2" file="$3" key="$4" lines
  if [[ "$rc" == 3 ]]; then
    lines="$(grep -n "^$key=" "$file" 2>/dev/null | cut -d: -f1 | tr '\n' ' ')"
    fail "secret-reuse: $role env $key has unsupported or ambiguous value syntax at $file line(s) ${lines% } - use KEY=value, KEY=\"value\" or KEY='value' without \$, backslash, backtick, leading space or a '#' that is not preceded by a space (value not shown)"
  else
    fail "secret-reuse: could not read $key from $role env"
  fi
  return 1
}

# ------------------------------------------------------- file structure ----
# Fail unless FILE is a non-empty readable regular file. ROLE is a fixed label
# ("staging", "production app", "production compose"), never a secret value.
_secret_reuse_require_file() {
  local file="$1" role="$2"
  if [[ -z "$file" ]]; then
    fail "secret-reuse: $role env path is empty"
    return 1
  fi
  if [[ ! -e "$file" ]]; then
    fail "secret-reuse: $role env file is missing: $file"
    return 1
  fi
  if [[ ! -f "$file" ]]; then
    fail "secret-reuse: $role env path is not a regular file: $file"
    return 1
  fi
  if [[ ! -r "$file" ]]; then
    fail "secret-reuse: $role env file is not readable: $file"
    return 1
  fi
  if [[ ! -s "$file" ]]; then
    fail "secret-reuse: $role env file is empty: $file"
    return 1
  fi
}

# Every non-blank, non-comment line must be a plain KEY=VALUE assignment. A
# malformed line could hide an assignment from the extractor, so it fails.
_secret_reuse_parseable() {
  local file="$1" role="$2" line n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      fail "secret-reuse: $role env file has an unparseable line at $file:$n"
      return 1
    fi
  done < "$file" || {
    fail "secret-reuse: $role env file could not be read: $file"
    return 1
  }
}

# Production env files must assign every key at most once: with a duplicate,
# "which value is live" depends on the reader, so it fails closed. The message
# names the key and both line numbers, never a value.
_secret_reuse_no_duplicates() {
  local file="$1" role="$2" line key n=0
  local -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    key="${BASH_REMATCH[1]}"
    if [[ -n "${seen[$key]:-}" ]]; then
      fail "secret-reuse: $role env file assigns $key more than once ($file:${seen[$key]} and $file:$n) - keep exactly one"
      return 1
    fi
    seen[$key]=$n
  done < "$file"
}

# ------------------------------------------------------- staging checks ----
# True (0) when an octal mode grants write to group or others.
_secret_reuse_mode_writable_by_others() {
  local m="$1"
  [[ "$m" =~ ^[0-7]{3,4}$ ]] || return 0      # unknown mode: treat as unsafe
  m="${m: -3}"
  (( (8#$m & 8#022) != 0 ))
}

# Print a fixed reason and return 0 when the staging file cannot be TRUSTED as
# the staging stack's file: it (or its symlink target) must be owned by the
# deploy user or root and must not be writable by group or others.
_secret_reuse_file_trust_problem() {
  local file="$1" uid owner mode
  uid="$(id -u)"
  owner="$(stat -L -c %u "$file" 2>/dev/null)" || { echo "ownership could not be checked: $file"; return 0; }
  mode="$(stat -L -c %a "$file" 2>/dev/null)" || { echo "permissions could not be checked: $file"; return 0; }
  if [[ "$owner" != "$uid" && "$owner" != 0 ]]; then
    echo "is owned by uid $owner, not the deploy user (uid $uid) or root: $file"
    return 0
  fi
  if _secret_reuse_mode_writable_by_others "$mode"; then
    echo "is writable by group or others (mode $mode): $file"
    return 0
  fi
  return 1
}

# Print a fixed reason and return 0 when STAGING is not usable as a staging env
# file: a role key is missing or empty, or a compared key has unsupported
# syntax. Return 1 when it looks right.
_secret_reuse_staging_role_problem() {
  local file="$1" k vals rc
  for k in "${SECRET_REUSE_STAGING_ROLE_KEYS[@]}"; do
    rc=0; vals="$(_secret_reuse_vals "$file" "$k")" || rc=$?
    if (( rc == 3 )); then echo "has unsupported value syntax for $k: $file"; return 0; fi
    if (( rc != 0 )); then echo "could not be read: $file"; return 0; fi
    if ! grep -q '[^[:space:]]' <<<"$vals"; then
      echo "does not assign $k (missing, empty or whitespace only) - not a staging env file: $file"
      return 0
    fi
  done
  for k in "${SECRET_REUSE_APP_KEYS[@]}" "${SECRET_REUSE_COMPOSE_KEYS[@]}"; do
    rc=0; _secret_reuse_vals "$file" "$k" >/dev/null || rc=$?
    if (( rc == 3 )); then echo "has unsupported value syntax for $k: $file"; return 0; fi
    if (( rc != 0 )); then echo "could not be read: $file"; return 0; fi
  done
  return 1
}

# Print a fixed reason and return 0 when the staging path IS one of the
# production files (wrong role, a configuration error); return 1 otherwise.
_secret_reuse_same_file_problem() {
  local staging="$1" app="$2" compose="$3"
  if [[ -e "$staging" && "$staging" -ef "$app" ]]; then echo "is the production app env file: $staging"; return 0; fi
  if [[ -e "$staging" && "$staging" -ef "$compose" ]]; then echo "is the production compose env file: $staging"; return 0; fi
  return 1
}

# True when VALUE is non-empty and equals any line of LIST. Prints nothing.
_secret_reuse_in_list() {
  local value="$1" list="$2" item
  [[ -n "$value" ]] || return 1
  while IFS= read -r item; do
    [[ "$item" == "$value" ]] && return 0
  done <<<"$list"
  return 1
}

check_secret_reuse() {
  local app_env="$1" staging_env="$2" compose_env="$3"
  local k v staging_vals midtrans_enabled reason rc

  _secret_reuse_require_file "$app_env" "production app" || return 1
  _secret_reuse_require_file "$compose_env" "production compose" || return 1
  _secret_reuse_require_file "$staging_env" "staging" || return 1

  _secret_reuse_parseable "$app_env" "production app" || return 1
  _secret_reuse_parseable "$compose_env" "production compose" || return 1
  _secret_reuse_parseable "$staging_env" "staging" || return 1

  _secret_reuse_no_duplicates "$app_env" "production app" || return 1
  _secret_reuse_no_duplicates "$compose_env" "production compose" || return 1

  if reason="$(_secret_reuse_same_file_problem "$staging_env" "$app_env" "$compose_env")"; then
    fail "secret-reuse: staging env path $reason (wrong role)"
    return 1
  fi
  if reason="$(_secret_reuse_file_trust_problem "$staging_env")"; then
    fail "secret-reuse: staging env file $reason"
    return 1
  fi
  if reason="$(_secret_reuse_staging_role_problem "$staging_env")"; then
    fail "secret-reuse: staging env file $reason"
    return 1
  fi

  rc=0; midtrans_enabled="$(_secret_reuse_val "$app_env" MIDTRANS_ENABLED)" || rc=$?
  (( rc == 0 )) || { _secret_reuse_value_fail "$rc" "production app" "$app_env" MIDTRANS_ENABLED; return 1; }

  for k in "${SECRET_REUSE_APP_KEYS[@]}"; do
    rc=0; v="$(_secret_reuse_val "$app_env" "$k")" || rc=$?
    (( rc == 0 )) || { _secret_reuse_value_fail "$rc" "production app" "$app_env" "$k"; return 1; }
    rc=0; staging_vals="$(_secret_reuse_vals "$staging_env" "$k")" || rc=$?
    (( rc == 0 )) || { _secret_reuse_value_fail "$rc" "staging" "$staging_env" "$k"; return 1; }
    if _secret_reuse_in_list "$v" "$staging_vals"; then
      if [[ "$k" == MIDTRANS_SERVER_KEY && "$midtrans_enabled" == false ]]; then
        warn "app.env $k is the SAME as staging - allowed because MIDTRANS_ENABLED=false"
        continue
      fi
      if [[ "$k" == QONTAK_API_TOKEN || "$k" == RESEND_API_KEY ]]; then
        warn "app.env $k is the SAME as staging - allowed: owner-authorized shared credential (2026-11-10)"
        continue
      fi
      fail "app.env $k is the SAME as staging - generate a new one"
      return 1
    fi
  done

  for k in "${SECRET_REUSE_COMPOSE_KEYS[@]}"; do
    rc=0; v="$(_secret_reuse_val "$compose_env" "$k")" || rc=$?
    (( rc == 0 )) || { _secret_reuse_value_fail "$rc" "production compose" "$compose_env" "$k"; return 1; }
    rc=0; staging_vals="$(_secret_reuse_vals "$staging_env" "$k")" || rc=$?
    (( rc == 0 )) || { _secret_reuse_value_fail "$rc" "staging" "$staging_env" "$k"; return 1; }
    if _secret_reuse_in_list "$v" "$staging_vals"; then
      fail "compose.env $k is the SAME as staging"
      return 1
    fi
  done

  return 0
}

# ------------------------------------------------------------- rollback ----
# Rollback variant, called ONLY from `deploy.sh --rollback` (there is no flag or
# environment variable that selects it on a forward deploy).
#
# A rollback restarts previously deployed images with the SAME production env
# files; it builds nothing, migrates nothing and changes no secret. It must not
# depend on the staging stack being present - staging may already be taken
# down, or be the thing that is broken - so:
#   * production app env and compose env stay REQUIRED: missing, not a regular
#     file, unreadable, empty, unparseable, duplicated keys or unsupported value
#     syntax -> fail closed (as forward);
#   * if the staging env file is unusable (missing, not a regular file,
#     unreadable, empty, unparseable, untrusted owner/permissions, missing a
#     staging role key such as JWT_ACCESS_SECRET / POSTGRES_PASSWORD, or
#     unsupported value syntax), the staging comparison is NOT performed and a
#     WARN says so explicitly - it is never skipped silently, and such a file is
#     never treated as a valid staging copy;
#   * if the staging env file IS usable, the full forward check runs unchanged:
#     a detected reuse (including MIDTRANS_SERVER_KEY with MIDTRANS_ENABLED not
#     exactly "false") still fails closed.

# Print a fixed, non-sensitive reason and return 0 when the staging env file
# cannot be used for comparison; return 1 when it is usable. Never calls fail.
_secret_reuse_staging_unusable() {
  local file="$1" line
  if [[ -z "$file" ]]; then echo "path is empty"; return 0; fi
  if [[ ! -e "$file" ]]; then echo "is missing: $file"; return 0; fi
  if [[ ! -f "$file" ]]; then echo "is not a regular file: $file"; return 0; fi
  if [[ ! -r "$file" ]]; then echo "is not readable: $file"; return 0; fi
  if [[ ! -s "$file" ]]; then echo "is empty: $file"; return 0; fi
  local n=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    if [[ ! "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      echo "has an unparseable line at $file:$n"
      return 0
    fi
  done < "$file" || { echo "could not be read: $file"; return 0; }
  _secret_reuse_file_trust_problem "$file" && return 0
  # Readable and parseable, but is it a staging env file at all?
  _secret_reuse_staging_role_problem "$file" && return 0
  return 1
}

check_secret_reuse_rollback() {
  local app_env="$1" staging_env="$2" compose_env="$3" reason k rc

  _secret_reuse_require_file "$app_env" "production app" || return 1
  _secret_reuse_require_file "$compose_env" "production compose" || return 1
  _secret_reuse_parseable "$app_env" "production app" || return 1
  _secret_reuse_parseable "$compose_env" "production compose" || return 1
  _secret_reuse_no_duplicates "$app_env" "production app" || return 1
  _secret_reuse_no_duplicates "$compose_env" "production compose" || return 1
  # Production value syntax is checked even when staging is unavailable.
  for k in MIDTRANS_ENABLED "${SECRET_REUSE_APP_KEYS[@]}"; do
    rc=0; _secret_reuse_val "$app_env" "$k" >/dev/null || rc=$?
    (( rc == 0 )) || { _secret_reuse_value_fail "$rc" "production app" "$app_env" "$k"; return 1; }
  done
  for k in "${SECRET_REUSE_COMPOSE_KEYS[@]}"; do
    rc=0; _secret_reuse_val "$compose_env" "$k" >/dev/null || rc=$?
    (( rc == 0 )) || { _secret_reuse_value_fail "$rc" "production compose" "$compose_env" "$k"; return 1; }
  done

  # Pointing "staging" at a production file is a configuration error, not
  # staging being unavailable: it fails closed on rollback too.
  if reason="$(_secret_reuse_same_file_problem "$staging_env" "$app_env" "$compose_env")"; then
    fail "secret-reuse: staging env path $reason (wrong role)"
    return 1
  fi

  if reason="$(_secret_reuse_staging_unusable "$staging_env")"; then
    warn "secret-reuse (rollback): staging env $reason - staging secret-reuse comparison NOT performed for this rollback; run a forward-deploy preflight once staging is available, or confirm staging is decommissioned"
    return 0
  fi

  check_secret_reuse "$app_env" "$staging_env" "$compose_env"
}

# ------------------------------------------------ trusted config root -------
# verify_trusted_conf_root <dir>
#
# The production configuration root (deploy/prd/lib/prd-root.sh, documented as
# `install -d -o massular -g massular -m 700 /etc/mas-sular-prd`) must be:
#   * an absolute path to a real directory, not a symlink;
#   * owned by the user running deploy.sh (the deploy user, massular) and
#     chmod 700, so nobody else can add, replace or remove files in it;
#   * inside a parent directory owned by root or the deploy user that is not
#     writable by group or others, so the root itself cannot be swapped.
# Any violation calls fail with a value-free message.
verify_trusted_conf_root() {
  local root="${1%/}" uid owner mode parent powner pmode
  uid="$(id -u)"
  if [[ "$root" != /* ]]; then
    fail "trusted config root must be an absolute path"
    return 1
  fi
  if [[ -L "$root" ]]; then
    fail "trusted config root $root must not be a symlink"
    return 1
  fi
  if [[ ! -d "$root" ]]; then
    fail "trusted config root $root is missing or not a directory (see deploy/prd/README.md section 1)"
    return 1
  fi
  owner="$(stat -c %u "$root" 2>/dev/null)" || owner=unknown
  mode="$(stat -c %a "$root" 2>/dev/null)" || mode=unknown
  if [[ "$owner" != "$uid" ]]; then
    fail "trusted config root $root must be owned by the deploy user (uid $uid), not uid $owner - run deploy.sh as that user"
    return 1
  fi
  if [[ "$mode" != 700 ]]; then
    fail "trusted config root $root must be chmod 700 (is $mode)"
    return 1
  fi
  parent="$(dirname "$root")"
  powner="$(stat -c %u "$parent" 2>/dev/null)" || powner=unknown
  pmode="$(stat -c %a "$parent" 2>/dev/null)" || pmode=unknown
  if [[ "$powner" != 0 && "$powner" != "$uid" ]]; then
    fail "parent directory $parent of the trusted config root must be owned by root or the deploy user, not uid $powner"
    return 1
  fi
  if _secret_reuse_mode_writable_by_others "$pmode"; then
    fail "parent directory $parent of the trusted config root must not be writable by group or others (mode $pmode)"
    return 1
  fi
  return 0
}

# --------------------------------------------------- staging path policy ----
# resolve_staging_env_path <trusted_conf_root> <default_path>
#
# Prints the ONE staging env path the comparison must use:
#   * the built-in default (the staging stack's production.env), unless
#   * <root>/staging-env.path exists. The root must already have passed
#     verify_trusted_conf_root. The path file is production configuration and
#     must be a regular file (NOT a symlink), owned by the deploy user, chmod
#     600, holding exactly one absolute path made of [A-Za-z0-9._/-] with no "."
#     or ".." component.
# Wherever the path came from, it must not resolve (symlinks followed) inside
# the root, and must not be the same file as any file in the root (hard links
# included).
# A STAGING_ENV_FILE environment variable is REFUSED (not silently ignored): an
# ad-hoc variable must never redirect the comparison to an arbitrary file.
# Any violation calls fail. Messages name the path file and the rule, never its
# content.
resolve_staging_env_path() {
  local conf_dir="${1%/}" default="$2" pathfile line path="" count=0 f uid owner real_root real_path
  pathfile="$conf_dir/staging-env.path"
  uid="$(id -u)"

  if [[ -n "${STAGING_ENV_FILE+x}" ]]; then
    fail "STAGING_ENV_FILE is not supported - unset it. The staging env path is the built-in default ($default) or the single line in $pathfile (see deploy/prd/README.md)"
    return 1
  fi

  if [[ -L "$pathfile" ]]; then
    fail "staging path policy: $pathfile must not be a symlink"
    return 1
  fi
  if [[ -e "$pathfile" ]]; then
    if [[ ! -f "$pathfile" || ! -r "$pathfile" ]]; then
      fail "staging path policy: $pathfile must be a readable regular file"
      return 1
    fi
    owner="$(stat -c %u "$pathfile" 2>/dev/null)" || owner=unknown
    if [[ "$owner" != "$uid" ]]; then
      fail "staging path policy: $pathfile must be owned by the deploy user (uid $uid), not uid $owner"
      return 1
    fi
    if [[ "$(stat -c %a "$pathfile" 2>/dev/null)" != 600 ]]; then
      fail "staging path policy: $pathfile must be chmod 600"
      return 1
    fi
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
      count=$((count + 1))
      path="$line"
    done < "$pathfile"
    if (( count != 1 )); then
      fail "staging path policy: $pathfile must contain exactly one path line (found $count)"
      return 1
    fi
    if [[ ! "$path" =~ ^/[A-Za-z0-9._/-]+$ || "$path/" == */./* || "$path/" == */../* ]]; then
      fail "staging path policy: $pathfile must hold an absolute path of [A-Za-z0-9._/-] without . or .. components (content not shown)"
      return 1
    fi
  else
    path="$default"
  fi

  case "$path/" in
    "$conf_dir"/*)
      fail "staging path policy: the staging env path must not be inside $conf_dir (wrong role)"
      return 1 ;;
  esac
  real_root="$(realpath -m -- "$conf_dir" 2>/dev/null)" && real_path="$(realpath -m -- "$path" 2>/dev/null)" || {
    fail "staging path policy: could not resolve the staging env path"
    return 1
  }
  case "$real_path/" in
    "$real_root"/*)
      fail "staging path policy: the staging env path resolves inside $conf_dir (wrong role)"
      return 1 ;;
  esac
  for f in "$conf_dir"/* "$conf_dir"/.[!.]*; do
    if [[ -e "$f" && -e "$path" && "$path" -ef "$f" ]]; then
      fail "staging path policy: the staging env path is the production config file $f (wrong role)"
      return 1
    fi
  done
  printf '%s\n' "$path"
}
