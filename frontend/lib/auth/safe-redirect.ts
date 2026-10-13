/**
 * Post-login / post-onboarding redirect target (production-readiness H3).
 *
 * The previous guard - "starts with `/` but not `//`" - accepted `/\evil.example`.
 * Browsers treat a backslash as `/` in http(s) URLs, so that value resolves to
 * `//evil.example` and router.replace() left the site: an open redirect from the
 * real shop domain (verified in the browser before this fix).
 *
 * Only a same-origin internal PATH is accepted, decided with URL semantics:
 *   - must start with a single `/` (no scheme, no `//` protocol-relative form);
 *   - no backslash and no control character, in the raw OR the percent-decoded
 *     value (`/%5Cevil`, `/%09/evil`, tab/newline tricks);
 *   - must decode cleanly (malformed `%` sequences are rejected, not guessed at);
 *   - resolved against a sentinel origin, it must stay on that origin.
 * Anything else yields the fallback. The accepted value is returned in its
 * normalized form: pathname + search + hash.
 */
const SENTINEL_ORIGIN = 'https://internal.invalid'
const MAX_LENGTH = 2048
const BACKSLASH = 0x5c
const DEL = 0x7f
const LAST_C0_CONTROL = 0x1f

/** True for any C0 control character, DEL or backslash. */
function hasUnsafeChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= LAST_C0_CONTROL || code === DEL || code === BACKSLASH) return true
  }
  return false
}

export function safeRedirect(value: string | null | undefined, fallback = '/'): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return fallback
  if (hasUnsafeChar(value)) return fallback
  if (!value.startsWith('/') || value.startsWith('//')) return fallback

  let decoded: string
  try {
    decoded = decodeURIComponent(value)
  } catch {
    return fallback // malformed percent-encoding
  }
  if (hasUnsafeChar(decoded) || decoded.startsWith('//')) return fallback

  let url: URL
  try {
    url = new URL(value, SENTINEL_ORIGIN)
  } catch {
    return fallback
  }
  if (url.origin !== SENTINEL_ORIGIN) return fallback
  const target = `${url.pathname}${url.search}${url.hash}`
  // Dot-segment normalization can MANUFACTURE a protocol-relative path:
  // `/..//evil.example` normalizes to `//evil.example`. The returned value is what
  // the router navigates to, so it is checked again, not just the input.
  if (!target.startsWith('/') || target.startsWith('//') || hasUnsafeChar(target)) return fallback
  return target
}
