import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AdminLoginLimiter, LOGIN_LIMITS } from '../../src/modules/admin-auth/admin-login-limiter';
import { AdminAuthService, LoginRateLimitedException } from '../../src/modules/admin-auth/admin-auth.service';

/** H5: per-account progressive backoff, with a fake clock. */

function memoryCache() {
  const m = new Map<string, unknown>();
  return {
    m,
    get: jest.fn(async (k: string) => m.get(k)),
    set: jest.fn(async (k: string, v: unknown) => void m.set(k, v)),
    del: jest.fn(async (k: string) => void m.delete(k)),
  };
}

function limiter() {
  const cache = memoryCache();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const l = new AdminLoginLimiter(cache as any);
  let now = 1_000_000;
  l.now = () => now;
  return { l, cache, advance: (ms: number) => (now += ms) };
}

const EMAIL = 'owner@shop.example';
const IP = '203.0.113.7';

describe('AdminLoginLimiter — progressive backoff (H5)', () => {
  it('allows the first failures, then blocks the (email, IP) pair', async () => {
    const { l } = limiter();
    for (let i = 1; i < LOGIN_LIMITS.pairFreeFailures; i += 1) {
      await l.recordFailure(EMAIL, IP);
      expect(await l.check(EMAIL, IP)).toEqual({ allowed: true });
    }
    await l.recordFailure(EMAIL, IP); // the 5th
    const d = await l.check(EMAIL, IP);
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.retryAfterSeconds).toBe(LOGIN_LIMITS.pairBaseBackoffMs / 1000);
  });

  it('the block expires on its own (no permanent lockout) and doubles per further failure, capped', async () => {
    const { l, advance } = limiter();
    for (let i = 0; i < LOGIN_LIMITS.pairFreeFailures; i += 1) await l.recordFailure(EMAIL, IP);
    const waits: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const d = await l.check(EMAIL, IP);
      if (d.allowed) throw new Error('expected a block');
      waits.push(d.retryAfterSeconds);
      advance(d.retryAfterSeconds * 1000);
      expect(await l.check(EMAIL, IP)).toEqual({ allowed: true }); // recovered
      await l.recordFailure(EMAIL, IP);
    }
    expect(waits.slice(0, 4)).toEqual([30, 60, 120, 240]);
    expect(Math.max(...waits)).toBe(LOGIN_LIMITS.pairMaxBackoffMs / 1000);
  });

  it('another IP is not blocked by one IP\'s failures (no easy DoS of the admin)', async () => {
    const { l } = limiter();
    for (let i = 0; i < LOGIN_LIMITS.pairFreeFailures + 3; i += 1) await l.recordFailure(EMAIL, IP);
    expect((await l.check(EMAIL, IP)).allowed).toBe(false);
    expect(await l.check(EMAIL, '198.51.100.9')).toEqual({ allowed: true });
  });

  it('a distributed campaign against one account triggers the account cool-down only after many failures', async () => {
    const { l, advance } = limiter();
    for (let i = 0; i < LOGIN_LIMITS.emailFreeFailures - 1; i += 1) await l.recordFailure(EMAIL, `10.0.0.${i}`);
    expect(await l.check(EMAIL, '192.0.2.1')).toEqual({ allowed: true });
    await l.recordFailure(EMAIL, '10.0.1.1');
    const d = await l.check(EMAIL, '192.0.2.1');
    expect(d.allowed).toBe(false);
    advance(LOGIN_LIMITS.emailBackoffMs);
    expect(await l.check(EMAIL, '192.0.2.1')).toEqual({ allowed: true });
  });

  it('a successful login clears the counters', async () => {
    const { l } = limiter();
    for (let i = 0; i < LOGIN_LIMITS.pairFreeFailures; i += 1) await l.recordFailure(EMAIL, IP);
    await l.reset(EMAIL, IP);
    expect(await l.check(EMAIL, IP)).toEqual({ allowed: true });
  });

  it('email matching is case/whitespace-insensitive and keys never contain the email', async () => {
    const { l, cache } = limiter();
    for (let i = 0; i < LOGIN_LIMITS.pairFreeFailures; i += 1) await l.recordFailure(' Owner@Shop.Example ', IP);
    expect((await l.check(EMAIL, IP)).allowed).toBe(false);
    for (const key of cache.m.keys()) expect(key).not.toContain('owner');
  });

  it('fails OPEN when the cache errors (the IP throttle still applies)', async () => {
    const { l, cache } = limiter();
    cache.get.mockRejectedValue(new Error('redis down'));
    expect(await l.check(EMAIL, IP)).toEqual({ allowed: true });
    await expect(l.recordFailure(EMAIL, IP)).resolves.toBeUndefined();
  });
});

describe('AdminAuthService.login — H5 behaviour', () => {
  let hash = '';
  beforeAll(async () => {
    hash = await bcrypt.hash('the-right-password-1', 4);
  });

  function service(opts: { blocked?: boolean } = {}) {
    const prisma = {
      admin: {
        findUnique: jest.fn(async ({ where }: { where: { email: string } }) =>
          where.email === EMAIL ? { id: 'adm-1', email: EMAIL, name: 'Owner', isActive: true, passwordHash: hash, roles: [{ role: { id: 'r', name: 'SUPER_ADMIN' } }] } : null),
      },
      rolePermission: { findMany: jest.fn(async () => []) },
    };
    const limiterStub = {
      check: jest.fn(async () => (opts.blocked ? { allowed: false, retryAfterSeconds: 42 } : { allowed: true })),
      recordFailure: jest.fn(async () => undefined),
      reset: jest.fn(async () => undefined),
    };
    const sessions = { create: jest.fn(async () => 'sid-1') };
    const jwt = { signAsync: jest.fn(async () => 'signed.jwt.token') };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = new AdminAuthService(prisma as any, jwt as any, sessions as any, limiterStub as any);
    return { svc, prisma, limiterStub, sessions, jwt };
  }

  it('a failed login is recorded; a successful one resets and creates a session', async () => {
    const { svc, limiterStub, sessions, jwt } = service();
    await expect(svc.login(EMAIL, 'wrong-password-x', IP)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(limiterStub.recordFailure).toHaveBeenCalledWith(EMAIL, IP);

    const ok = await svc.login(EMAIL.toUpperCase(), 'the-right-password-1', IP);
    expect(limiterStub.reset).toHaveBeenCalledWith(EMAIL, IP);
    expect(sessions.create).toHaveBeenCalledWith('adm-1', expect.any(Number));
    expect(jwt.signAsync).toHaveBeenCalledWith({ sub: 'adm-1', sid: 'sid-1', typ: 'admin_access' }, expect.objectContaining({ expiresIn: expect.any(String) }));
    expect(ok.user.role?.name).toBe('SUPER_ADMIN');
  });

  it('while blocked, even the CORRECT password is refused with 429 and no password check / DB lookup', async () => {
    const { svc, prisma, sessions } = service({ blocked: true });
    const err = await svc.login(EMAIL, 'the-right-password-1', IP).catch((e) => e);
    expect(err).toBeInstanceOf(LoginRateLimitedException);
    expect(err.getStatus()).toBe(429);
    expect(err.retryAfterSeconds).toBe(42);
    expect(prisma.admin.findUnique).not.toHaveBeenCalled();
    expect(sessions.create).not.toHaveBeenCalled();
  });

  it('unknown email, inactive admin and wrong password all fail with the same error and all run bcrypt', async () => {
    const compare = jest.spyOn(bcrypt, 'compare');
    const { svc, prisma } = service();
    await expect(svc.login('nobody@shop.example', 'x-password-123', IP)).rejects.toThrow('Invalid credentials');
    prisma.admin.findUnique.mockResolvedValueOnce({ id: 'adm-2', email: 'off@shop.example', name: 'Off', isActive: false, passwordHash: hash, roles: [] });
    await expect(svc.login('off@shop.example', 'the-right-password-1', IP)).rejects.toThrow('Invalid credentials');
    await expect(svc.login(EMAIL, 'x-password-123', IP)).rejects.toThrow('Invalid credentials');
    expect(compare).toHaveBeenCalledTimes(3);
    // The unknown/inactive paths compare against the cost-12 dummy hash.
    expect(String(compare.mock.calls[0][1])).toMatch(/^\$2[aby]\$12\$/);
    expect(String(compare.mock.calls[1][1])).toMatch(/^\$2[aby]\$12\$/);
    compare.mockRestore();
  });
});
