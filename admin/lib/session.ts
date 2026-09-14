/**
 * Browser-side admin session helpers (H2/H4). Dependency-free on purpose so the
 * node:test suite can exercise them directly (lib/session.test.ts).
 *
 * Nothing here ever sees the admin access token: it is an httpOnly cookie. The only
 * JS-readable session signal is the `ms_admin_session` marker (value "true").
 */

/** The key the pre-hardening client stored the admin JWT under. */
export const LEGACY_AUTH_TOKEN_KEY = 'mas-sular-admin-token';
export const SESSION_MARKER_COOKIE = 'ms_admin_session';
export const XSRF_COOKIE = 'XSRF-TOKEN';

export function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) return decodeURIComponent(trimmed.slice(prefix.length));
  }
  return undefined;
}

/** One-time hygiene: browsers that used the old client still hold a JWT in localStorage. */
export function purgeLegacyStoredToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(LEGACY_AUTH_TOKEN_KEY);
  } catch {
    // storage unavailable - nothing to purge
  }
}

/** True when the API has marked an admin session in this browser (no token involved). */
export function hasAdminSessionMarker(): boolean {
  return readCookie(SESSION_MARKER_COOKIE) === 'true';
}

/**
 * Best-effort removal of the session marker from page script (e.g. after a 401),
 * covering the host-only form and every parent domain it may have been set on.
 */
export function clearAdminSessionMarker(): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  const expire = `${SESSION_MARKER_COOKIE}=; Max-Age=0; Path=/`;
  document.cookie = expire;
  const labels = window.location.hostname.split('.');
  for (let i = 1; i < labels.length - 1; i += 1) {
    document.cookie = `${expire}; Domain=.${labels.slice(i).join('.')}`;
  }
}
