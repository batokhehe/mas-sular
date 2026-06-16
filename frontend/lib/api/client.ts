import { getTokens, setCustomerTokens, clearCustomerTokens } from '@/lib/auth/tokens'

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

function authHeader(audience: Audience): Record<string, string> {
  const tokens = getTokens()
  if (audience === 'customer' && tokens.access) return { Authorization: `Bearer ${tokens.access}` }
  if (audience === 'admin' && tokens.adminAccess) return { Authorization: `Bearer ${tokens.adminAccess}` }
  return {}
}

async function tryRefresh(refreshToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
    if (!res.ok) return false
    const data = (await res.json()) as { accessToken: string; refreshToken: string }
    setCustomerTokens(data.accessToken, data.refreshToken)
    return true
  } catch {
    return false
  }
}

async function request<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const { method = 'GET', body, audience = 'public', headers = {}, form } = opts

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(form ? {} : { 'Content-Type': 'application/json' }),
      ...authHeader(audience),
      ...headers,
    },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  })

  // Single transparent refresh on customer-token expiry.
  if (res.status === 401 && audience === 'customer' && !retried) {
    const { refresh } = getTokens()
    if (refresh && (await tryRefresh(refresh))) {
      return request<T>(path, opts, true)
    }
    clearCustomerTokens()
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
