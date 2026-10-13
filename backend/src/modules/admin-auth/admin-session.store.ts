import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { randomBytes } from 'crypto';

const KEY_PREFIX = 'admin-session:';

/**
 * Server-side admin session allowlist (H4).
 *
 * Every admin access token carries a random session id (`sid`). A token is honoured
 * only while `admin-session:<sid>` exists in Redis and names the token's admin, so:
 *   - logout revokes the session immediately (the JWT alone is no longer enough);
 *   - the entry expires with the token (same TTL);
 *   - it FAILS CLOSED: an unreachable, restarted or evicting Redis makes sessions
 *     invalid (admins sign in again) - never valid-by-default. That is why this is an
 *     allowlist and not a denylist: a lost denylist entry would silently revive a
 *     revoked token.
 *
 * The sid is not a credential by itself - it is only meaningful inside a token
 * signed with JWT_ADMIN_ACCESS_SECRET.
 */
@Injectable()
export class AdminSessionStore {
  private readonly logger = new Logger(AdminSessionStore.name);

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  /** Creates a session and proves it is readable before any token referencing it is issued. */
  async create(adminId: string, ttlMs: number): Promise<string> {
    const sid = randomBytes(24).toString('base64url');
    try {
      await this.cache.set(KEY_PREFIX + sid, adminId, ttlMs);
      if ((await this.cache.get<string>(KEY_PREFIX + sid)) === adminId) return sid;
    } catch (err) {
      this.logger.error(`admin session store write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    throw new ServiceUnavailableException('Sign-in is temporarily unavailable. Please try again.');
  }

  async isActive(sid: string, adminId: string): Promise<boolean> {
    try {
      return (await this.cache.get<string>(KEY_PREFIX + sid)) === adminId;
    } catch {
      return false; // fail closed
    }
  }

  async revoke(sid: string): Promise<void> {
    try {
      await this.cache.del(KEY_PREFIX + sid);
    } catch (err) {
      // The token still expires on its own; logout must not fail because of this.
      this.logger.warn(`admin session revoke failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
