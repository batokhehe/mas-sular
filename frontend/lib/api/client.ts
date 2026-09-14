import Cookies from 'js-cookie'
import { clearCustomerSessionMarker, removeLegacyCustomerCookies } from '@/lib/auth/tokens'

const BASE = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/v1`

export class ApiError extends Error {
  // Explicit fields (not constructor parameter properties) so node's type-stripping
  // test runner can load this module; same public shape as before.
  readonly status: number
  readonly body?: unknown

  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

export type Audience = 'customer' | 'admin' | 'public'

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  audience?: Audience
  headers?: Record<string, string>
  form?: FormData
}

// Phase 13B.4: stateless double-submit CSRF. The backend's CsrfGuard sets the
// non-httpOnly XSRF-TOKEN cookie; we echo it back in X-CSRF-Token on unsafe
// methods only. Safe methods (GET/HEAD/OPTIONS) never carry it.
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function getCsrfToken(): string | undefined {
  return Cookies.get('XSRF-TOKEN')
}

function csrfHeader(method: string): Record<string, string> {
  if (!UNSAFE_METHODS.has(method.toUpperCase())) return {}
  const token = getCsrfToken()
  return token ? { 'X-CSRF-Token': token } : {}
}

function authHeader(_audience: Audience): Record<string, string> {
  // Customer (Phase 13B.3) AND admin (H4) auth are httpOnly-cookie based, sent via
  // credentials:'include'. No Authorization header is ever built from script.
  return {}
}

/**
 * 'ok' - rotated; 'rejected' - the API refused the refresh token (401/403: missing,
 * expired, revoked or already used), so the session is over; 'failed' - network or
 * server trouble, which says nothing about the session.
 */
export type RefreshOutcome = 'ok' | 'rejected' | 'failed'

async function tryRefresh(): Promise<RefreshOutcome> {
  try {
    // Phase 13B.3: cookie-only refresh. The httpOnly ms_refresh cookie is sent via
    // credentials:'include'; the backend rotates and re-issues httpOnly cookies in
    // the Set-Cookie response. No request body, no client-side token storage.
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    if (res.ok) return 'ok'
    return res.status === 401 || res.status === 403 ? 'rejected' : 'failed'
  } catch {
    return 'failed'
  }
}

// P0-2: refresh tokens are single-use, so parallel 401s (e.g. /users/me and
// /users/addresses on the same page) must share ONE refresh. Otherwise the second
// call presents the already-rotated token, is refused, and would end a live session.
let refreshInFlight: Promise<RefreshOutcome> | null = null

function refreshOnce(): Promise<RefreshOutcome> {
  refreshInFlight ??= tryRefresh().finally(() => {
    refreshInFlight = null
  })
  return refreshInFlight
}

async function request<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const { method = 'GET', body, audience = 'public', headers = {}, form } = opts

  const res = await fetch(`${BASE}${path}`, {
    method,
    // The httpOnly session cookies (customer and admin) are the credentials: sent
    // and received via credentials:'include'. No token is ever handled by script.
    credentials: 'include',
    headers: {
      ...(form ? {} : { 'Content-Type': 'application/json' }),
      ...authHeader(audience),
      ...csrfHeader(method),
      ...headers,
    },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })

  // Single transparent cookie refresh on customer 401, then retry the original request.
  if (res.status === 401 && audience === 'customer' && !retried) {
    const outcome = await refreshOnce()
    if (outcome === 'ok') {
      return request<T>(path, opts, true)
    }
    // Refresh failed → remove any legacy host-only cookies.
    removeLegacyCustomerCookies()
    // P0-2: the API refused the refresh token, so the session is over. Drop the
    // ms_session marker too - it is what re-enables /users/me on every page load,
    // which turned a dead session into a 401 (+ toast) on each navigation. With it
    // gone the storefront is simply signed out until the next login sets it again.
    if (outcome === 'rejected') clearCustomerSessionMarker()
  }

  const text = await res.text()
  const json = text ? (JSON.parse(text) as unknown) : undefined
  if (!res.ok) {
    const message =
      (json as { message?: string } | undefined)?.message ?? res.statusText ?? 'Request failed'
    throw new ApiError(res.status, message, json)
  }
  return json as T
}

export const api = {
  get: <T>(path: string, audience?: Audience) => request<T>(path, { audience }),
  post: <T>(path: string, body?: unknown, audience?: Audience, headers?: Record<string, string>) =>
    request<T>(path, { method: 'POST', body, audience, headers }),
  patch: <T>(path: string, body?: unknown, audience?: Audience) =>
    request<T>(path, { method: 'PATCH', body, audience }),
  del: <T>(path: string, audience?: Audience) => request<T>(path, { method: 'DELETE', audience }),
  upload: <T>(path: string, form: FormData, audience?: Audience) =>
    request<T>(path, { method: 'POST', form, audience }),
}

export function buildQuery(params: Record<string, unknown>): string {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')
  return qs ? `?${qs}` : ''
}
