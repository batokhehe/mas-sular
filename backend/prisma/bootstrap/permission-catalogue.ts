/**
 * The canonical RBAC catalogue - pure data, no imports.
 *
 * Shared by the API (src/common/auth/*), the development seed and the production
 * bootstrap, so authorization, seeding and the admin UI can never drift apart. It
 * lives under prisma/ because the migrator image ships prisma/ but not src/.
 *
 * Rules (RBAC hardening, Phase 5):
 *   - Every permission is `Subject.action`, spelled EXACTLY as the @Permissions()
 *     decorators spell it. There is no alias expansion and no pluralisation: the
 *     old `orders.view` / `categories.*` / `dashboard.view` family is gone, because
 *     the naive `Subject -> subjects` rule silently produced names like `categorys`
 *     that matched nothing.
 *   - Every permission an endpoint requires appears here, so every protected
 *     endpoint is grantable (test/unit/rbac-catalogue.spec.ts enforces this against
 *     the controllers themselves).
 *   - System roles are code-owned. Their names and permission sets cannot be edited
 *     through the API; the matrix below is the only place they change.
 */

export const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';
export const CUSTOMER_ROLE = 'CUSTOMER';

/** Roles the application itself defines. Immutable through the API. */
export const SYSTEM_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER', 'STAFF', 'CUSTOMER'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

/** Subject -> actions. The only source of permission names. */
export const PERMISSION_CATALOGUE = {
  Dashboard: ['read'],
  Product: ['read', 'create', 'update', 'delete'],
  Category: ['read', 'create', 'update', 'delete'],
  Promo: ['read', 'create', 'update', 'delete'],
  Banner: ['read', 'create', 'update', 'delete'],
  Media: ['upload'],
  Order: ['read', 'update'],
  Payment: ['read', 'verify', 'reject'],
  Shipment: ['read', 'create', 'update', 'delete'],
  User: ['read', 'update'],
  Role: ['read', 'create', 'update'],
  DeliveryCoverage: ['read', 'create', 'update', 'delete'],
  SystemLog: ['read'],
  /// External API call log (Paxel / JNE / Midtrans). Deliberately SUPER_ADMIN-only
  /// for now: the records carry sanitized provider payloads, so they are troubleshooting
  /// data for whoever operates the integrations, not day-to-day shop administration.
  IntegrationLog: ['read'],
  Queue: ['read', 'retry'],
  Incident: ['read', 'manage'],
  Notification: ['read', 'send', 'resend', 'manage'],
  Audit: ['read', 'export'],
  AuditLog: ['read'],
  PaymentAccount: ['read', 'create', 'update', 'delete', 'activate'],
  Outlet: ['read', 'create', 'update', 'delete', 'activate'],
  InventoryReservation: ['read'],
  ProductInventory: ['read', 'update'],
  StockTransfer: ['read', 'create', 'update'],
} as const satisfies Record<string, readonly string[]>;

export const PERMISSIONS: ReadonlyArray<{ subject: string; action: string }> = Object.entries(PERMISSION_CATALOGUE).flatMap(
  ([subject, actions]) => actions.map((action) => ({ subject, action })),
);

/** Every canonical permission name, `Subject.action`. */
export const ALL_PERMISSION_NAMES: readonly string[] = PERMISSIONS.map((p) => `${p.subject}.${p.action}`);

/**
 * Least-privilege grants for the code-owned roles other than SUPER_ADMIN (which
 * holds everything implicitly) and CUSTOMER (which holds no admin permission; the
 * storefront is protected by the customer JWT plus per-resource ownership checks).
 *
 * Deliberately SUPER_ADMIN-only: role administration (Role.create/update), bank
 * accounts customers pay into (PaymentAccount mutations), outlet create/delete/
 * activate (the shipping origin), system internals (SystemLog, Queue.retry,
 * Incident.manage, Notification.manage, Audit.export, AuditLog).
 */
export const ROLE_PERMISSION_MATRIX: Readonly<Record<Exclude<SystemRole, 'SUPER_ADMIN'>, readonly string[]>> = {
  // Store administrator: runs the shop day to day, owns the catalogue.
  ADMIN: [
    'Dashboard.read',
    'Product.read', 'Product.create', 'Product.update', 'Product.delete',
    'Category.read', 'Category.create', 'Category.update', 'Category.delete',
    'Promo.read', 'Promo.create', 'Promo.update', 'Promo.delete',
    'Banner.read', 'Banner.create', 'Banner.update', 'Banner.delete',
    'Media.upload',
    'Order.read', 'Order.update',
    'Payment.read', 'Payment.verify', 'Payment.reject',
    'Shipment.read', 'Shipment.create', 'Shipment.update', 'Shipment.delete',
    'User.read', 'User.update',
    'DeliveryCoverage.read', 'DeliveryCoverage.create', 'DeliveryCoverage.update', 'DeliveryCoverage.delete',
    'Notification.read', 'Notification.send', 'Notification.resend',
    'Audit.read',
    'Outlet.read', 'Outlet.update',
    'PaymentAccount.read',
    'ProductInventory.read', 'ProductInventory.update',
    'StockTransfer.read', 'StockTransfer.create', 'StockTransfer.update',
    'InventoryReservation.read',
    'Queue.read',
    'Incident.read',
  ],
  // Shift / outlet manager: orders, payment verification, fulfilment, stock. Catalogue read-only.
  MANAGER: [
    'Dashboard.read',
    'Product.read', 'Category.read', 'Promo.read', 'Banner.read',
    'Order.read', 'Order.update',
    'Payment.read', 'Payment.verify', 'Payment.reject',
    'Shipment.read', 'Shipment.create', 'Shipment.update',
    'User.read',
    'DeliveryCoverage.read',
    'Notification.read', 'Notification.send',
    'Outlet.read',
    'ProductInventory.read', 'ProductInventory.update',
    'StockTransfer.read', 'StockTransfer.create', 'StockTransfer.update',
    'InventoryReservation.read',
    'Incident.read',
  ],
  // Fulfilment staff: sees orders and moves them along. No money, no customers list, no catalogue edits.
  STAFF: [
    'Order.read', 'Order.update',
    'Payment.read',
    'Shipment.read',
    'Product.read', 'Category.read',
    'ProductInventory.read',
    'InventoryReservation.read',
    'StockTransfer.read',
    'Outlet.read',
    'Notification.read',
  ],
  CUSTOMER: [],
};

/** Upper-case, strip everything but letters/digits: "Super Admin", "super_admin", "SUPER-ADMIN" -> "SUPERADMIN". */
export function normalizeRoleName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const RESERVED_NORMALIZED = new Set([...SYSTEM_ROLES.map(normalizeRoleName), 'SUPERADMIN', 'SUPERADMINISTRATOR', 'ROOT']);

/**
 * True when a role name collides with a system role or impersonates super-admin in
 * any spelling. Custom roles may not use such a name, and no role may be renamed to one.
 */
export function isReservedRoleName(name: string): boolean {
  const normalized = normalizeRoleName(name);
  return RESERVED_NORMALIZED.has(normalized) || normalized.includes('SUPERADMIN');
}

export function isSystemRoleName(name: string): boolean {
  return (SYSTEM_ROLES as readonly string[]).includes(name);
}
