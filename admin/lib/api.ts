import { clearStoredPermissions } from './permissions';

const AUTH_TOKEN_KEY = 'mas-sular-admin-token';
export const ADMIN_AUTH_TOKEN_EVENT = 'mas-sular-admin-token-change';
export const ADMIN_UNAUTHORIZED_EVENT = 'mas-sular-admin-unauthorized';
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

export function getAuthToken() {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(AUTH_TOKEN_KEY);
}

export function setAuthToken(token: string | null) {
  if (typeof window === 'undefined') {
    return;
  }

  if (token) {
    isHandlingUnauthorized = false;
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
  }

  window.dispatchEvent(new Event(ADMIN_AUTH_TOKEN_EVENT));
}

export type ApiError = Error & { status?: number };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getAuthToken();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const requestUrl = `${API_URL}${path}`;

  let response: Response;
  try {
    response = await fetch(requestUrl, {
      ...init,
      headers,
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
    if (response.status === 401 && !isHandlingUnauthorized) {
      isHandlingUnauthorized = true;
      setAuthToken(null);
      clearStoredPermissions();
      window.dispatchEvent(new Event(ADMIN_UNAUTHORIZED_EVENT));
    }

    const message = typeof body === 'object' && body && 'message' in body ? (body as any).message : response.statusText || `API request failed: ${response.status}`;
    const error = new Error(message) as ApiError;
    error.status = response.status;
    throw error;
  }

  return body as T;
}
