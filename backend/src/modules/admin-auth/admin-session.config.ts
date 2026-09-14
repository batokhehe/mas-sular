/**
 * Admin session lifetime (H4). Admin access tokens live for HOURS, not days: the
 * audit found JWT_ADMIN_ACCESS_TTL=6d plus a 7-day refresh token that the strategy
 * accepted as an access token. There is no admin refresh token any more - when the
 * access token expires the admin signs in again.
 *
 * Accepted format: `<n>s | <n>m | <n>h` (days are deliberately not accepted), at
 * most ADMIN_ACCESS_TTL_MAX_MS. env.validation.ts enforces the same rule at boot so
 * a long-lived value can never reach production.
 */
export const ADMIN_ACCESS_TTL_DEFAULT = '8h';
export const ADMIN_ACCESS_TTL_MAX_MS = 12 * 60 * 60 * 1000;
export const ADMIN_ACCESS_TTL_PATTERN = /^(\d+)([smh])$/;

/** The `typ` claim every admin access token carries; anything else is rejected. */
export const ADMIN_ACCESS_TOKEN_TYPE = 'admin_access';

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000 };

/** Milliseconds for a valid TTL string, or null when the value is malformed, zero or above the cap. */
export function adminAccessTtlToMs(value: string): number | null {
  const match = ADMIN_ACCESS_TTL_PATTERN.exec(value.trim());
  if (!match) return null;
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  return ms > 0 && ms <= ADMIN_ACCESS_TTL_MAX_MS ? ms : null;
}

export interface AdminSessionConfig {
  /** Passed to jwt.sign as expiresIn (e.g. "8h"). */
  ttl: string;
  ttlMs: number;
}

export function loadAdminSessionConfig(env: NodeJS.ProcessEnv = process.env): AdminSessionConfig {
  const ttl = env.JWT_ADMIN_ACCESS_TTL?.trim() || ADMIN_ACCESS_TTL_DEFAULT;
  const ttlMs = adminAccessTtlToMs(ttl);
  if (ttlMs === null) {
    throw new Error(
      `JWT_ADMIN_ACCESS_TTL must be <n>s|<n>m|<n>h and at most ${ADMIN_ACCESS_TTL_MAX_MS / 3_600_000}h (got an invalid value)`,
    );
  }
  return { ttl, ttlMs };
}
