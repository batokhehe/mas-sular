import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import {
  ALL_PERMISSION_NAMES,
  isReservedRoleName,
  normalizeRoleName,
  PERMISSION_CATALOGUE,
  ROLE_PERMISSION_MATRIX,
  SYSTEM_ROLES,
} from '../../prisma/bootstrap/permission-catalogue';
import { PERMISSIONS, ROLES } from '../../prisma/bootstrap/rbac';

/**
 * RBAC catalogue integrity (Phase 5). The catalogue is the only source of permission
 * names; these tests read the controllers themselves so a new @Permissions() that is
 * not grantable, or a typo, fails CI instead of silently locking everyone but
 * SUPER_ADMIN out of an endpoint.
 */

const SRC = join(__dirname, '..', '..', 'src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
  });
}

/** Every permission string passed to @Permissions(...) anywhere in src/. */
function requiredPermissions(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/@Permissions\(([^)]*)\)/g)) {
      for (const perm of match[1].matchAll(/'([^']+)'/g)) {
        found.set(perm[1], [...(found.get(perm[1]) ?? []), file.replace(SRC, 'src')]);
      }
    }
  }
  return found;
}

const catalogue = new Set(ALL_PERMISSION_NAMES);

describe('RBAC permission catalogue', () => {
  const required = requiredPermissions();

  it('finds the controllers (sanity: the scan is not silently empty)', () => {
    expect(required.size).toBeGreaterThan(40);
  });

  it('every @Permissions() on every endpoint is a grantable catalogue permission', () => {
    const missing = [...required.entries()].filter(([perm]) => !catalogue.has(perm)).map(([perm, files]) => `${perm} (${files[0]})`);
    expect(missing).toEqual([]);
  });

  it('every catalogue permission is actually required somewhere (no dead grants)', () => {
    const unused = ALL_PERMISSION_NAMES.filter((perm) => !required.has(perm));
    expect(unused).toEqual([]);
  });

  it('names are exact Subject.action - no legacy, pluralised or lower-case subjects', () => {
    for (const name of ALL_PERMISSION_NAMES) {
      expect(name).toMatch(/^[A-Z][A-Za-z]+\.[a-z]+$/);
    }
    for (const legacy of ['orders.view', 'categories.view', 'categorys.view', 'dashboard.view', 'customers.view', 'roles.delete', 'Role.delete', 'paymentAccounts.view', 'auditLogs.view']) {
      expect(catalogue.has(legacy)).toBe(false);
    }
  });

  it('has no duplicates and PERMISSIONS mirrors the catalogue', () => {
    expect(new Set(ALL_PERMISSION_NAMES).size).toBe(ALL_PERMISSION_NAMES.length);
    expect(PERMISSIONS.map((p) => `${p.subject}.${p.action}`)).toEqual(ALL_PERMISSION_NAMES);
    expect(ROLES).toEqual(SYSTEM_ROLES);
  });

  it('AuditLog (the /audit-logs endpoint) and PaymentAccount are represented exactly as required', () => {
    expect(PERMISSION_CATALOGUE.AuditLog).toEqual(['read']);
    expect(required.get('AuditLog.read')).toBeDefined();
    for (const action of ['read', 'create', 'update', 'delete', 'activate']) {
      expect(catalogue.has(`PaymentAccount.${action}`)).toBe(true);
      expect(required.has(`PaymentAccount.${action}`)).toBe(true);
    }
  });
});

describe('least-privilege role matrix', () => {
  const SUPER_ADMIN_ONLY = [
    'Role.create', 'Role.update',
    'PaymentAccount.create', 'PaymentAccount.update', 'PaymentAccount.delete', 'PaymentAccount.activate',
    'Outlet.create', 'Outlet.delete', 'Outlet.activate',
    'SystemLog.read', 'Queue.retry', 'Incident.manage', 'Notification.manage', 'Audit.export', 'AuditLog.read',
  ];

  it('every matrix grant is a catalogue permission', () => {
    for (const [role, perms] of Object.entries(ROLE_PERMISSION_MATRIX)) {
      for (const perm of perms) expect(`${role}:${catalogue.has(perm)}`).toBe(`${role}:true`);
      expect(new Set(perms).size).toBe(perms.length);
    }
  });

  it('SUPER_ADMIN is not in the matrix (it holds everything implicitly) and CUSTOMER holds nothing', () => {
    expect(Object.keys(ROLE_PERMISSION_MATRIX)).not.toContain('SUPER_ADMIN');
    expect(ROLE_PERMISSION_MATRIX.CUSTOMER).toEqual([]);
  });

  it('ADMIN, MANAGER and STAFF are NOT granted everything', () => {
    for (const role of ['ADMIN', 'MANAGER', 'STAFF'] as const) {
      expect(ROLE_PERMISSION_MATRIX[role].length).toBeLessThan(ALL_PERMISSION_NAMES.length);
      for (const perm of SUPER_ADMIN_ONLY) expect(`${role}:${ROLE_PERMISSION_MATRIX[role].includes(perm)}`).toBe(`${role}:false`);
    }
  });

  it('privilege is nested: STAFF ⊆ MANAGER ⊆ ADMIN', () => {
    const admin = new Set(ROLE_PERMISSION_MATRIX.ADMIN);
    const manager = new Set(ROLE_PERMISSION_MATRIX.MANAGER);
    for (const p of ROLE_PERMISSION_MATRIX.MANAGER) expect(`${p}:${admin.has(p)}`).toBe(`${p}:true`);
    for (const p of ROLE_PERMISSION_MATRIX.STAFF) expect(`${p}:${manager.has(p)}`).toBe(`${p}:true`);
  });

  it('STAFF cannot move money or see the customer list', () => {
    for (const perm of ['Payment.verify', 'Payment.reject', 'User.read', 'User.update', 'PaymentAccount.read']) {
      expect(ROLE_PERMISSION_MATRIX.STAFF).not.toContain(perm);
    }
  });

  it('every admin role can use the notification bell (Notification.read)', () => {
    for (const role of ['ADMIN', 'MANAGER', 'STAFF'] as const) expect(ROLE_PERMISSION_MATRIX[role]).toContain('Notification.read');
  });
});

describe('reserved role names (H1)', () => {
  it.each(['SUPER_ADMIN', 'Super Admin', 'super_admin', 'SUPER-ADMIN', 'superadmin', ' Super  Admin ', 'SuperAdministrator', 'ADMIN', 'admin', 'Manager', 'staff', 'CUSTOMER', 'Customer', 'root', 'my super admin', 'SUPER_ADMIN2'])(
    '%s is reserved',
    (name) => {
      expect(isReservedRoleName(name)).toBe(true);
    },
  );

  it.each(['Ops Lead', 'Warehouse', 'Finance-Review', 'Admin Assistant', 'Shift_2'])('%s is a valid custom role name', (name) => {
    expect(isReservedRoleName(name)).toBe(false);
  });

  it('normalisation strips case and separators', () => {
    expect(normalizeRoleName('Super-Admin_ 1')).toBe('SUPERADMIN1');
  });
});
