/**
 * P0-2 — the customer `ms_session` presence marker follows the session lifecycle.
 *
 * The marker is JS-readable ("true", no token) and only tells the storefront
 * "there may be a session, ask /users/me". It must be (re)issued whenever the
 * server issues a session (login AND refresh) and cleared on logout; a refused
 * refresh must never issue it. The httpOnly token cookies are unchanged.
 */
import { UnauthorizedException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController } from '../../src/modules/auth/presentation/auth.controller';
import type { AuthService } from '../../src/modules/auth/auth.service';

const TOKENS = { accessToken: 'access-jwt', refreshToken: 'refresh-opaque' };

function fakeRes() {
  const cookie = jest.fn();
  const clearCookie = jest.fn();
  return { res: { cookie, clearCookie } as unknown as Response, cookie, clearCookie };
}

const req = (cookies: Record<string, string> = {}) => ({ cookies }) as unknown as Request;

function controller(overrides: Partial<Record<keyof AuthService, jest.Mock>> = {}) {
  const auth = {
    loginWithGoogleIdToken: jest.fn().mockResolvedValue({ user: { id: 'u1' }, tokens: TOKENS }),
    rotateRefreshToken: jest.fn().mockResolvedValue(TOKENS),
    revokeRefreshToken: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return { ctrl: new AuthController(auth as unknown as AuthService), auth };
}

const ENV_KEYS = ['COOKIE_DOMAIN', 'COOKIE_SECURE', 'COOKIE_SAMESITE', 'JWT_REFRESH_TTL'] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.COOKIE_DOMAIN = '.shop.example';
  process.env.COOKIE_SECURE = 'true';
  process.env.COOKIE_SAMESITE = 'lax';
  process.env.JWT_REFRESH_TTL = '30d';
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const markerSets = (cookie: jest.Mock) => cookie.mock.calls.filter(([name]) => name === 'ms_session');

describe('customer session marker lifecycle', () => {
  it('a successful refresh rotates the httpOnly cookies AND renews the marker (same domain, not httpOnly, no token)', async () => {
    const { ctrl, auth } = controller();
    const { res, cookie } = fakeRes();
    await expect(ctrl.refresh({}, req({ ms_refresh: 'refresh-old' }), res)).resolves.toEqual(TOKENS);
    expect(auth.rotateRefreshToken).toHaveBeenCalledWith('refresh-old');

    const names = cookie.mock.calls.map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining(['ms_access', 'ms_refresh', 'ms_session']));
    const [[, value, opts]] = markerSets(cookie);
    expect(value).toBe('true');
    expect(opts).toMatchObject({ httpOnly: false, domain: '.shop.example', path: '/', secure: true, sameSite: 'lax' });
    expect(opts.maxAge).toBe(30 * 24 * 60 * 60 * 1000);
    // The token cookies keep their httpOnly architecture.
    for (const [name, , o] of cookie.mock.calls.filter(([n]) => n !== 'ms_session')) {
      expect({ name, httpOnly: o.httpOnly }).toEqual({ name, httpOnly: true });
    }
  });

  it('a refused refresh issues nothing - no marker, no cookies', async () => {
    const { ctrl } = controller({ rotateRefreshToken: jest.fn().mockRejectedValue(new UnauthorizedException('Invalid refresh token')) });
    const { res, cookie } = fakeRes();
    await expect(ctrl.refresh({}, req({ ms_refresh: 'stale' }), res)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(cookie).not.toHaveBeenCalled();
  });

  it('a refresh without any refresh token is a 401 and issues nothing', async () => {
    const { ctrl, auth } = controller();
    const { res, cookie } = fakeRes();
    await expect(ctrl.refresh({}, req(), res)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.rotateRefreshToken).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  });

  it('login still issues the marker; logout clears it together with the token cookies', async () => {
    const { ctrl } = controller();
    const login = fakeRes();
    await ctrl.google({ idToken: 'google-id-token' } as never, login.res);
    expect(markerSets(login.cookie)).toHaveLength(1);

    const logout = fakeRes();
    await ctrl.logout({}, req({ ms_refresh: 'refresh-opaque' }), logout.res);
    const cleared = logout.clearCookie.mock.calls.map(([name, o]) => [name, o.domain]);
    expect(cleared).toEqual(expect.arrayContaining([['ms_access', '.shop.example'], ['ms_refresh', '.shop.example'], ['ms_session', '.shop.example']]));
  });
});
