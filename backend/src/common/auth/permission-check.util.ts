/**
 * Pure permission predicate shared by PermissionGuard and any endpoint that must
 * authorize outside the guard pipeline. Single source of truth for the SUPER_ADMIN
 * bypass.
 *
 * RBAC hardening (H1 / Phase 5):
 *   - SUPER_ADMIN is recognised ONLY by the canonical, immutable system role name
 *     `SUPER_ADMIN`. The former `'Super Admin'` spelling was an editable-name alias:
 *     anyone able to rename a role to "Super Admin" became a super admin.
 *   - Permissions match EXACTLY. The legacy alias expansion (`Order.read` also
 *     accepting `orders.view`) is gone; its naive pluralisation produced names such
 *     as `categorys.view` that matched nothing and made grants silently ineffective.
 *
 * `role` must come from the database (AdminJwtStrategy.validate), never from a
 * client-supplied token claim.
 */
import { SUPER_ADMIN_ROLE } from '../../../prisma/bootstrap/permission-catalogue';

export interface PermissionSubject {
  role?: string | null;
  permissions?: string[];
}

export function isSuperAdmin(user: PermissionSubject): boolean {
  return user.role === SUPER_ADMIN_ROLE;
}

/** True when the user is SUPER_ADMIN or holds every required permission (exact names). */
export function hasAllPermissions(user: PermissionSubject, required: string[]): boolean {
  if (required.length === 0) return true;
  if (isSuperAdmin(user)) return true;

  const granted = new Set(user.permissions ?? []);
  return required.every((permission) => granted.has(permission));
}
