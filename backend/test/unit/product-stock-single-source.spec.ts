import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PermissionGuard } from '../../src/common/guards/permission.guard';
import { AdminService } from '../../src/modules/admin/admin.service';
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto';
import { UpdateProductDto } from '../../src/modules/admin/application/dto/update-product.dto';
import { AdminCatalogController } from '../../src/modules/admin/presentation/admin-catalog.controller';
import { InventoryAdminController } from '../../src/modules/inventory/presentation/inventory-admin.controller';
import { loadStockLevels } from '../../src/modules/inventory/stock-levels';

/**
 * Single stock interface (2026-11-20): Stok Produk (ProductInventory) is the only
 * place stock is viewed or managed. The Product endpoints manage product
 * information only - they never write stock, whether `stock` is omitted or sent -
 * and a new product gets stock-0 Stok Produk rows at every ACTIVE outlet in the
 * same transaction as the product row. Product.stock stays in the schema for the
 * legacy reservation / cancellation paths and is left exactly as stored.
 *
 * Offline: an in-memory Prisma whose $transaction rolls every table back on a throw.
 */

type ProductRow = Record<string, unknown> & { id: string; stock: number; sequence: number; deletedAt: Date | null };
type InventoryRow = { id: string; productId: string; outletId: string; stock: number; reserved: number; available: number };

function world(opts: { outlets?: Array<{ id: string; isActive: boolean }>; failInventoryInit?: boolean } = {}) {
  const outlets = opts.outlets ?? [
    { id: 'o-active-1', isActive: true },
    { id: 'o-active-2', isActive: true },
    { id: 'o-inactive', isActive: false },
  ];
  const products: ProductRow[] = [
    { id: 'p-old', slug: 'old', name: 'Bakso Lama', price: 20000, stock: 37, sequence: 1, deletedAt: null, imageUrl: '/old.png', images: [] },
  ];
  const inventory: InventoryRow[] = [
    { id: 'pi-old-1', productId: 'p-old', outletId: 'o-active-1', stock: 21, reserved: 3, available: 18 },
  ];
  let seq = 0;

  const product = {
    aggregate: jest.fn(async () => ({ _max: { sequence: Math.max(0, ...products.map((p) => p.sequence)) } })),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const { images: _nested, ...fields } = data;
      // Column default (schema: stock Int @default(0)) when no stock is written.
      const row = { stock: 0, deletedAt: null, ...fields, id: `p-new-${++seq}` } as ProductRow;
      products.push(row);
      return { ...row };
    }),
    findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
      const row = products.find((p) => p.id === where.id);
      return row ? { ...row, images: [] } : null;
    }),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = products.find((p) => p.id === where.id)!;
      Object.assign(row, data);
      return { ...row };
    }),
  };
  const outlet = {
    findMany: jest.fn(async ({ where }: { where: { isActive?: boolean } }) =>
      outlets.filter((o) => where.isActive === undefined || o.isActive === where.isActive).map((o) => ({ id: o.id })),
    ),
  };
  const productInventory = {
    createMany: jest.fn(async ({ data, skipDuplicates }: { data: Array<Omit<InventoryRow, 'id'>>; skipDuplicates?: boolean }) => {
      if (opts.failInventoryInit) throw new Error('inventory init failed');
      let count = 0;
      for (const row of data) {
        const dup = inventory.some((i) => i.productId === row.productId && i.outletId === row.outletId);
        if (dup && skipDuplicates) continue;
        if (dup) throw new Error('unique violation');
        inventory.push({ id: `pi-${row.productId}-${row.outletId}`, ...row });
        count += 1;
      }
      return { count };
    }),
    update: jest.fn(),
    updateMany: jest.fn(),
    upsert: jest.fn(),
  };
  const productImage = { deleteMany: jest.fn(), createMany: jest.fn(), upsert: jest.fn() };
  const tx = { product, outlet, productInventory, productImage };
  const $transaction = jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
    const pSnap = products.map((p) => ({ ...p }));
    const iSnap = inventory.map((i) => ({ ...i }));
    try {
      return await fn(tx);
    } catch (err) {
      products.splice(0, products.length, ...pSnap);
      inventory.splice(0, inventory.length, ...iSnap);
      throw err;
    }
  });
  const prisma = { ...tx, $transaction };
  const admin = new AdminService(prisma as never, {} as never);
  return { admin, prisma, products, inventory };
}

const NEW_PRODUCT = {
  slug: 'bakso-baru',
  name: 'Bakso Baru',
  description: 'Enak',
  price: 25000,
  imageUrl: '/uploads/products/new.png',
  status: 'ACTIVE',
  categoryId: 'c1',
};
const snapshot = <T>(rows: T[]) => JSON.parse(JSON.stringify(rows)) as T[];

describe('Product DTOs accept but do not require stock', () => {
  it('CreateProductDto validates without stock (and still accepts a legacy stock value)', async () => {
    expect(await validate(plainToInstance(CreateProductDto, NEW_PRODUCT))).toEqual([]);
    expect(await validate(plainToInstance(CreateProductDto, { ...NEW_PRODUCT, stock: 5 }))).toEqual([]);
  });

  it('UpdateProductDto validates without stock (and still accepts a legacy stock value)', async () => {
    expect(await validate(plainToInstance(UpdateProductDto, { name: 'Baru' }))).toEqual([]);
    expect(await validate(plainToInstance(UpdateProductDto, { name: 'Baru', stock: 0 }))).toEqual([]);
  });
});

describe('AdminService.createProduct - no stock input, Stok Produk initialised', () => {
  it('creates the product without stock; Product.stock is the column default 0', async () => {
    const { admin, products } = world();
    const created = await admin.createProduct(NEW_PRODUCT as never);
    expect(created).toMatchObject({ name: 'Bakso Baru', price: 25000, stock: 0 });
    expect(products.find((p) => p.id === created.id)?.stock).toBe(0);
  });

  it('an explicit stock value is ignored (never written to Product.stock)', async () => {
    const { admin, prisma } = world();
    const created = await admin.createProduct({ ...NEW_PRODUCT, stock: 250 } as never);
    expect(prisma.product.create.mock.calls[0][0].data).not.toHaveProperty('stock');
    expect(created.stock).toBe(0);
  });

  it('initialises stock-0 / reserved-0 Stok Produk rows for every ACTIVE outlet, in the same transaction', async () => {
    const { admin, prisma, inventory } = world();
    const created = await admin.createProduct(NEW_PRODUCT as never);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(inventory.filter((i) => i.productId === created.id)).toEqual([
      { id: `pi-${created.id}-o-active-1`, productId: created.id, outletId: 'o-active-1', stock: 0, reserved: 0, available: 0 },
      { id: `pi-${created.id}-o-active-2`, productId: created.id, outletId: 'o-active-2', stock: 0, reserved: 0, available: 0 },
    ]);
    expect(prisma.productInventory.createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
  });

  it('does not touch existing products or their Stok Produk rows', async () => {
    const { admin, products, inventory } = world();
    const before = { product: snapshot(products), inventory: snapshot(inventory) };
    await admin.createProduct(NEW_PRODUCT as never);
    expect(products.find((p) => p.id === 'p-old')).toEqual(before.product[0]);
    expect(inventory.filter((i) => i.productId === 'p-old')).toEqual(before.inventory);
  });

  it('is atomic: a failed inventory initialisation rolls the product back', async () => {
    const { admin, products, inventory } = world({ failInventoryInit: true });
    const before = { product: snapshot(products), inventory: snapshot(inventory) };
    await expect(admin.createProduct(NEW_PRODUCT as never)).rejects.toThrow('inventory init failed');
    expect(products).toEqual(before.product);
    expect(inventory).toEqual(before.inventory);
  });

  it('with no active outlet the product is still created (no rows; Stok Produk adjust creates one on demand)', async () => {
    const { admin, prisma, inventory } = world({ outlets: [{ id: 'o-inactive', isActive: false }] });
    const created = await admin.createProduct(NEW_PRODUCT as never);
    expect(created.name).toBe('Bakso Baru');
    expect(prisma.productInventory.createMany).not.toHaveBeenCalled();
    expect(inventory.filter((i) => i.productId === created.id)).toEqual([]);
  });
});

describe('AdminService.updateProduct - never changes stock', () => {
  it('an edit without stock keeps Product.stock and every Stok Produk row', async () => {
    const { admin, products, inventory } = world();
    const inventoryBefore = snapshot(inventory);
    const updated = await admin.updateProduct('p-old', { name: 'Bakso Lama Baru', price: 22000, description: 'Baru' } as never);
    expect(updated).toMatchObject({ name: 'Bakso Lama Baru', price: 22000, description: 'Baru', stock: 37 });
    expect(products[0].stock).toBe(37);
    expect(inventory).toEqual(inventoryBefore);
  });

  it.each([0, 999])('a PATCH that sends stock=%s cannot change Product.stock', async (stock) => {
    const { admin, prisma, products, inventory } = world();
    const inventoryBefore = snapshot(inventory);
    await admin.updateProduct('p-old', { name: 'X', stock } as never);
    expect(prisma.product.update.mock.calls[0][0].data).not.toHaveProperty('stock');
    expect(products[0]).toMatchObject({ name: 'X', stock: 37 });
    expect(inventory).toEqual(inventoryBefore);
  });

  it('a PATCH with ONLY stock changes nothing stock-related', async () => {
    const { admin, products, inventory } = world();
    const inventoryBefore = snapshot(inventory);
    await admin.updateProduct('p-old', { stock: 1 } as never);
    expect(products[0].stock).toBe(37);
    expect(inventory).toEqual(inventoryBefore);
  });

  it('unrelated product fields still update (status, category, flags, physical attributes, cover image)', async () => {
    const { admin, products } = world();
    await admin.updateProduct('p-old', {
      status: 'ARCHIVED',
      categoryId: 'c2',
      isBestSeller: true,
      weightGram: 900,
      imageUrl: '/uploads/products/new-cover.png',
    } as never);
    expect(products[0]).toMatchObject({
      status: 'ARCHIVED',
      categoryId: 'c2',
      isBestSeller: true,
      weightGram: 900,
      imageUrl: '/uploads/products/new-cover.png',
      stock: 37,
    });
  });
});

describe('authorization: stock is changed only through ProductInventory.update', () => {
  const guard = new PermissionGuard(new Reflector());
  const ctx = (handler: (...args: never[]) => unknown, klass: new (...args: never[]) => unknown, permissions: string[]) =>
    ({
      getHandler: () => handler,
      getClass: () => klass,
      switchToHttp: () => ({ getRequest: () => ({ user: { sub: 'a1', role: 'CATALOG_EDITOR', permissions } }) }),
    }) as never;

  it('Stok Produk adjustment requires ProductInventory.update - Product.update alone is forbidden', () => {
    const adjust = InventoryAdminController.prototype.adjust;
    expect(() => guard.canActivate(ctx(adjust, InventoryAdminController, ['Product.read', 'Product.update']))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctx(adjust, InventoryAdminController, ['ProductInventory.read']))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx(adjust, InventoryAdminController, ['ProductInventory.update']))).toBe(true);
  });

  it('stock transfers require StockTransfer permissions, not Product.update', () => {
    const complete = InventoryAdminController.prototype.complete;
    expect(() => guard.canActivate(ctx(complete, InventoryAdminController, ['Product.update']))).toThrow(ForbiddenException);
    expect(guard.canActivate(ctx(complete, InventoryAdminController, ['StockTransfer.update']))).toBe(true);
  });

  it('a Product.update holder can edit the product, and that edit cannot reach stock', async () => {
    const update = AdminCatalogController.prototype.updateProduct;
    expect(guard.canActivate(ctx(update, AdminCatalogController, ['Product.update']))).toBe(true);
    const { admin, products, inventory } = world();
    const inventoryBefore = snapshot(inventory);
    await new AdminCatalogController(admin).updateProduct('p-old', { stock: 500 } as never);
    expect(products[0].stock).toBe(37);
    expect(inventory).toEqual(inventoryBefore);
  });
});

describe('loadStockLevels - dashboard semantics match Stok Produk availability', () => {
  it('uses best active-outlet stock - reserved; no row = 0; legacy Product.stock ignored', async () => {
    const db = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', name: 'A', stock: 500 },
          { id: 'b', name: 'B', stock: 500 },
          { id: 'c', name: 'C', stock: 0 },
          { id: 'd', name: 'D', stock: 0 },
        ]),
      },
      productInventory: {
        findMany: jest.fn().mockResolvedValue([
          { productId: 'a', stock: 4, reserved: 4 }, // 0 at this outlet
          { productId: 'a', stock: 9, reserved: 1 }, // 8 - best outlet wins (not summed)
          { productId: 'b', stock: 2, reserved: 5 }, // holds exceed stock -> 0, never negative
          { productId: 'c', stock: 40, reserved: 0 }, // 40, not low
        ]),
      },
    };
    const levels = await loadStockLevels(db as never, { deletedAt: null });
    expect(levels).toEqual({
      lowStock: 1,
      outOfStock: 2,
      atOrBelowThreshold: [
        { id: 'b', name: 'B', available: 0 },
        { id: 'd', name: 'D', available: 0 },
        { id: 'a', name: 'A', available: 8 },
      ],
    });
    expect(db.productInventory.findMany).toHaveBeenCalledWith({
      where: { productId: { in: ['a', 'b', 'c', 'd'] }, outlet: { isActive: true } },
      select: { productId: true, stock: true, reserved: true },
    });
  });
});
