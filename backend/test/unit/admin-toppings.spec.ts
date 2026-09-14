import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdminService } from '../../src/modules/admin/admin.service';
import { AdminCatalogController } from '../../src/modules/admin/presentation/admin-catalog.controller';
import { CreateToppingDto } from '../../src/modules/admin/application/dto/create-topping.dto';
import { UpdateToppingDto } from '../../src/modules/admin/application/dto/update-topping.dto';
import { PERMISSIONS_KEY } from '../../src/common/decorators/permissions.decorator';
import { PermissionGuard } from '../../src/common/guards/permission.guard';
import { AdminGuard } from '../../src/common/guards/admin.guard';
import { ENTITY_DELEGATES, mapAuditRoute } from '../../src/infrastructure/audit/audit-route.map';
import { ALL_PERMISSION_NAMES, ROLE_PERMISSION_MATRIX } from '../../prisma/bootstrap/permission-catalogue';

/**
 * Admin Topping management. There was no admin CRUD for toppings at all (only the
 * public GET /catalog/toppings the storefront reads); these pin the endpoints added
 * to AdminCatalogController, the Product.* permissions they reuse, the soft-delete
 * domain rule and the automatic audit trail.
 */

const TOPPING = { id: 't-1', name: 'Bihun', price: 5_000, isActive: true, deletedAt: null, createdAt: new Date(), updatedAt: new Date() };

function prismaMock(existing: Record<string, unknown> | null = TOPPING) {
  return {
    topping: {
      create: jest.fn(async ({ data }) => ({ id: 't-new', ...data })),
      findMany: jest.fn(async () => [TOPPING]),
      findUnique: jest.fn(async () => existing),
      update: jest.fn(async ({ where, data }) => ({ ...TOPPING, id: where.id, ...data })),
      delete: jest.fn(),
    },
    orderItemTopping: { deleteMany: jest.fn(), updateMany: jest.fn() },
  };
}

const serviceWith = (prisma: ReturnType<typeof prismaMock>) => new AdminService(prisma as never, {} as never);

describe('Admin topping endpoints: guards and permissions', () => {
  const perms = (method: keyof AdminCatalogController) =>
    Reflect.getMetadata(PERMISSIONS_KEY, AdminCatalogController.prototype[method]);

  it('the whole controller sits behind AdminGuard + PermissionGuard', () => {
    expect(Reflect.getMetadata('__guards__', AdminCatalogController)).toEqual([AdminGuard, PermissionGuard]);
  });

  it('reuses the Product.* permissions - no new RBAC subject, every name is in the catalogue', () => {
    expect(perms('listToppings')).toEqual(['Product.read']);
    expect(perms('getTopping')).toEqual(['Product.read']);
    expect(perms('createTopping')).toEqual(['Product.create']);
    expect(perms('updateTopping')).toEqual(['Product.update']);
    expect(perms('deleteTopping')).toEqual(['Product.delete']);
    for (const m of ['listToppings', 'getTopping', 'createTopping', 'updateTopping', 'deleteTopping'] as const) {
      for (const p of perms(m)) expect(ALL_PERMISSION_NAMES).toContain(p);
    }
    expect(ALL_PERMISSION_NAMES.some((p) => p.startsWith('Topping.'))).toBe(false);
  });

  it('ADMIN may manage toppings; MANAGER and STAFF may only list them', () => {
    for (const p of ['Product.read', 'Product.create', 'Product.update', 'Product.delete']) {
      expect(ROLE_PERMISSION_MATRIX.ADMIN).toContain(p);
    }
    for (const role of ['MANAGER', 'STAFF'] as const) {
      expect(ROLE_PERMISSION_MATRIX[role]).toContain('Product.read');
      for (const p of ['Product.create', 'Product.update', 'Product.delete']) expect(ROLE_PERMISSION_MATRIX[role]).not.toContain(p);
    }
    expect(ROLE_PERMISSION_MATRIX.CUSTOMER).toEqual([]);
  });

  describe('PermissionGuard on the real handlers', () => {
    const guard = new PermissionGuard(new Reflector());
    const ctx = (method: keyof AdminCatalogController, user: unknown) =>
      ({
        getHandler: () => AdminCatalogController.prototype[method],
        getClass: () => AdminCatalogController,
        switchToHttp: () => ({ getRequest: () => ({ user }) }),
      }) as unknown as ExecutionContext;
    const as = (role: keyof typeof ROLE_PERMISSION_MATRIX) => ({ role, permissions: [...ROLE_PERMISSION_MATRIX[role]] });

    it.each(['createTopping', 'updateTopping', 'deleteTopping'] as const)('%s: ADMIN and SUPER_ADMIN pass, MANAGER/STAFF/CUSTOMER are refused', (m) => {
      expect(guard.canActivate(ctx(m, as('ADMIN')))).toBe(true);
      expect(guard.canActivate(ctx(m, { role: 'SUPER_ADMIN', permissions: [] }))).toBe(true);
      for (const role of ['MANAGER', 'STAFF', 'CUSTOMER'] as const) {
        expect(() => guard.canActivate(ctx(m, as(role)))).toThrow(ForbiddenException);
      }
      expect(() => guard.canActivate(ctx(m, undefined))).toThrow(ForbiddenException);
    });

    it('listing is open to every admin role that reads products', () => {
      for (const role of ['ADMIN', 'MANAGER', 'STAFF'] as const) expect(guard.canActivate(ctx('listToppings', as(role)))).toBe(true);
      expect(() => guard.canActivate(ctx('listToppings', as('CUSTOMER')))).toThrow(ForbiddenException);
    });
  });
});

describe('Admin topping DTO validation (the global ValidationPipe settings)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } });
  const create = (body: unknown) => pipe.transform(body, { type: 'body', metatype: CreateToppingDto });
  const update = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateToppingDto });

  it('accepts name + price (+ optional isActive) and trims the name', async () => {
    await expect(create({ name: '  Telur Puyuh ', price: 5000 })).resolves.toMatchObject({ name: 'Telur Puyuh', price: 5000 });
    await expect(create({ name: 'Kuah Extra', price: 0, isActive: false })).resolves.toMatchObject({ price: 0, isActive: false });
  });

  it.each([
    ['blank name', { name: '   ', price: 1000 }],
    ['missing price', { name: 'Bihun' }],
    ['negative price', { name: 'Bihun', price: -1 }],
    ['fractional price', { name: 'Bihun', price: 1500.5 }],
    ['over-long name', { name: 'x'.repeat(101), price: 1000 }],
    ['unknown field', { name: 'Bihun', price: 1000, deletedAt: null }],
  ])('create rejects %s', async (_label, body) => {
    await expect(create(body)).rejects.toBeDefined();
  });

  it('update is sparse: any subset of name/price/isActive, same rules per field', async () => {
    await expect(update({ isActive: false })).resolves.toMatchObject({ isActive: false });
    await expect(update({ price: 6000 })).resolves.toMatchObject({ price: 6000 });
    await expect(update({ price: -5 })).rejects.toBeDefined();
    await expect(update({ name: '' })).rejects.toBeDefined();
    await expect(update({ id: 'other' })).rejects.toBeDefined();
  });
});

describe('AdminService topping methods', () => {
  it('create writes exactly the validated fields', async () => {
    const prisma = prismaMock();
    await serviceWith(prisma).createTopping({ name: 'Siomay', price: 4000, isActive: false });
    expect(prisma.topping.create).toHaveBeenCalledWith({ data: { name: 'Siomay', price: 4000, isActive: false } });
  });

  it('list shows active AND inactive toppings, never soft-deleted ones, by name', async () => {
    const prisma = prismaMock();
    await serviceWith(prisma).listToppings();
    expect(prisma.topping.findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, orderBy: { name: 'asc' } });
  });

  it('get / update / delete answer 404 for a missing or soft-deleted topping and write nothing', async () => {
    for (const existing of [null, { ...TOPPING, deletedAt: new Date() }]) {
      const prisma = prismaMock(existing);
      const service = serviceWith(prisma);
      await expect(service.getTopping('t-1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.updateTopping('t-1', { price: 1 })).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.deleteTopping('t-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.topping.update).not.toHaveBeenCalled();
    }
  });

  it('update (incl. activate/deactivate) writes only the fields sent', async () => {
    const prisma = prismaMock();
    await serviceWith(prisma).updateTopping('t-1', { isActive: false });
    expect(prisma.topping.update).toHaveBeenCalledWith({ where: { id: 't-1' }, data: { isActive: false } });
  });

  it('delete is a SOFT delete: ordered toppings stay referenced, snapshots untouched', async () => {
    const prisma = prismaMock();
    const result = await serviceWith(prisma).deleteTopping('t-1');
    expect(prisma.topping.update).toHaveBeenCalledWith({ where: { id: 't-1' }, data: { deletedAt: expect.any(Date) } });
    expect(result.deletedAt).toBeInstanceOf(Date);
    expect(prisma.topping.delete).not.toHaveBeenCalled();
    expect(prisma.orderItemTopping.deleteMany).not.toHaveBeenCalled();
    expect(prisma.orderItemTopping.updateMany).not.toHaveBeenCalled();
  });
});

describe('Topping mutations reach the existing audit trail', () => {
  it('maps create / update / delete to the Topping entity with a BEFORE-snapshot delegate', () => {
    expect(mapAuditRoute('POST', '/api/v1/admin/catalog/toppings')).toEqual({ module: 'toppings', entity: 'Topping', action: 'CREATE' });
    expect(mapAuditRoute('PATCH', '/api/v1/admin/catalog/toppings/t-1')).toEqual({ module: 'toppings', entity: 'Topping', action: 'UPDATE' });
    expect(mapAuditRoute('DELETE', '/api/v1/admin/catalog/toppings/t-1')).toEqual({ module: 'toppings', entity: 'Topping', action: 'DELETE' });
    expect(mapAuditRoute('GET', '/api/v1/admin/catalog/toppings')).toBeNull();
    expect(ENTITY_DELEGATES.Topping).toBe('topping');
  });
});

describe('storefront contract is unchanged', () => {
  const read = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

  it('the public list still shows only active, non-deleted toppings', () => {
    expect(read('src/modules/catalog/infrastructure/prisma-catalog.repository.ts')).toMatch(
      /topping\.findMany\(\{ where: \{ deletedAt: null, isActive: true \}, orderBy: \{ name: 'asc' \} \}\)/,
    );
  });

  it('checkout still refuses inactive or deleted toppings and prices them from the table', () => {
    const orders = read('src/modules/orders/orders.service.ts');
    expect(orders).toMatch(/topping\.findMany\(\{ where: \{ id: \{ in: toppingIds \}, deletedAt: null, isActive: true \} \}\)/);
    expect(orders).toMatch(/if \(toppings\.length !== toppingIds\.length\) throw new BadRequestException\('Some toppings are unavailable'\)/);
  });
});
