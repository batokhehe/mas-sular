import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { createHash } from 'crypto';

/**
 * Admin login brute-force protection (H5), layered on the per-IP route throttle
 * declared on the login endpoint.
 *
 * Two progressive-backoff counters, both in Redis (shared across restarts):
 *
 *   pair  = (email, client IP): the targeted case. After PAIR_FREE_FAILURES the
 *           pair must wait, doubling per further failure up to PAIR_MAX_BACKOFF_MS.
 *   email = the account across ALL IPs: a distributed guess campaign. Only after a
 *           much higher EMAIL_FREE_FAILURES does the account cool down briefly.
 *
 * Denial-of-service by design review:
 *   - there is no permanent lockout: every block expires on its own;
 *   - attempts made WHILE blocked are refused without being counted, so an attacker
 *     cannot stretch a block by hammering it;
 *   - a stranger can only affect the real admin through the email counter, which
 *     needs EMAIL_FREE_FAILURES failures per window and then lasts EMAIL_BACKOFF_MS;
 *   - a successful login clears both counters.
 * Password verification never runs for a blocked attempt, so a block really stops guessing.
 *
 * Keys hold SHA-256 digests, never the email itself. The limiter FAILS OPEN on a
 * cache error (the IP throttle still applies, and sign-in needs Redis for the
 * session anyway).
 */
export const LOGIN_LIMITS = {
  windowMs: 60 * 60 * 1000,
  pairFreeFailures: 5,
  pairBaseBackoffMs: 30_000,
  pairMaxBackoffMs: 15 * 60 * 1000,
  emailFreeFailures: 30,
  emailBackoffMs: 15 * 60 * 1000,
} as const;

interface AttemptState {
  failures: number;
  blockedUntil: number;
}

export type LimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 40);

@Injectable()
export class AdminLoginLimiter {
  private readonly logger = new Logger(AdminLoginLimiter.name);
  /** Overridable in tests. */
  now: () => number = () => Date.now();

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  private keys(email: string, ip: string) {
    const normalized = email.trim().toLowerCase();
    return {
      pair: `admin-login:pair:${digest(`${normalized}|${ip}`)}`,
      email: `admin-login:email:${digest(normalized)}`,
    };
  }

  private async read(key: string): Promise<AttemptState> {
    const raw = await this.cache.get<AttemptState>(key);
    return raw && typeof raw.failures === 'number' ? raw : { failures: 0, blockedUntil: 0 };
  }

  async check(email: string, ip: string): Promise<LimitDecision> {
    try {
      const { pair, email: emailKey } = this.keys(email, ip);
      const now = this.now();
      const blockedUntil = Math.max((await this.read(pair)).blockedUntil, (await this.read(emailKey)).blockedUntil);
      return blockedUntil > now ? { allowed: false, retryAfterSeconds: Math.ceil((blockedUntil - now) / 1000) } : { allowed: true };
    } catch (err) {
      this.logger.warn(`login limiter unavailable (failing open): ${err instanceof Error ? err.message : String(err)}`);
      return { allowed: true };
    }
  }

  async recordFailure(email: string, ip: string): Promise<void> {
    try {
      const { pair, email: emailKey } = this.keys(email, ip);
      const now = this.now();

      const p = await this.read(pair);
      p.failures += 1;
      if (p.failures >= LOGIN_LIMITS.pairFreeFailures) {
        const exponent = p.failures - LOGIN_LIMITS.pairFreeFailures;
        p.blockedUntil = now + Math.min(LOGIN_LIMITS.pairBaseBackoffMs * 2 ** exponent, LOGIN_LIMITS.pairMaxBackoffMs);
      }
      await this.cache.set(pair, p, LOGIN_LIMITS.windowMs);

      const e = await this.read(emailKey);
      e.failures += 1;
      if (e.failures >= LOGIN_LIMITS.emailFreeFailures) e.blockedUntil = now + LOGIN_LIMITS.emailBackoffMs;
      await this.cache.set(emailKey, e, LOGIN_LIMITS.windowMs);
    } catch (err) {
      this.logger.warn(`login limiter could not record a failure: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async reset(email: string, ip: string): Promise<void> {
    try {
      const { pair, email: emailKey } = this.keys(email, ip);
      await this.cache.del(pair);
      await this.cache.del(emailKey);
    } catch {
      // best effort
    }
  }
}
