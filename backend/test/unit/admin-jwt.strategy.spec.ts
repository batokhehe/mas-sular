import { UnauthorizedException } from '@nestjs/common';
import { AdminJwtStrategy } from '../../src/modules/admin-auth/infrastructure/admin-jwt.strategy';
import { ALL_PERMISSION_NAMES } from '../../prisma/bootstrap/permission-catalogue';

/**
 * AdminJwtStrategy.validate.
 *
 * C7a: the DATABASE is the authority for role and permissions - the token carries
 * no role/permission claim, and any it carries is ignored.
 * H4: only an admin ACCESS token (`typ: admin_access`) whose server-side session
 * (`sid`) is still active is accepted. A refresh token, a token without a session,
 * or a revoked session is rejected before any database work.
 */

const SECRET = 'unit-test-admin-secret-not-a-real-key';

/** Rows shaped exactly as the join returns them: one per granted permission. */
function rows(over: { roleName?: string | null; perms?: Array<[string, string]> } = {}) {
  const roleName = over.roleName === undefined ? 'ADMIN' : over.roleName;
  const perms = over.perms ?? [['Role', 'read']];
  const base = { id: 'adm-1', email: 'admin@test.local', name: 'Test Admin', roleName };
  if (perms.length === 0) {
    return [{ ...base, subject: null, action: null }];
  }
  return perms.map(([subject, action]) => ({ ...base, subject, action }));
}

function build(queryResult: unknown[], sessionActive = true) {
  const queryRaw = jest.fn().mockResolvedValue(queryResult);
  const prisma = { $queryRaw: queryRaw };
  const config = { get: jest.fn().mockReturnValue(SECRET) };
  const sessions = { isActive: jest.fn().mockResolvedValue(sessionActive) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strategy = new AdminJwtStrategy(config as any, prisma as any, sessions as any);
  return { strategy, queryRaw, sessions };
}

/** A valid access-token payload. Stale role/permission claims are added to prove they are ignored. */
const ACCESS = { sub: 'adm-1', sid: 'sess-1', typ: 'admin_access' };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withStaleClaims = (extra: Record<string, unknown>) => ({ ...ACCESS, ...extra }) as any;

describe('AdminJwtStrategy.validate — H4: only live admin ACCESS tokens', () => {
  it('accepts an access token with an active session', async () => {
    const { strategy, sessions } = build(rows());
    const user = await strategy.validate(ACCESS);
    expect(user.sub).toBe('adm-1');
    expect(user.sid).toBe('sess-1');
    expect(user.kind).toBe('admin');
    expect(sessions.isActive).toHaveBeenCalledWith('sess-1', 'adm-1');
  });

  it.each([
    ['a refresh token (the audited 7-day token shape)', { sub: 'adm-1', email: 'a@t', type: 'refresh' }],
    ['a refresh token even carrying a sid', { sub: 'adm-1', sid: 'sess-1', typ: 'admin_refresh' }],
    ['a token with no typ (pre-H4 access token)', { sub: 'adm-1', email: 'a@t', role: 'SUPER_ADMIN', permissions: [] }],
    ['a token with no session id', { sub: 'adm-1', typ: 'admin_access' }],
    ['a token with no subject', { sid: 'sess-1', typ: 'admin_access' }],
  ])('rejects %s before touching the database', async (_label, payload) => {
    const { strategy, queryRaw, sessions } = build(rows());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(strategy.validate(payload as any)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(sessions.isActive).not.toHaveBeenCalled();
  });

  it('rejects a revoked / expired / unknown session (logout takes effect immediately)', async () => {
    const { strategy, queryRaw } = build(rows(), false);
    await expect(strategy.validate(ACCESS)).rejects.toThrow(/session has ended/i);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('fails closed when the session store cannot answer', async () => {
    const { strategy, sessions } = build(rows());
    sessions.isActive.mockResolvedValue(false); // AdminSessionStore returns false on any cache error
    await expect(strategy.validate(ACCESS)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('AdminJwtStrategy.validate — the database is the authority (C7a)', () => {
  it('returns the permissions the DB holds for an active admin', async () => {
    const { strategy } = build(rows({ perms: [['Role', 'read'], ['Order', 'read']] }));
    const user = await strategy.validate(ACCESS);
    expect(user.permissions.sort()).toEqual(['Order.read', 'Role.read']);
    expect(user.isActive).toBe(true);
  });

  it('a permission or SUPER_ADMIN role claimed by the token is NOT honoured', async () => {
    const { strategy } = build(rows({ roleName: 'ADMIN', perms: [['Role', 'read']] }));
    const user = await strategy.validate(withStaleClaims({ role: 'SUPER_ADMIN', permissions: ['Payment.verify', 'Role.update'] }));
    expect(user.role).toBe('ADMIN');
    expect(user.permissions).toEqual(['Role.read']);
  });

  it('an admin whose role was removed gets no role and no permissions', async () => {
    const { strategy } = build(rows({ roleName: null, perms: [] }));
    const user = await strategy.validate(ACCESS);
    expect(user.role).toBeNull();
    expect(user.permissions).toEqual([]);
  });

  it('an inactive admin is rejected (query filters isActive)', async () => {
    const { strategy, queryRaw } = build([]);
    await expect(strategy.validate(ACCESS)).rejects.toThrow('Admin account is no longer active');
    expect(queryRaw).toHaveBeenCalled();
  });

  it('identity fields come from the DB row, not the token', async () => {
    const { strategy } = build(rows());
    const user = await strategy.validate(withStaleClaims({ email: 'stale@test.local', name: 'Stale' }));
    expect(user.email).toBe('admin@test.local');
    expect(user.name).toBe('Test Admin');
  });

  it('SUPER_ADMIN (canonical system role) is given the whole code catalogue', async () => {
    const { strategy } = build(rows({ roleName: 'SUPER_ADMIN', perms: [['Role', 'read'], ['orders', 'view']] }));
    const user = await strategy.validate(ACCESS);
    expect(user.role).toBe('SUPER_ADMIN');
    expect(user.permissions.sort()).toEqual([...ALL_PERMISSION_NAMES].sort());
    expect(user.permissions).not.toContain('orders.view'); // legacy rows never leak through
  });

  it('a role merely NAMED "Super Admin" is not super admin (H1 alias removed)', async () => {
    const { strategy } = build(rows({ roleName: 'Super Admin', perms: [['Order', 'read']] }));
    const user = await strategy.validate(ACCESS);
    expect(user.role).toBe('Super Admin');
    expect(user.permissions).toEqual(['Order.read']);
  });

  it('SUPER_ADMIN wins when the admin holds several roles', async () => {
    const { strategy } = build([
      { id: 'adm-1', email: 'a@t', name: 'A', roleName: 'STAFF', subject: 'Order', action: 'read' },
      { id: 'adm-1', email: 'a@t', name: 'A', roleName: 'SUPER_ADMIN', subject: 'Payment', action: 'verify' },
    ]);
    const user = await strategy.validate(ACCESS);
    expect(user.role).toBe('SUPER_ADMIN');
  });

  it('exactly ONE database round-trip per request', async () => {
    const { strategy, queryRaw } = build(rows());
    await strategy.validate(ACCESS);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('the admin id is bound as a parameter, never interpolated into SQL', async () => {
    const { strategy, queryRaw } = build(rows());
    await strategy.validate({ ...ACCESS, sub: "adm-1' OR '1'='1" });
    const sql = queryRaw.mock.calls[0][0];
    expect(sql.values).toContain("adm-1' OR '1'='1");
    expect(String(sql.strings ? sql.strings.join('') : sql)).not.toContain("OR '1'='1");
  });
});
