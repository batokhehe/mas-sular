import type { PrismaClient } from '@prisma/client';
import {
  PERMISSIONS,
  ROLE_PERMISSION_MATRIX,
  SUPER_ADMIN_ROLE,
  SYSTEM_ROLES,
} from './permission-catalogue';

/**
 * Applies the canonical catalogue (./permission-catalogue.ts) to a database - the
 * single path for the development seed, the production bootstrap and the
 * operator-run prisma/sync-rbac.ts, so the three can never drift apart.
 *
 * Split into a READ-ONLY plan and an apply step so an operator can see exactly what
 * would change on a live database before anything is written (sync-rbac --dry-run).
 */
export { PERMISSIONS, SUPER_ADMIN_ROLE } from './permission-catalogue';
export const ROLES = SYSTEM_ROLES;

type RbacClient = Pick<PrismaClient, 'role' | 'permission' | 'rolePermission'>;

export interface RbacPlan {
  missingRoles: string[];
  missingPermissions: Array<{ subject: string; action: string }>;
  /** Grants to add, as `ROLE:Subject.action`. */
  grantsToAdd: string[];
  /** Grants on system roles that the matrix does not contain (drift), as `ROLE:Subject.action`. */
  grantsToRemove: string[];
  /** Permission rows outside the catalogue (e.g. the retired `orders.view` family). Reported, never deleted. */
  legacyPermissions: string[];
}

const key = (p: { subject: string; action: string }) => `${p.subject}.${p.action}`;

/** Target grants per system role. SUPER_ADMIN is given every catalogue permission for UI/listing parity. */
function targetGrants(): Map<string, Set<string>> {
  const target = new Map<string, Set<string>>();
  target.set(SUPER_ADMIN_ROLE, new Set(PERMISSIONS.map(key)));
  for (const [role, perms] of Object.entries(ROLE_PERMISSION_MATRIX)) target.set(role, new Set(perms));
  return target;
}

/** Computes what applyRbacPlan would do. Performs reads only. */
export async function planRbacSync(prisma: RbacClient): Promise<RbacPlan> {
  const roles = await prisma.role.findMany({ select: { id: true, name: true } });
  const permissions = await prisma.permission.findMany({ select: { id: true, subject: true, action: true } });
  const grants = await prisma.rolePermission.findMany({ select: { roleId: true, permissionId: true } });

  const roleNames = new Set(roles.map((r) => r.name));
  const permissionById = new Map(permissions.map((p) => [p.id, key(p)]));
  const existingPermissions = new Set(permissions.map(key));
  const catalogue = new Set(PERMISSIONS.map(key));

  const currentByRole = new Map<string, Set<string>>();
  const roleNameById = new Map(roles.map((r) => [r.id, r.name]));
  for (const g of grants) {
    const roleName = roleNameById.get(g.roleId);
    const perm = permissionById.get(g.permissionId);
    if (!roleName || !perm) continue;
    if (!currentByRole.has(roleName)) currentByRole.set(roleName, new Set());
    currentByRole.get(roleName)!.add(perm);
  }

  const grantsToAdd: string[] = [];
  const grantsToRemove: string[] = [];
  for (const [role, target] of targetGrants()) {
    const current = currentByRole.get(role) ?? new Set<string>();
    for (const perm of target) if (!current.has(perm)) grantsToAdd.push(`${role}:${perm}`);
    // SUPER_ADMIN's extra rows are harmless (it bypasses every check); only the
    // matrix-governed roles are held to their exact set.
    if (role === SUPER_ADMIN_ROLE) continue;
    for (const perm of current) if (!target.has(perm)) grantsToRemove.push(`${role}:${perm}`);
  }

  return {
    missingRoles: SYSTEM_ROLES.filter((r) => !roleNames.has(r)),
    missingPermissions: PERMISSIONS.filter((p) => !existingPermissions.has(key(p))),
    grantsToAdd: grantsToAdd.sort(),
    grantsToRemove: grantsToRemove.sort(),
    legacyPermissions: [...existingPermissions].filter((p) => !catalogue.has(p)).sort(),
  };
}

/** Applies a plan: creates roles/permissions/grants and removes drifted system-role grants. Idempotent. */
export async function applyRbacPlan(prisma: RbacClient, plan: RbacPlan): Promise<void> {
  for (const name of plan.missingRoles) {
    await prisma.role.upsert({ where: { name }, update: {}, create: { name } });
  }
  for (const perm of plan.missingPermissions) {
    await prisma.permission.upsert({
      where: { action_subject: { action: perm.action, subject: perm.subject } },
      update: {},
      create: { action: perm.action, subject: perm.subject, description: `Permission for ${perm.subject} ${perm.action}` },
    });
  }

  const resolve = async (grant: string) => {
    const [roleName, perm] = grant.split(':');
    const [subject, action] = perm.split('.');
    const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { action_subject: { action, subject } } });
    return { roleId: role.id, permissionId: permission.id };
  };

  for (const grant of plan.grantsToAdd) {
    const ids = await resolve(grant);
    await prisma.rolePermission.upsert({ where: { roleId_permissionId: ids }, update: {}, create: ids });
  }
  for (const grant of plan.grantsToRemove) {
    const ids = await resolve(grant);
    await prisma.rolePermission.deleteMany({ where: ids });
  }
}

/**
 * Plan + apply. Roles and permissions are create-only; system-role grants are
 * brought to exactly the code matrix (those roles are not editable through the API,
 * so any difference is drift). Custom roles and legacy permission rows are never touched.
 */
export async function ensureRbac(prisma: RbacClient): Promise<{ superAdminRoleId: string; roles: number; permissions: number; plan: RbacPlan }> {
  const plan = await planRbacSync(prisma);
  await applyRbacPlan(prisma, plan);
  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: SUPER_ADMIN_ROLE } });
  return { superAdminRoleId: superAdmin.id, roles: SYSTEM_ROLES.length, permissions: PERMISSIONS.length, plan };
}
