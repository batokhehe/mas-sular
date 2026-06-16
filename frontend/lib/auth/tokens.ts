import Cookies from 'js-cookie'

// Customer access/refresh and admin access are stored separately.
const KEYS = {
  access: 'ms_access',
  refresh: 'ms_refresh',
  adminAccess: 'ms_admin_access',
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

export const hasCustomerSession = (): boolean => !!Cookies.get(KEYS.access)
export const hasAdminSession = (): boolean => !!Cookies.get(KEYS.adminAccess)

// Hardening note: cookies set from JS are not httpOnly. For production, proxy
// auth through Next Route Handlers (BFF) that set httpOnly cookies.
