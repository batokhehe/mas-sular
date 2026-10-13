import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminService } from '../../src/modules/admin/admin.service';
import { AdminOperationsController } from '../../src/modules/admin/presentation/admin-operations.controller';
import { SuperAdminGuard } from '../../src/common/guards/super-admin.guard';
import { ALL_PERMISSION_NAMES } from '../../prisma/bootstrap/permission-catalogue';

/**
 * H1 regression: role administration cannot be used to escalate privileges.
 *
 * The old code let anyone holding Role.update rename ANY role (including their own)
 * to "Super Admin" - which isSuperAdmin() treated as super admin - grant their own
 * role every permission, rename SUPER_ADMIN (demoting every super admin) or rename
 * CUSTOMER (breaking customer sign-in).
 */

const T1 = '2026-09-13T10:00:00.000Z';

// Canonical catalogue rows as the Permission table holds them, plus one retired legacy row.
const PERMISSION_ROWS = [
  ...ALL_PERMISSION_NAMES.map((name, i) => {
    const [subject, action] = name.split('.');
    return { id: `perm-${i}`, subject, action };
  }),
  { id: 'perm-legacy', subject: 'orders', action: 'view' },
];
const ALL_IDS = PERMISSION_ROWS.filter((p) => p.id !== 'perm-legacy').map((p) => p.id);

const ROLES: Record<string, { id: string; name: string }> = {
  super: { id: 'role-super', name: 'SUPER_ADMIN' },
  admin: { id: 'role-admin', name: 'ADMIN' },
  manager: { id: 'role-manager', name: 'MANAGER' },
  staff: { id: 'role-staff', name: 'STAFF' },
  customer: { id: 'role-customer', name: 'CUSTOMER' },
  ops: { id: 'role-ops', name: 'Ops Lead' },
};
const roleById = (id: string) => Object.values(ROLES).find((r) => r.id === id) ?? null;

/** Admin -> role ids held. */
const HOLDINGS: Record<string, string[]> = {
  'adm-super': ['role-super'],
  'adm-admin': ['role-admin'],
  'adm-manager': ['role-manager'],
  'adm-staff': ['role-staff'],
  'adm-ops': ['role-ops'],
  'adm-super-ops': ['role-super', 'role-ops'],
};

function build() {
  const writes = { roleCreate: jest.fn(), roleUpdateMany: jest.fn(), rpDelete: jest.fn(), rpCreate: jest.fn(), userUpdate: jest.fn() };
  const tx = {
    role: {
      updateMany: writes.roleUpdateMany.mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => ({ ...roleById(where.id), permissions: [] })),
    },
    rolePermission: { deleteMany: writes.rpDelete.mockResolvedValue({ count: 0 }), createMany: writes.rpCreate.mockResolvedValue({ count: 0 }) },
  };
  const prisma = {
    role: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const r = roleById(where.id);
        return r ? { ...r, permissions: [] } : null;
      }),
      findFirst: jest.fn(async ({ where }: { where: { name: { equals: string }; NOT?: { id: string } } }) => {
        const hit = Object.values(ROLES).find((r) => r.name.toLowerCase() === where.name.equals.toLowerCase() && r.id !== where.NOT?.id);
        return hit ? { id: hit.id } : null;
      }),
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map(roleById).filter(Boolean)),
      create: writes.roleCreate.mockImplementation(async ({ data }: { data: { name: string } }) => ({ id: 'role-new', name: data.name, permissions: [] })),
    },
    adminRole: {
      findFirst: jest.fn(async ({ where }: { where: { adminId: string; roleId: string } }) =>
        (HOLDINGS[where.adminId] ?? []).includes(where.roleId) ? { roleId: where.roleId } : null),
    },
    permission: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => PERMISSION_ROWS.filter((p) => where.id.in.includes(p.id))),
    },
    user: {
      findUnique: jest.fn(async () => ({ id: 'user-1', deletedAt: null })),
      update: writes.userUpdate.mockResolvedValue({ id: 'user-1' }),
    },
    userRole: { deleteMany: jest.fn() },
    $transaction: jest.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as (t: typeof tx) => unknown)(tx) : Promise.all(arg as unknown[]))),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AdminService(prisma as any, {} as any);
  return { service, writes };
}

const actor = (sub: string, role: string) => ({ sub, role });
const SUPER = actor('adm-super', 'SUPER_ADMIN');
const ADMIN = actor('adm-admin', 'ADMIN');
const MANAGER = actor('adm-manager', 'MANAGER');
const STAFF = actor('adm-staff', 'STAFF');
const OPS = actor('adm-ops', 'Ops Lead');

function guardContext(user: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => ({ user }) }) } as unknown as ExecutionContext;
}

describe('H1: role administration is SUPER_ADMIN-only', () => {
  it.each([ADMIN, MANAGER, STAFF, OPS])('Role.update by %p is forbidden (service layer)', async (who) => {
    const { service, writes } = build();
    await expect(service.updateRole('role-ops', { expectedUpdatedAt: T1, description: 'x' }, who)).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes.roleUpdateMany).not.toHaveBeenCalled();
  });

  it.each([ADMIN, MANAGER, STAFF])('Role.create by %p is forbidden', async (who) => {
    const { service, writes } = build();
    await expect(service.createRole({ name: 'Shadow', permissionIds: ALL_IDS }, who)).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes.roleCreate).not.toHaveBeenCalled();
  });

  it('SuperAdminGuard rejects every non-SUPER_ADMIN principal, including a role named "Super Admin"', () => {
    const guard = new SuperAdminGuard();
    for (const user of [ADMIN, MANAGER, STAFF, actor('x', 'Super Admin'), actor('x', 'super_admin'), undefined]) {
      expect(() => guard.canActivate(guardContext(user))).toThrow(ForbiddenException);
    }
    expect(guard.canActivate(guardContext(SUPER))).toBe(true);
  });

  it('the role-mutation routes carry SuperAdminGuard (not only the permission check)', () => {
    for (const handler of ['createRole', 'updateRole'] as const) {
      const guards = Reflect.getMetadata(GUARDS_METADATA, AdminOperationsController.prototype[handler]) ?? [];
      expect(guards).toContain(SuperAdminGuard);
    }
  });
});

describe('H1: no path to super-admin through role names or permissions', () => {
  it.each(['SUPER_ADMIN', 'Super Admin', 'super-admin', 'SuperAdmin', 'ADMIN'])('renaming own role to %s is forbidden', async (name) => {
    const { service, writes } = build();
    // As the role's own holder (not super admin):
    await expect(service.updateRole('role-ops', { expectedUpdatedAt: T1, name }, OPS)).rejects.toBeInstanceOf(ForbiddenException);
    // And even a SUPER_ADMIN may not give any custom role a reserved name:
    await expect(service.updateRole('role-ops', { expectedUpdatedAt: T1, name }, SUPER)).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes.roleUpdateMany).not.toHaveBeenCalled();
  });

  it('granting ALL permissions to one\'s own role is forbidden', async () => {
    const { service, writes } = build();
    await expect(service.updateRole('role-ops', { expectedUpdatedAt: T1, permissionIds: ALL_IDS }, OPS)).rejects.toBeInstanceOf(ForbiddenException);
    // A SUPER_ADMIN who also holds the custom role cannot edit it either.
    await expect(
      service.updateRole('role-ops', { expectedUpdatedAt: T1, permissionIds: ALL_IDS }, actor('adm-super-ops', 'SUPER_ADMIN')),
    ).rejects.toThrow(/role you hold/);
    expect(writes.rpCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['SUPER_ADMIN', 'role-super'],
    ['CUSTOMER', 'role-customer'],
    ['ADMIN', 'role-admin'],
    ['MANAGER', 'role-manager'],
    ['STAFF', 'role-staff'],
  ])('modifying the system role %s is forbidden, even for SUPER_ADMIN', async (_name, id) => {
    const { service, writes } = build();
    for (const dto of [
      { expectedUpdatedAt: T1, name: 'Renamed' },
      { expectedUpdatedAt: T1, permissionIds: [] }, // strip / demote
      { expectedUpdatedAt: T1, permissionIds: ALL_IDS }, // e.g. turn CUSTOMER administrative
    ]) {
      await expect(service.updateRole(id, dto, SUPER)).rejects.toThrow(/system role/);
    }
    expect(writes.roleUpdateMany).not.toHaveBeenCalled();
    expect(writes.rpDelete).not.toHaveBeenCalled();
  });

  it('creating a role with a reserved name is forbidden', async () => {
    const { service } = build();
    for (const name of ['Super Admin', 'SUPER_ADMIN', 'customer']) {
      await expect(service.createRole({ name }, SUPER)).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('legacy / unknown permission ids cannot be granted', async () => {
    const { service } = build();
    await expect(service.createRole({ name: 'Ops Two', permissionIds: ['perm-legacy'] }, SUPER)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.createRole({ name: 'Ops Two', permissionIds: ['does-not-exist'] }, SUPER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a case-insensitive name clash is refused', async () => {
    const { service } = build();
    await expect(service.createRole({ name: 'ops lead' }, SUPER)).rejects.toThrow(/already exists/);
  });
});

describe('SUPER_ADMIN can still manage permitted role configuration', () => {
  it('creates a custom role with catalogue permissions', async () => {
    const { service, writes } = build();
    await service.createRole({ name: '  Warehouse  ', permissionIds: [ALL_IDS[0], ALL_IDS[1], ALL_IDS[1]] }, SUPER);
    const data = writes.roleCreate.mock.calls[0][0].data;
    expect(data.name).toBe('Warehouse');
    expect(data.permissions.create).toEqual([{ permissionId: ALL_IDS[0] }, { permissionId: ALL_IDS[1] }]); // de-duplicated
  });

  it('renames and re-permissions a custom role it does not hold', async () => {
    const { service, writes } = build();
    await service.updateRole('role-ops', { expectedUpdatedAt: T1, name: 'Ops Lead 2', permissionIds: [ALL_IDS[2]] }, SUPER);
    expect(writes.roleUpdateMany.mock.calls[0][0].data.name).toBe('Ops Lead 2');
    expect(writes.rpCreate.mock.calls[0][0].data).toEqual([{ roleId: 'role-ops', permissionId: ALL_IDS[2] }]);
  });
});

describe('L3: customer management cannot create administrators', () => {
  it.each(['role-super', 'role-admin', 'role-manager', 'role-staff', 'role-ops'])('assigning %s to a customer is forbidden', async (roleId) => {
    const { service, writes } = build();
    await expect(service.updateUser('user-1', { roleIds: [roleId] })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.updateUser('user-1', { roleIds: ['role-customer', roleId] })).rejects.toBeInstanceOf(ForbiddenException);
    expect(writes.userUpdate).not.toHaveBeenCalled();
  });

  it('an unknown role id is rejected', async () => {
    const { service } = build();
    await expect(service.updateUser('user-1', { roleIds: ['nope'] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('the CUSTOMER role and plain status changes still work', async () => {
    const { service, writes } = build();
    await service.updateUser('user-1', { roleIds: ['role-customer'], isActive: false });
    await service.updateUser('user-1', { isActive: true });
    expect(writes.userUpdate).toHaveBeenCalledTimes(2);
  });
});
