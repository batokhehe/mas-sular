import Cookies from 'js-cookie'

// Legacy JS-written token cookies. Tokens are httpOnly cookies set by the API now;
// these names are only ever REMOVED by this module (hygiene for old browsers).
const KEYS = {
  access: 'ms_access',
  refresh: 'ms_refresh',
  adminAccess: 'ms_admin_access',
} as const

// Phase 13B.2: JS-readable session-presence markers issued by the backend
// (Phase 13A.7). Non-httpOnly, value "true", carry no token — used purely for
// "is there a session" detection so session gates survive httpOnly token cutover.
const SESSION_KEYS = {
  customer: 'ms_session',
  admin: 'ms_admin_session',
} as const

const COOKIE_OPTS: Cookies.CookieAttributes = {
  sameSite: 'lax',
  secure: typeof window !== 'undefined' && window.location.protocol === 'https:',
  expires: 30,
}

export interface StoredTokens {
  access?: string
  refresh?: string
}

export function getTokens(): StoredTokens {
  return {
    access: Cookies.get(KEYS.access),
    refresh: Cookies.get(KEYS.refresh),
  }
}

export function setCustomerTokens(access: string, refresh: string): void {
  Cookies.set(KEYS.access, access, COOKIE_OPTS)
  Cookies.set(KEYS.refresh, refresh, COOKIE_OPTS)
}

export function clearCustomerTokens(): void {
  Cookies.remove(KEYS.access)
  Cookies.remove(KEYS.refresh)
}

/**
 * H4: the admin access token is an httpOnly cookie on the API host and is never
 * returned to script. Older builds of this panel wrote it into a JS-READABLE
 * host-only cookie on the storefront host; delete that copy if it still exists.
 */
export function removeLegacyAdminCookie(): void {
  Cookies.remove(KEYS.adminAccess)
}

export function clearAllTokens(): void {
  clearCustomerTokens()
  removeLegacyAdminCookie()
}

// Phase 13B.3: one-shot hygiene to delete the legacy host-only customer token
// cookies (pre-13B writers). Customer auth is now httpOnly-cookie based, so these
// must be removed to avoid duplicate same-named cookies (host-only vs Domain=).
// Distinct from clearCustomerTokens() which was the old js-cookie "logout".
export function removeLegacyCustomerCookies(): void {
  Cookies.remove(KEYS.access)
  Cookies.remove(KEYS.refresh)
}

/**
 * P0-2: drop the customer session marker once the session is known to be over (the
 * API refused the refresh) and on logout. The backend writes `ms_session` with
 * Domain=COOKIE_DOMAIN (e.g. ".baksomassular.com"), so a host-only remove alone does
 * not touch it. That domain is always this host or one of its parents - otherwise
 * the browser would have rejected the cookie - so removing it on the host and on
 * every parent (down to two labels) hits whichever copy exists. Only the marker is
 * touched: the httpOnly token cookies stay server-managed.
 */
export function clearCustomerSessionMarker(hostname?: string): void {
  Cookies.remove(SESSION_KEYS.customer)
  const host = hostname ?? (typeof window !== 'undefined' ? window.location.hostname : '')
  for (const domain of cookieDomainCandidates(host)) Cookies.remove(SESSION_KEYS.customer, { domain })
}

/** "a.b.example.com" -> ["a.b.example.com", "b.example.com", "example.com"]; none for IPs/localhost. */
export function cookieDomainCandidates(hostname: string): string[] {
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return []
  const labels = hostname.split('.')
  const out: string[] = []
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join('.'))
  return out
}

// Phase 13B.2: session presence now reads the non-httpOnly marker cookies, not
// the token cookies (which become httpOnly/unreadable after the 13B.3 cutover).
export const hasCustomerSession = (): boolean => Cookies.get(SESSION_KEYS.customer) === 'true'
export const hasAdminSession = (): boolean => Cookies.get(SESSION_KEYS.admin) === 'true'

// Hardening note: cookies set from JS are not httpOnly. For production, proxy
// auth through Next Route Handlers (BFF) that set httpOnly cookies.
