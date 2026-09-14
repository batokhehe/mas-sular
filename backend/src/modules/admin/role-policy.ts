import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  ALL_PERMISSION_NAMES,
  CUSTOMER_ROLE,
  isReservedRoleName,
  isSystemRoleName,
  SUPER_ADMIN_ROLE,
} from '../../../prisma/bootstrap/permission-catalogue';

/**
 * Role-administration policy (H1). Enforced in AdminService - behind SuperAdminGuard
 * on the routes - so the rules hold for every caller, not only the HTTP surface.
 *
 *   - Only SUPER_ADMIN (the canonical system role, resolved from the database by
 *     AdminJwtStrategy - never from client input) may create or edit roles.
 *   - System roles (SUPER_ADMIN, ADMIN, MANAGER, STAFF, CUSTOMER) are immutable
 *     through the API: name AND permission set. Their grants live in
 *     prisma/bootstrap/permission-catalogue.ts. This is also what stops anyone from
 *     renaming, stripping or demoting SUPER_ADMIN, and from turning CUSTOMER into an
 *     administrative role.
 *   - No role may carry a reserved name ("SUPER_ADMIN", "Super Admin", "super-admin",
 *     "ADMIN", ...), whatever its spelling.
 *   - A caller may not edit a role they hold themselves.
 *   - Only catalogue permissions can be granted (no legacy/dead rows).
 */

export interface RoleActor {
  sub: string;
  role?: string | null;
}

const ROLE_NAME_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 _-]{1,49}$/;
const CATALOGUE = new Set(ALL_PERMISSION_NAMES);

export function assertRoleAdministrator(actor: RoleActor | undefined): void {
  if (actor?.role !== SUPER_ADMIN_ROLE) {
    throw new ForbiddenException('Only a Super Admin can manage roles');
  }
}

export function assertMutableRole(role: { name: string }): void {
  if (isSystemRoleName(role.name)) {
    throw new ForbiddenException(`${role.name} is a system role and cannot be modified`);
  }
}

/** Trimmed, well-formed, non-reserved custom role name. */
export function validateCustomRoleName(raw: string): string {
  const name = raw.trim();
  if (!ROLE_NAME_SHAPE.test(name)) {
    throw new BadRequestException('Role name must be 2-50 characters: letters, digits, spaces, "-" or "_"');
  }
  if (isReservedRoleName(name)) {
    throw new ForbiddenException(`"${name}" is reserved for a system role`);
  }
  return name;
}

/** Every requested id must be an existing, canonical catalogue permission. */
export function assertGrantablePermissions(
  requestedIds: readonly string[],
  found: ReadonlyArray<{ id: string; subject: string; action: string }>,
): void {
  const byId = new Map(found.map((p) => [p.id, `${p.subject}.${p.action}`]));
  const invalid = [...new Set(requestedIds)].filter((id) => {
    const name = byId.get(id);
    return !name || !CATALOGUE.has(name);
  });
  if (invalid.length > 0) {
    throw new BadRequestException(`Unknown or non-grantable permission id(s): ${invalid.length}`);
  }
}

/** Customer accounts may only ever hold the CUSTOMER role (L3). */
export function assertCustomerRoles(requested: readonly string[], roles: ReadonlyArray<{ id: string; name: string }>): void {
  const byId = new Map(roles.map((r) => [r.id, r.name]));
  for (const id of new Set(requested)) {
    const name = byId.get(id);
    if (!name) throw new BadRequestException('Unknown role id');
    if (name !== CUSTOMER_ROLE) {
      throw new ForbiddenException('Customer accounts can only hold the CUSTOMER role; administrative roles cannot be assigned here');
    }
  }
}
