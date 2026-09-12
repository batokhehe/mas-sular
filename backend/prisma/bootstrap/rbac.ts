import type { PrismaClient } from '@prisma/client';

/**
 * The role and permission catalogue - the single source for BOTH the development
 * seed (prisma/seed.ts) and the production bootstrap (prisma/bootstrap-production.ts),
 * so the two can never drift apart. Moved verbatim from seed.ts.
 */
export const ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF', 'CUSTOMER'] as const;

export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

export const PERMISSIONS: ReadonlyArray<{ subject: string; action: string }> = [
  { subject: 'Dashboard', action: 'read' },
  { subject: 'Product', action: 'read' },
  { subject: 'Product', action: 'create' },
  { subject: 'Product', action: 'update' },
  { subject: 'Product', action: 'delete' },
  { subject: 'Category', action: 'read' },
  { subject: 'Category', action: 'create' },
  { subject: 'Category', action: 'update' },
  { subject: 'Category', action: 'delete' },
  { subject: 'Promo', action: 'read' },
  { subject: 'Promo', action: 'create' },
  { subject: 'Promo', action: 'update' },
  { subject: 'Promo', action: 'delete' },
  { subject: 'Banner', action: 'read' },
  { subject: 'Banner', action: 'create' },
  { subject: 'Banner', action: 'update' },
  { subject: 'Banner', action: 'delete' },
  { subject: 'Order', action: 'read' },
  { subject: 'Order', action: 'update' },
  { subject: 'Payment', action: 'read' },
  { subject: 'Payment', action: 'verify' },
  { subject: 'Payment', action: 'reject' },
  { subject: 'Shipment', action: 'read' },
  { subject: 'Shipment', action: 'create' },
  { subject: 'Shipment', action: 'update' },
  { subject: 'Shipment', action: 'delete' },
  { subject: 'User', action: 'read' },
  { subject: 'User', action: 'update' },
  { subject: 'Role', action: 'read' },
  { subject: 'Role', action: 'create' },
  { subject: 'Role', action: 'update' },
  { subject: 'Role', action: 'delete' },
  { subject: 'DeliveryCoverage', action: 'read' },
  { subject: 'DeliveryCoverage', action: 'create' },
  { subject: 'DeliveryCoverage', action: 'update' },
  { subject: 'DeliveryCoverage', action: 'delete' },
  { subject: 'SystemLog', action: 'read' },
  { subject: 'Queue', action: 'read' },
  { subject: 'Queue', action: 'retry' },
  { subject: 'Incident', action: 'read' },
  { subject: 'Incident', action: 'manage' },
  { subject: 'Notification', action: 'read' },
  { subject: 'Notification', action: 'resend' },
  { subject: 'Notification', action: 'send' },
  { subject: 'Audit', action: 'read' },
  { subject: 'Audit', action: 'export' },
  { subject: 'Notification', action: 'manage' },
  { subject: 'dashboard', action: 'view' },
  { subject: 'products', action: 'view' },
  { subject: 'products', action: 'create' },
  { subject: 'products', action: 'update' },
  { subject: 'products', action: 'delete' },
  { subject: 'categories', action: 'view' },
  { subject: 'categories', action: 'create' },
  { subject: 'categories', action: 'update' },
  { subject: 'categories', action: 'delete' },
  { subject: 'orders', action: 'view' },
  { subject: 'orders', action: 'update' },
  { subject: 'customers', action: 'view' },
  { subject: 'roles', action: 'view' },
  { subject: 'roles', action: 'create' },
  { subject: 'roles', action: 'update' },
  { subject: 'roles', action: 'delete' },
  { subject: 'paymentAccounts', action: 'view' },
  { subject: 'paymentAccounts', action: 'create' },
  { subject: 'paymentAccounts', action: 'update' },
  { subject: 'paymentAccounts', action: 'delete' },
  { subject: 'paymentAccounts', action: 'activate' },
  { subject: 'Outlet', action: 'read' },
  { subject: 'Outlet', action: 'create' },
  { subject: 'Outlet', action: 'update' },
  { subject: 'Outlet', action: 'delete' },
  { subject: 'Outlet', action: 'activate' },
  { subject: 'InventoryReservation', action: 'read' },
  { subject: 'ProductInventory', action: 'read' },
  { subject: 'ProductInventory', action: 'update' },
  { subject: 'StockTransfer', action: 'read' },
  { subject: 'StockTransfer', action: 'create' },
  { subject: 'StockTransfer', action: 'update' },
];

type RbacClient = Pick<PrismaClient, 'role' | 'permission' | 'rolePermission'>;

/**
 * Create-only and idempotent: every role, every permission, and SUPER_ADMIN's
 * grant of every permission are inserted if missing. Nothing existing is updated,
 * so re-running never alters a role or permission an operator has edited.
 */
export async function ensureRbac(prisma: RbacClient): Promise<{ superAdminRoleId: string; roles: number; permissions: number }> {
  for (const name of ROLES) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }

  const permissionIds: string[] = [];
  for (const perm of PERMISSIONS) {
    const row = await prisma.permission.upsert({
      where: { action_subject: { action: perm.action, subject: perm.subject } },
      update: {},
      create: { action: perm.action, subject: perm.subject, description: `Permission for ${perm.subject} ${perm.action}` },
    });
    permissionIds.push(row.id);
  }

  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: SUPER_ADMIN_ROLE } });
  for (const permissionId of permissionIds) {
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: superAdmin.id, permissionId } },
      update: {},
      create: { roleId: superAdmin.id, permissionId },
    });
  }

  return { superAdminRoleId: superAdmin.id, roles: ROLES.length, permissions: permissionIds.length };
}
