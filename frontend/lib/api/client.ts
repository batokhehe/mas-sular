import Cookies from 'js-cookie'
import { getTokens, removeLegacyCustomerCookies } from '@/lib/auth/tokens'

const BASE = `${process.env.NEXT_PUBLIC_API_URL ?? ''}/api/v1`

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ApiError'
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

function authHeader(audience: Audience): Record<string, string> {
  // Phase 13B.3: customer auth is now httpOnly-cookie based (sent via
  // credentials:'include'), so NO customer Authorization header. Admin still uses
  // Bearer until its own cutover.
  if (audience === 'admin') {
    const { adminAccess } = getTokens()
    if (adminAccess) return { Authorization: `Bearer ${adminAccess}` }
  }
  return {}
}

async function tryRefresh(): Promise<boolean> {
  try {
    // Phase 13B.3: cookie-only refresh. The httpOnly ms_refresh cookie is sent via
    // credentials:'include'; the backend rotates and re-issues httpOnly cookies in
    // the Set-Cookie response. No request body, no client-side token storage.
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
    })
    return res.ok
  } catch {
    return false
  }
}

async function request<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const { method = 'GET', body, audience = 'public', headers = {}, form } = opts

  const res = await fetch(`${BASE}${path}`, {
    method,
    // Phase 13B.1: send/receive httpOnly cookies alongside the Bearer header.
    // Bearer still wins server-side (bearer-first extractor); cookies are additive.
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
    if (await tryRefresh()) {
      return request<T>(path, opts, true)
    }
    // Refresh failed → session is dead; remove any legacy host-only cookies.
    removeLegacyCustomerCookies()
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
