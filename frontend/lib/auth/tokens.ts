import Cookies from 'js-cookie'

// Customer access/refresh and admin access are stored separately.
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
  adminAccess?: string
}

export function getTokens(): StoredTokens {
  return {
    access: Cookies.get(KEYS.access),
    refresh: Cookies.get(KEYS.refresh),
    adminAccess: Cookies.get(KEYS.adminAccess),
  }
}

export function setCustomerTokens(access: string, refresh: string): void {
  Cookies.set(KEYS.access, access, COOKIE_OPTS)
  Cookies.set(KEYS.refresh, refresh, COOKIE_OPTS)
}

export function setAdminToken(access: string): void {
  Cookies.set(KEYS.adminAccess, access, COOKIE_OPTS)
}

export function clearCustomerTokens(): void {
  Cookies.remove(KEYS.access)
  Cookies.remove(KEYS.refresh)
}

export function clearAdminToken(): void {
  Cookies.remove(KEYS.adminAccess)
}

export function clearAllTokens(): void {
  clearCustomerTokens()
  clearAdminToken()
}

// Phase 13B.3: one-shot hygiene to delete the legacy host-only customer token
// cookies (pre-13B writers). Customer auth is now httpOnly-cookie based, so these
// must be removed to avoid duplicate same-named cookies (host-only vs Domain=).
// Distinct from clearCustomerTokens() which was the old js-cookie "logout".
export function removeLegacyCustomerCookies(): void {
  Cookies.remove(KEYS.access)
  Cookies.remove(KEYS.refresh)
}

// Phase 13B.2: session presence now reads the non-httpOnly marker cookies, not
// the token cookies (which become httpOnly/unreadable after the 13B.3 cutover).
export const hasCustomerSession = (): boolean => Cookies.get(SESSION_KEYS.customer) === 'true'
export const hasAdminSession = (): boolean => Cookies.get(SESSION_KEYS.admin) === 'true'

// Hardening note: cookies set from JS are not httpOnly. For production, proxy
// auth through Next Route Handlers (BFF) that set httpOnly cookies.
