import { createHash, randomBytes, timingSafeEqual } from 'crypto';

/**
 * Selector/verifier refresh tokens (production-readiness H2).
 *
 * Presented token: `<selector>.<secret>`
 *   selector  16 random bytes (hex) - stored in clear, UNIQUE-indexed, used ONLY to
 *             find the one candidate row;
 *   secret    32 random bytes (hex) - never stored; the row keeps SHA-256(secret).
 *
 * Why SHA-256 and not bcrypt for the secret: bcrypt exists to slow down guessing of
 * LOW-entropy secrets (passwords). A 256-bit random secret cannot be guessed, so a
 * single fast hash is the right tool, and it keeps refresh/logout O(1) with no
 * event-loop-blocking work. The comparison is constant-time.
 */
export const REFRESH_SELECTOR_BYTES = 16;
export const REFRESH_SECRET_BYTES = 32;

const TOKEN_SHAPE = /^([0-9a-f]{32})\.([0-9a-f]{64})$/;

export interface IssuedRefreshToken {
  /** Returned to the client (cookie/body). Never persisted. */
  token: string;
  selector: string;
  /** SHA-256(secret), hex - what the row stores in `tokenHash`. */
  verifierHash: string;
}

export function hashRefreshSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function generateRefreshToken(): IssuedRefreshToken {
  const selector = randomBytes(REFRESH_SELECTOR_BYTES).toString('hex');
  const secret = randomBytes(REFRESH_SECRET_BYTES).toString('hex');
  return { token: `${selector}.${secret}`, selector, verifierHash: hashRefreshSecret(secret) };
}

/**
 * Split a presented token. Anything that is not exactly the issued shape - including
 * every legacy (pre-H2) UUID token - is null, and the caller rejects it WITHOUT a
 * database round trip.
 */
export function parseRefreshToken(raw: unknown): { selector: string; secret: string } | null {
  if (typeof raw !== 'string') return null;
  const match = TOKEN_SHAPE.exec(raw);
  return match ? { selector: match[1], secret: match[2] } : null;
}

/** Constant-time check of a presented secret against a stored SHA-256 hex digest. */
export function refreshSecretMatches(secret: string, storedHash: string): boolean {
  const presented = Buffer.from(hashRefreshSecret(secret), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  // A legacy bcrypt hash is not 64 hex chars, so it decodes to a different length
  // and is rejected here rather than compared.
  return stored.length === presented.length && timingSafeEqual(presented, stored);
}
