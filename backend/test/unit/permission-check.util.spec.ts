import { hasAllPermissions, isSuperAdmin } from '../../src/common/auth/permission-check.util';

describe('permission-check.util (shared by PermissionGuard and SuperAdminGuard)', () => {
  it('SUPER_ADMIN is recognised ONLY by the canonical system role name (H1)', () => {
    expect(isSuperAdmin({ role: 'SUPER_ADMIN' })).toBe(true);
    // The editable-name alias is gone: renaming a role to any of these grants nothing.
    for (const spoof of ['Super Admin', 'super_admin', 'SUPER ADMIN', 'super-admin', 'SuperAdmin', 'SUPER_ADMIN ', ' SUPER_ADMIN']) {
      expect(isSuperAdmin({ role: spoof })).toBe(false);
    }
    expect(isSuperAdmin({ role: 'ADMIN' })).toBe(false);
    expect(isSuperAdmin({ role: null })).toBe(false);
    expect(isSuperAdmin({})).toBe(false);
  });

  it('SUPER_ADMIN bypasses every permission check', () => {
    expect(hasAllPermissions({ role: 'SUPER_ADMIN', permissions: [] }, ['Notification.read', 'Role.update'])).toBe(true);
    expect(hasAllPermissions({ role: 'Super Admin', permissions: [] }, ['Notification.read'])).toBe(false);
  });

  it('grants only when every required permission is held', () => {
    const user = { role: 'OPS', permissions: ['Notification.read', 'SystemLog.read'] };
    expect(hasAllPermissions(user, ['Notification.read'])).toBe(true);
    expect(hasAllPermissions(user, ['Notification.read', 'SystemLog.read'])).toBe(true);
    expect(hasAllPermissions(user, ['Notification.read', 'Audit.read'])).toBe(false);
  });

  it.each([
    // [held legacy grant, required canonical permission] - none of these may match any more.
    ['orders.view', 'Order.read'],
    ['notifications.view', 'Notification.read'],
    ['categories.view', 'Category.read'],
    ['categorys.view', 'Category.read'],
    ['dashboard.view', 'Dashboard.read'],
    ['customers.view', 'User.read'],
    ['users.view', 'User.read'],
    ['roles.update', 'Role.update'],
    ['roles.delete', 'Role.update'],
    ['paymentAccounts.view', 'PaymentAccount.read'],
    ['auditLogs.view', 'AuditLog.read'],
    ['queues.retry', 'Queue.retry'],
  ])('exact match only: legacy grant %s does NOT satisfy %s', (held, required) => {
    expect(hasAllPermissions({ role: 'OPS', permissions: [held] }, [required])).toBe(false);
  });

  it('permission names are case-sensitive', () => {
    expect(hasAllPermissions({ role: 'OPS', permissions: ['order.read'] }, ['Order.read'])).toBe(false);
  });

  it('denies with no permissions; empty requirement always passes', () => {
    expect(hasAllPermissions({}, ['Notification.read'])).toBe(false);
    expect(hasAllPermissions({ permissions: undefined }, ['Notification.read'])).toBe(false);
    expect(hasAllPermissions({}, [])).toBe(true);
  });
});
