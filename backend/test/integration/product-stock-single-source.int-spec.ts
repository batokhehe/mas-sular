/**
 * Single stock interface against a real PostgreSQL.
 *
 * What unit tests (Prisma mocked) cannot show: that product creation and its
 * Stok Produk (ProductInventory) initialisation really commit or roll back
 * together, that the (productId, outletId) unique key is respected, that product
 * edits leave Product.stock and every ProductInventory row byte-for-byte unchanged,
 * and that a Stok Produk adjustment works on a freshly initialised row.
 *
 * Only a throwaway PostgreSQL container (Testcontainers) with every migration applied -
 * no RabbitMQ, no application services, never a shared or production database.
 */
import { execFileSync } from 'child_process';
import { join } from 'path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { AdminService } from '../../src/modules/admin/admin.service';
import { StockTransferService } from '../../src/modules/inventory/stock-transfer.service';
import { loadAvailableStock } from '../../src/modules/inventory/stock-availability';
import { loadStockLevels } from '../../src/modules/inventory/stock-levels';

const BACKEND = join(__dirname, '..', '..');

let pg: StartedPostgreSqlContainer;
let prisma: PrismaClient;
let url: string;
let admin: AdminService;
let inventory: StockTransferService;
let categoryId: string;

const prismaCli = (args: string[]) =>
  execFileSync(join(BACKEND, 'node_modules', '.bin', 'prisma'), args, { cwd: BACKEND, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8' });

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('app').withUsername('app').withPassword('app').start();
  url = pg.getConnectionUri();
  prismaCli(['migrate', 'deploy']);
  prisma = new PrismaClient({ datasources: { db: { url } } });
  admin = new AdminService(prisma as never, {} as never);
  inventory = new StockTransferService(prisma as never);

  categoryId = (await prisma.category.create({ data: { name: 'Bakso', slug: 'bakso' } })).id;
  await prisma.outlet.createMany({
    data: [
      { id: 'o-a', name: 'Outlet A', isActive: true },
      { id: 'o-b', name: 'Outlet B', isActive: true },
      { id: 'o-off', name: 'Outlet Tutup', isActive: false },
    ],
  });
  // A pre-existing product with a legacy Product.stock and a Stok Produk row (holds included).
  await prisma.product.create({
    data: { id: 'p-old', slug: 'bakso-lama', sku: 'BAKSO-LAMA', name: 'Bakso Lama', description: 'x', price: 20000, imageUrl: '/old.png', stock: 37, categoryId },
  });
  await prisma.productInventory.create({ data: { productId: 'p-old', outletId: 'o-a', stock: 21, reserved: 3, available: 18 } });
});

afterAll(async () => {
  await prisma?.$disconnect();
  await pg?.stop();
});

const newProduct = (slug: string, extra: Record<string, unknown> = {}) =>
  ({ slug, name: `Produk ${slug}`, description: 'integration', price: 25000, imageUrl: `/uploads/products/${slug}.png`, status: 'ACTIVE', categoryId, ...extra }) as never;
const rowsOf = (productId: string) =>
  prisma.productInventory.findMany({ where: { productId }, orderBy: { outletId: 'asc' }, select: { outletId: true, stock: true, reserved: true, available: true } });
const allInventory = () => prisma.productInventory.findMany({ orderBy: [{ productId: 'asc' }, { outletId: 'asc' }] });

it('A. create without stock: Product.stock = 0 and stock-0 Stok Produk rows at every ACTIVE outlet', async () => {
  const created = await admin.createProduct(newProduct('baru-a'));
  expect((await prisma.product.findUniqueOrThrow({ where: { id: created.id } })).stock).toBe(0);
  expect(await rowsOf(created.id)).toEqual([
    { outletId: 'o-a', stock: 0, reserved: 0, available: 0 },
    { outletId: 'o-b', stock: 0, reserved: 0, available: 0 },
  ]);
  // Listed in Stok Produk straight away; unavailable to customers until stocked there.
  const listed = await inventory.listInventory({ productId: created.id } as never);
  expect(listed.items.map((r) => r.outletId).sort()).toEqual(['o-a', 'o-b']);
  expect((await loadAvailableStock(prisma as never, [created.id])).get(created.id)).toBe(0);
});

it('B. a stock value sent on create is ignored', async () => {
  const created = await admin.createProduct(newProduct('baru-b', { stock: 250 }));
  expect((await prisma.product.findUniqueOrThrow({ where: { id: created.id } })).stock).toBe(0);
  expect((await rowsOf(created.id)).every((r) => r.stock === 0)).toBe(true);
});

it('C. atomic: when the Stok Produk insert fails, the product is not created either', async () => {
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION test_fail_inventory() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'inventory init refused (test)'; END $$ LANGUAGE plpgsql`);
  await prisma.$executeRawUnsafe(`
    CREATE TRIGGER test_fail_inventory BEFORE INSERT ON "ProductInventory"
    FOR EACH ROW WHEN (NEW."outletId" = 'o-b') EXECUTE FUNCTION test_fail_inventory()`);
  const productsBefore = await prisma.product.count();
  const inventoryBefore = await allInventory();
  try {
    await expect(admin.createProduct(newProduct('baru-c'))).rejects.toThrow(/inventory init refused/);
  } finally {
    await prisma.$executeRawUnsafe('DROP TRIGGER test_fail_inventory ON "ProductInventory"');
    await prisma.$executeRawUnsafe('DROP FUNCTION test_fail_inventory()');
  }
  expect(await prisma.product.count()).toBe(productsBefore);
  expect(await prisma.product.findUnique({ where: { slug: 'baru-c' } })).toBeNull();
  expect(await allInventory()).toEqual(inventoryBefore);
});

it('D. existing products are never initialised or reset by a create', async () => {
  expect(await rowsOf('p-old')).toEqual([{ outletId: 'o-a', stock: 21, reserved: 3, available: 18 }]);
  expect((await prisma.product.findUniqueOrThrow({ where: { id: 'p-old' } })).stock).toBe(37);
});

it('E. edits (with stock omitted, or sent as 0 / 999) keep Product.stock and every Stok Produk row', async () => {
  const inventoryBefore = await allInventory();
  await admin.updateProduct('p-old', { name: 'Bakso Lama Baru', price: 22000, description: 'baru', isBestSeller: true, weightGram: 900 } as never);
  await admin.updateProduct('p-old', { stock: 0 } as never);
  await admin.updateProduct('p-old', { status: 'ARCHIVED', stock: 999 } as never);
  await admin.updateProduct('p-old', { status: 'ACTIVE' } as never);
  const p = await prisma.product.findUniqueOrThrow({ where: { id: 'p-old' } });
  expect(p).toMatchObject({ name: 'Bakso Lama Baru', price: 22000, description: 'baru', isBestSeller: true, weightGram: 900, status: 'ACTIVE', stock: 37 });
  expect(await allInventory()).toEqual(inventoryBefore);
});

it('F. Stok Produk adjustment works on a new product, refuses going below reserved, and is audited', async () => {
  const created = await admin.createProduct(newProduct('baru-f'));
  const adjusted = await inventory.adjustStock({ productId: created.id, outletId: 'o-a', stock: 12, note: 'stok awal' } as never, 'admin-1');
  expect(adjusted).toMatchObject({ stock: 12, reserved: 0, available: 12 });
  expect((await loadAvailableStock(prisma as never, [created.id])).get(created.id)).toBe(12);
  // Product.stock is not the stock interface and is not touched by an adjustment.
  expect((await prisma.product.findUniqueOrThrow({ where: { id: created.id } })).stock).toBe(0);
  const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'inventory.adjust', entityId: adjusted.id } });
  expect(audit.after).toMatchObject({ productId: created.id, outletId: 'o-a', newStock: 12, previousStock: 0, note: 'stok awal', byAdminId: 'admin-1' });

  await expect(inventory.adjustStock({ productId: 'p-old', outletId: 'o-a', stock: 2 } as never, 'admin-1')).rejects.toThrow(/below the reserved quantity/);
  expect(await rowsOf('p-old')).toEqual([{ outletId: 'o-a', stock: 21, reserved: 3, available: 18 }]);
});

it('G. dashboard stock levels equal Stok Produk availability, not Product.stock', async () => {
  const ids = (await prisma.product.findMany({ where: { deletedAt: null, status: 'ACTIVE' }, select: { id: true } })).map((p) => p.id);
  const available = await loadAvailableStock(prisma as never, ids);
  const levels = await loadStockLevels(prisma as never, { deletedAt: null, status: 'ACTIVE' });
  for (const row of levels.atOrBelowThreshold) expect(row.available).toBe(available.get(row.id));
  // p-old: Product.stock 37 (not low) but Stok Produk available 18 -> also not low;
  // the fresh products (available 0) are out of stock; baru-f (12) is above 10.
  expect(levels.atOrBelowThreshold.map((r) => r.id).sort()).toEqual(
    (await prisma.product.findMany({ where: { slug: { in: ['baru-a', 'baru-b'] } }, select: { id: true } })).map((p) => p.id).sort(),
  );
  expect(levels.outOfStock).toBe(2);
  expect(levels.lowStock).toBe(0);
});
