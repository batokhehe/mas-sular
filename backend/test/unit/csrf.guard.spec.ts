/**
 * PAXELBOX-61AG.3.26 — BF-032: the double-submit CSRF guard.
 *
 * The guard is a pure function of the request (method, path, auth mode, XSRF
 * cookie/header), so its whole decision matrix is testable without a database or
 * an HTTP server. Browser-level proof lives in e2e/tests/security.spec.ts; this
 * pins the logic, including every exemption — an exemption nobody tests is an
 * exemption that silently widens.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from '../../src/common/auth/csrf.guard';
import { AUTH_COOKIES } from '../../src/common/auth/auth-cookies.util';
import { XSRF_COOKIE, XSRF_HEADER, generateCsrfToken } from '../../src/common/auth/csrf.util';

interface ReqInit {
  method?: string;
  path?: string;
  cookies?: Record<string, string>;
  headers?: Record<string, string>;
}

function makeCtx(init: ReqInit = {}) {
  const headers = init.headers ?? {};
  const req = {
    method: init.method ?? 'POST',
    path: init.path ?? '/api/v1/users/me/addresses',
    cookies: init.cookies ?? {},
    headers,
    header: (name: string) => headers[name.toLowerCase()],
  };
  const res = { cookie: jest.fn() };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ExecutionContext;
  return { ctx, req, res };
}

const TOKEN = 'jV3n_Ck0PqR8sT1uVwXyZaBcDeFgHiJkLmNoPqRsTuV';
/** A cookie-authenticated browser request: the ambient-credential case CSRF exists for. */
const cookieAuth = (extra: Record<string, string> = {}) => ({ [AUTH_COOKIES.access]: 'jwt', ...extra });

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();
  const original = process.env.CSRF_MODE;

  afterEach(() => {
    if (original === undefined) delete process.env.CSRF_MODE;
    else process.env.CSRF_MODE = original;
    jest.restoreAllMocks();
  });

  const setMode = (mode: 'off' | 'report' | 'enforce') => {
    process.env.CSRF_MODE = mode;
  };

  // ---------------------------------------------------------- the default ----

  it('SECURE BY DEFAULT: with CSRF_MODE unset, a cookie-auth mutation is rejected', () => {
    // The property this phase exists to establish. Nothing previously pinned the
    // default, so flipping it back to `off` would have been silent.
    delete process.env.CSRF_MODE;
    const { ctx } = makeCtx({ cookies: cookieAuth() });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('the two independent default declarations agree', () => {
    // loadCookieConfig() falls back on its own because the guard is constructed
    // outside Nest DI; if it drifted from env.validation.ts, CSRF would be off for
    // the guard while the schema claimed otherwise.
    delete process.env.CSRF_MODE;
    const { loadCookieConfig } = require('../../src/common/auth/auth-cookies.config');
    const { validateEnv } = require('../../src/common/config/env.validation');
    // validateEnv rejects an empty object on unrelated required keys, so give it
    // the minimum it needs and read the CSRF default off the result.
    const minimal = {
      DATABASE_URL: 'mysql://u:p@localhost:3306/d',
      REDIS_URL: 'redis://localhost:6379',
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      JWT_REFRESH_SECRET: 'y'.repeat(32),
      JWT_ADMIN_ACCESS_SECRET: 'z'.repeat(32),
      GOOGLE_CLIENT_ID: 'client-id',
      APP_URL: 'http://localhost:3000',
    };
    expect(loadCookieConfig({}).csrfMode).toBe('enforce');
    expect(validateEnv(minimal).CSRF_MODE).toBe('enforce');
  });

  // ------------------------------------------------------ the vulnerability --

  it('off: a cookie-authenticated mutation with NO token is accepted (the BF-032 hole)', () => {
    setMode('off');
    const { ctx } = makeCtx({ cookies: cookieAuth() });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('enforce: the same request is rejected', () => {
    setMode('enforce');
    const { ctx } = makeCtx({ cookies: cookieAuth() });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  // ------------------------------------------------------------- the matrix --

  it('enforce: rejects a header token that does not match the cookie', () => {
    setMode('enforce');
    const { ctx } = makeCtx({
      cookies: cookieAuth({ [XSRF_COOKIE]: TOKEN }),
      headers: { [XSRF_HEADER]: `${TOKEN.slice(0, -1)}X` },
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('enforce: accepts a matching cookie/header pair', () => {
    setMode('enforce');
    const { ctx } = makeCtx({
      cookies: cookieAuth({ [XSRF_COOKIE]: TOKEN }),
      headers: { [XSRF_HEADER]: TOKEN },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('enforce: %s is a safe method and needs no token', (method) => {
    setMode('enforce');
    const { ctx } = makeCtx({ method, cookies: cookieAuth() });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('enforce: %s without a token is rejected', (method) => {
    setMode('enforce');
    const { ctx } = makeCtx({ method, cookies: cookieAuth() });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('enforce: protects the ADMIN auth cookie too, not just the customer one', () => {
    setMode('enforce');
    const { ctx } = makeCtx({ cookies: { [AUTH_COOKIES.adminAccess]: 'jwt' } });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('report: logs the would-be block but never blocks', () => {
    setMode('report');
    const warn = jest.spyOn(guard['logger'], 'warn').mockImplementation(() => undefined);
    const { ctx } = makeCtx({ cookies: cookieAuth() });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[CSRF report]'));
  });

  // --------------------------------------------------------- the exemptions --
  // Each one is a deliberate hole; each needs a reason that survives review.

  it('enforce: a Bearer request bypasses — a header is not an ambient credential', () => {
    setMode('enforce');
    const { ctx } = makeCtx({
      cookies: cookieAuth(),
      headers: { authorization: 'Bearer some.jwt.value' },
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('enforce: a request with NO auth cookie bypasses — nothing to forge (webhooks)', () => {
    setMode('enforce');
    const { ctx } = makeCtx({ path: '/api/v1/payments/webhook/midtrans', cookies: {} });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it.each([
    ['/api/v1/auth/google', 'establishes the session; no session exists yet to forge'],
    ['/api/v1/auth/refresh', 'gated by the refresh cookie itself'],
    ['/api/v1/admin/auth/login', 'establishes the admin session'],
    ['/api/v1/payments/upload/abc123/file', 'anonymous, single-use-token-gated upload'],
  ])('enforce: %s is exempt (%s)', (path) => {
    setMode('enforce');
    const { ctx } = makeCtx({ path, cookies: cookieAuth() });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('enforce: LOGOUT is NOT exempt — it is a cookie-authenticated state change', () => {
    setMode('enforce');
    const { ctx } = makeCtx({ path: '/api/v1/auth/logout', cookies: cookieAuth() });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('enforce: exemption matching is anchored, so a lookalike path is NOT exempt', () => {
    setMode('enforce');
    for (const path of [
      '/api/v1/auth/refresh/evil',
      '/api/v1/evil/admin/auth/login/../../orders',
      '/api/v1/payments/upload/abc/file/steal',
    ]) {
      const { ctx } = makeCtx({ path, cookies: cookieAuth() });
      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    }
  });

  // ------------------------------------------------------- negative tokens ---

  it.each([
    ['empty header token', { [XSRF_COOKIE]: TOKEN }, { [XSRF_HEADER]: '' }],
    ['empty cookie token', { [XSRF_COOKIE]: '' }, { [XSRF_HEADER]: TOKEN }],
    ['header token but no cookie', {}, { [XSRF_HEADER]: TOKEN }],
    ['cookie token but no header', { [XSRF_COOKIE]: TOKEN }, {}],
    ['token is a prefix of the cookie', { [XSRF_COOKIE]: TOKEN }, { [XSRF_HEADER]: TOKEN.slice(0, 8) }],
    ['token is the cookie plus padding', { [XSRF_COOKIE]: TOKEN }, { [XSRF_HEADER]: `${TOKEN}AAAA` }],
    ['token in the WRONG header', { [XSRF_COOKIE]: TOKEN }, { 'x-xsrf-token': TOKEN }],
    ['malformed token', { [XSRF_COOKIE]: TOKEN }, { [XSRF_HEADER]: '../../etc/passwd' }],
  ])('enforce: rejects when %s', (_label, cookies, headers) => {
    setMode('enforce');
    const { ctx } = makeCtx({ cookies: { ...cookieAuth(), ...cookies }, headers });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('enforce: a token supplied only as a query parameter is not accepted', () => {
    setMode('enforce');
    // The guard reads the header, never the URL — a token in a query string
    // would leak through logs, referrers and browser history.
    const { ctx } = makeCtx({
      path: `/api/v1/users/me/addresses?_csrf=${TOKEN}`,
      cookies: cookieAuth({ [XSRF_COOKIE]: TOKEN }),
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('enforce: a token from another session does not validate', () => {
    setMode('enforce');
    const { ctx } = makeCtx({
      cookies: cookieAuth({ [XSRF_COOKIE]: generateCsrfToken() }),
      headers: { [XSRF_HEADER]: generateCsrfToken() },   // a different browser's token
    });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('the rejection message names no token, path detail or internals', () => {
    setMode('enforce');
    jest.spyOn(guard['logger'], 'warn').mockImplementation(() => undefined);
    const { ctx } = makeCtx({
      cookies: cookieAuth({ [XSRF_COOKIE]: TOKEN }),
      headers: { [XSRF_HEADER]: 'wrong' },
    });
    try {
      guard.canActivate(ctx);
      throw new Error('should have thrown');
    } catch (err) {
      const message = (err as ForbiddenException).message;
      expect(message).toBe('Invalid CSRF token');
      expect(message).not.toContain(TOKEN);
    }
  });

  // ---------------------------------------------------------- cookie issue ---

  it('seeds a JS-READABLE XSRF cookie when absent — in every mode', () => {
    for (const mode of ['off', 'report', 'enforce'] as const) {
      setMode(mode);
      const { ctx, res } = makeCtx({ method: 'GET' });
      guard.canActivate(ctx);
      expect(res.cookie).toHaveBeenCalledWith(
        XSRF_COOKIE,
        expect.any(String),
        expect.objectContaining({ httpOnly: false, path: '/' }),
      );
    }
  });

  it('does NOT rotate the token when the cookie already exists', () => {
    setMode('enforce');
    const { ctx, res } = makeCtx({
      method: 'GET',
      cookies: cookieAuth({ [XSRF_COOKIE]: TOKEN }),
    });
    guard.canActivate(ctx);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('never issues the auth cookie as JS-readable', () => {
    setMode('enforce');
    const { ctx, res } = makeCtx({ method: 'GET' });
    guard.canActivate(ctx);
    const issued = res.cookie.mock.calls.map((c) => c[0]);
    expect(issued).toEqual([XSRF_COOKIE]);
    expect(issued).not.toContain(AUTH_COOKIES.access);
    expect(issued).not.toContain(AUTH_COOKIES.adminAccess);
  });

  it('generates 256 bits of entropy, distinct per call', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateCsrfToken()));
    expect(tokens.size).toBe(200);
    // base64url of 32 bytes → 43 chars, alphabet strictly [A-Za-z0-9_-].
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
