import { AdminJwtStrategy } from '../../src/modules/admin-auth/infrastructure/admin-jwt.strategy';

/**
 * Regression for the MySQL -> PostgreSQL migration (Class B: SILENT failures).
 *
 * PostgreSQL folds every UNQUOTED identifier to lower case. The admin permission
 * query selects `r.name AS roleName` and joins on camelCase foreign keys
 * (ar.adminId, ar.roleId, rp.permissionId, rp.roleId, a.isActive). Under MySQL
 * those needed no quoting. Under PostgreSQL:
 *
 *   - an unquoted ALIAS comes back as `rolename`, so AdminAuthRow.roleName reads
 *     `undefined`. No error is raised. `role` resolves to null, isSuperAdmin()
 *     turns false, and a SUPER_ADMIN silently loses the expanded permission set.
 *   - an unquoted JOIN COLUMN does raise (42703), so it fails loudly instead.
 *
 * The alias case is the dangerous one: authorization degrades with no exception
 * anywhere. These tests pin the quoting in the emitted SQL so it cannot regress,
 * and prove the downstream consequence if it ever did.
 *
 * The end-to-end proof (a real SUPER_ADMIN resolving real permissions against a
 * real PostgreSQL) lives in the integration suite; this file is the cheap guard.
 */

const SECRET = 'unit-test-admin-secret-not-a-real-key';

function buildAndCapture(queryResult: unknown[]) {
  const queryRaw = jest.fn().mockResolvedValue(queryResult);
  const prisma = { $queryRaw: queryRaw };
  const config = { get: jest.fn().mockReturnValue(SECRET) };
  const sessions = { isActive: jest.fn().mockResolvedValue(true) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const strategy = new AdminJwtStrategy(config as any, prisma as any, sessions as any);
  return { strategy, queryRaw };
}

const TOKEN = { sub: 'adm-1', sid: 'sess-1', typ: 'admin_access' };

/** The SQL text Prisma would send, recovered from the tagged-template fragments. */
function emittedSql(queryRaw: jest.Mock): string {
  const arg = queryRaw.mock.calls[0][0] as { strings?: string[]; sql?: string; text?: string };
  if (Array.isArray(arg.strings)) return arg.strings.join(' ? ');
  return arg.sql ?? arg.text ?? String(arg);
}

describe('AdminJwtStrategy — PostgreSQL identifier quoting', () => {
  it('quotes the roleName output alias so it survives PostgreSQL case folding', async () => {
    const { strategy, queryRaw } = buildAndCapture([
      { id: 'adm-1', email: 'a@test.local', name: 'A', roleName: 'SUPER_ADMIN', subject: 'Role', action: 'read' },
    ]);
    await strategy.validate(TOKEN);

    const sql = emittedSql(queryRaw);
    expect(sql).toContain('AS "roleName"');
    // The bare form is what silently breaks authorization — it must not come back.
    expect(sql).not.toMatch(/AS\s+roleName\b/);
  });

  it('quotes every camelCase join/filter column', async () => {
    const { strategy, queryRaw } = buildAndCapture([
      { id: 'adm-1', email: 'a@test.local', name: 'A', roleName: 'ADMIN', subject: 'Role', action: 'read' },
    ]);
    await strategy.validate(TOKEN);

    const sql = emittedSql(queryRaw);
    for (const ident of ['"adminId"', '"roleId"', '"permissionId"', '"isActive"']) {
      expect(sql).toContain(ident);
    }
    // Unquoted camelCase would be folded to lower case and raise 42703 on PostgreSQL.
    expect(sql).not.toMatch(/ar\.adminId\b/);
    expect(sql).not.toMatch(/ar\.roleId\b/);
    expect(sql).not.toMatch(/rp\.permissionId\b/);
    expect(sql).not.toMatch(/a\.isActive\b/);
  });

  it('addresses the real tables by their quoted PascalCase names', async () => {
    const { strategy, queryRaw } = buildAndCapture([
      { id: 'adm-1', email: 'a@test.local', name: 'A', roleName: 'ADMIN', subject: 'Role', action: 'read' },
    ]);
    await strategy.validate(TOKEN);

    const sql = emittedSql(queryRaw);
    for (const table of ['"Admin"', '"AdminRole"', '"Role"', '"Permission"', '"RolePermission"']) {
      expect(sql).toContain(table);
    }
  });

  it('DEMONSTRATES the degradation: a lower-cased alias strips SUPER_ADMIN of its role', async () => {
    // Exactly what PostgreSQL would hand back if `AS "roleName"` lost its quotes:
    // the value is present, but under the folded key, so roleName reads undefined.
    const folded = [
      { id: 'adm-1', email: 'a@test.local', name: 'A', rolename: 'SUPER_ADMIN', subject: 'Role', action: 'read' },
    ];
    const { strategy } = buildAndCapture(folded);
    const result = await strategy.validate(TOKEN);

    // No exception is thrown anywhere — the account simply stops being super.
    expect(result.role).toBeNull();

    // And with the alias quoted (what the code now does), the role is preserved.
    const { strategy: ok } = buildAndCapture([
      { id: 'adm-1', email: 'a@test.local', name: 'A', roleName: 'SUPER_ADMIN', subject: 'Role', action: 'read' },
    ]);
    expect((await ok.validate(TOKEN)).role).toBe('SUPER_ADMIN');
  });
});
