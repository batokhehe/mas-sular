import { clearStoredPermissions } from './permissions';

/**
 * Admin API client (H2/H4 hardening).
 *
 * The admin access token is an httpOnly cookie (`ms_admin_access`) set by the API
 * on login. Page scripts can neither read nor store it: it is never returned in a
 * response body, never kept in localStorage, never put in a URL. Every request is
 * sent with `credentials: 'include'`, and unsafe methods echo the XSRF-TOKEN cookie
 * in X-CSRF-Token (the API's double-submit CSRF check for cookie-authenticated
 * writes).
 *
 * "Is there a session?" is answered by the JS-readable `ms_admin_session` marker
 * cookie (value "true", no token) and, authoritatively, by GET /admin/auth/me.
 */

import {
  clearAdminSessionMarker,
  hasAdminSessionMarker,
  LEGACY_AUTH_TOKEN_KEY,
  purgeLegacyStoredToken,
  readCookie,
  XSRF_COOKIE,
} from './session';

export { clearAdminSessionMarker, hasAdminSessionMarker, LEGACY_AUTH_TOKEN_KEY, purgeLegacyStoredToken };
export const ADMIN_AUTH_TOKEN_EVENT = 'mas-sular-admin-token-change';
export const ADMIN_UNAUTHORIZED_EVENT = 'mas-sular-admin-unauthorized';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
let isHandlingUnauthorized = false;

const defaultApiUrl =
  typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:3001/api/v1`
    : 'http://localhost:3001/api/v1';

const API_URL = process.env.NEXT_PUBLIC_API_URL || defaultApiUrl;

/** Single source of truth for the API origin (raw fetch/EventSource callers included). */
export function apiBaseUrl(): string {
  return API_URL;
}

purgeLegacyStoredToken();

/** Notify listeners that the session state changed (login, logout, expiry). */
export function notifyAuthChanged(): void {
  if (typeof window === 'undefined') return;
  isHandlingUnauthorized = false;
  window.dispatchEvent(new Event(ADMIN_AUTH_TOKEN_EVENT));
}

/**
 * Headers for an unsafe (state-changing) request. The XSRF-TOKEN cookie is seeded by
 * the API on any response; if it is missing (first request, cleared cookies), one
 * cheap GET seeds it before the write is sent.
 */
export async function csrfHeaders(method: string): Promise<Record<string, string>> {
  if (!UNSAFE_METHODS.has(method.toUpperCase())) return {};
  let token = readCookie(XSRF_COOKIE);
  if (!token) {
    try {
      await fetch(`${API_URL}/health`, { credentials: 'include' });
    } catch {
      // the write below will surface the network error
    }
    token = readCookie(XSRF_COOKIE);
  }
  return token ? { 'X-CSRF-Token': token } : {};
}

export type ApiError = Error & { status?: number };

function handleUnauthorized() {
  if (isHandlingUnauthorized || typeof window === 'undefined') return;
  isHandlingUnauthorized = true;
  clearAdminSessionMarker();
  clearStoredPermissions();
  window.dispatchEvent(new Event(ADMIN_AUTH_TOKEN_EVENT));
  window.dispatchEvent(new Event(ADMIN_UNAUTHORIZED_EVENT));
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  for (const [key, value] of Object.entries(await csrfHeaders(method))) headers.set(key, value);

  const requestUrl = `${API_URL}${path}`;

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      ...init,
      method,
      headers,
      credentials: 'include',
    });
  } catch (error) {
    const networkError = new Error(`Unable to connect to API server: ${error instanceof Error ? error.message : String(error)}`) as ApiError;
    throw networkError;
  }

  const text = await response.text();
  let body: unknown = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    if (response.status === 401) handleUnauthorized();

    const message = typeof body === 'object' && body && 'message' in body ? (body as any).message : response.statusText || `API request failed: ${response.status}`;
    const error = new Error(message) as ApiError;
    error.status = response.status;
    throw error;
  }

  return body as T;
}
