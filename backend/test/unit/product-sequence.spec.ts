import 'reflect-metadata';
import { readFileSync } from 'fs';
import { join } from 'path';
import { BadRequestException, ConflictException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ProductStatus } from '@prisma/client';
import { AdminService } from '../../src/modules/admin/admin.service';
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto';
import { ReorderProductsDto } from '../../src/modules/admin/application/dto/reorder-products.dto';
import { UpdateProductDto } from '../../src/modules/admin/application/dto/update-product.dto';
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository';
import {
  FIRST_PRODUCT_SEQUENCE,
  PRODUCT_AUDIT_ENTITY,
  PRODUCT_REORDER_AUDIT_ACTION,
  PRODUCT_SEQUENCE_ORDER_BY,
  validateProductReorder,
} from '../../src/modules/catalog/product-sequence';

/**
 * Canonical product ordering (Product.sequence). The sequence is the DEFAULT order of
 * every product list; explicit business sorts (price, rating, popularity, and the
 * Admin's own name/stock/newest sorts) are untouched. It is written only by the reorder
 * endpoint, which takes the complete live set and a permutation of 1..N, inside one
 * transaction. The same rules run against real PostgreSQL in
 * test/integration/product-sequence.int-spec.ts.
 */

const ROOT = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------- the order itself

describe('the canonical order', () => {
  it('is sequence ASC with a total-order tiebreak (equal sequences still sort deterministically)', () => {
    expect(PRODUCT_SEQUENCE_ORDER_BY).toEqual([{ sequence: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }]);
  });

  it('starts at 1', () => {
    expect(FIRST_PRODUCT_SEQUENCE).toBe(1);
  });

  it('is a real column with an index and a default, and nothing else writes it', () => {
    const schema = read('prisma/schema.prisma');
    const product = schema.match(/model Product \{[\s\S]*?\n\}/)![0];
    expect(product).toMatch(/^\s+sequence\s+Int\s+@default\(0\)$/m);
    expect(product).toMatch(/@@index\(\[sequence\]\)/);
  });

  it('the migration backfills the PREVIOUS storefront default order, so deploying does not reorder the storefront', () => {
    const sql = read('prisma/migrations/20261001090000_add_product_sequence/migration.sql');
    expect(sql).toMatch(/ALTER TABLE "Product" ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0;/);
    expect(sql).toMatch(/ROW_NUMBER\(\) OVER \(ORDER BY "reviewCount" DESC, "createdAt" DESC, "id" ASC\)/);
    expect(sql).toMatch(/CREATE INDEX "Product_sequence_idx" ON "Product"\("sequence"\);/);
    // Additive only: no column dropped or retyped, no table dropped.
    expect(sql).not.toMatch(/DROP |ALTER COLUMN /);
  });
});

// ---------------------------------------------------------------- storefront listing

describe('PrismaCatalogRepository.listProducts ordering', () => {
  const build = () => {
    const findMany = jest.fn().mockResolvedValue([]);
    return { findMany, repo: new PrismaCatalogRepository({ product: { findMany } } as never) };
  };

  const orderByFor = async (query: Record<string, unknown>) => {
    const { findMany, repo } = build();
    await repo.listProducts(query as never);
    return findMany.mock.calls[0][0].orderBy;
  };

  it('no sort (the storefront "Standar", the homepage sections, related products) → the sequence', async () => {
    expect(await orderByFor({})).toEqual(PRODUCT_SEQUENCE_ORDER_BY);
  });

  it.each([
    ['price-low', { price: 'asc' }],
    ['price-high', { price: 'desc' }],
    ['rating', { rating: 'desc' }],
    ['popular', { reviewCount: 'desc' }],
  ])('sort=%s keeps its explicit business ordering', async (sort, expected) => {
    expect(await orderByFor({ sort })).toEqual(expected);
  });

  it('the sequence applies to the flag sections and the category/search listings too', async () => {
    for (const query of [{ promoSpecial: true }, { trialPack: true }, { category: 'baso-urat' }, { search: 'baso' }]) {
      expect([query, await orderByFor(query)]).toEqual([query, PRODUCT_SEQUENCE_ORDER_BY]);
    }
  });

  it('the visibility rules are unchanged (ACTIVE, not deleted, sku omitted)', async () => {
    const { findMany, repo } = build();
    await repo.listProducts({} as never);
    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ status: ProductStatus.ACTIVE, deletedAt: null });
    expect(args.omit).toEqual({ sku: true });
  });
});

// ---------------------------------------------------------------- validation

describe('validateProductReorder', () => {
  const live = ['a', 'b', 'c'];
  const payload = (ids: string[]) => ids.map((id, index) => ({ id, sequence: index + 1 }));

  it('accepts the complete live set and returns it in sequence order', () => {
    expect(validateProductReorder(payload(['c', 'a', 'b']), live)).toEqual([
      { id: 'c', sequence: 1 },
      { id: 'a', sequence: 2 },
      { id: 'b', sequence: 3 },
    ]);
  });

  it('a partial / stale snapshot is a 409, never a partial write', () => {
    expect(() => validateProductReorder(payload(['a', 'b']), live)).toThrow(ConflictException);
  });

  it.each([
    ['an unknown product', [{ id: 'zz', sequence: 1 }, { id: 'a', sequence: 2 }, { id: 'b', sequence: 3 }]],
    ['a duplicate product', [{ id: 'a', sequence: 1 }, { id: 'a', sequence: 2 }, { id: 'b', sequence: 3 }]],
    ['a sequence outside 1..N', [{ id: 'a', sequence: 1 }, { id: 'b', sequence: 2 }, { id: 'c', sequence: 9 }]],
    ['a repeated sequence', [{ id: 'a', sequence: 1 }, { id: 'b', sequence: 1 }, { id: 'c', sequence: 2 }]],
  ])('%s is a 400', (_label, items) => {
    expect(() => validateProductReorder(items, live)).toThrow(BadRequestException);
  });

  it('a soft-deleted product is not part of the live set, so sending it is refused', () => {
    expect(() => validateProductReorder(payload(['a', 'b', 'deleted']), live)).toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------- admin service

type Row = { id: string; sequence: number; deletedAt: Date | null };

function adminWorld(rows: Row[]) {
  const updates: Array<{ id: string; sequence: number }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const product = {
    findMany: jest.fn(async ({ where }: { where?: { deletedAt?: null } }) =>
      rows.filter((row) => (where?.deletedAt === null ? row.deletedAt === null : true)).map((row) => ({ ...row })),
    ),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: { sequence: number } }) => {
      const row = rows.find((candidate) => candidate.id === where.id)!;
      row.sequence = data.sequence;
      updates.push({ id: where.id, sequence: data.sequence });
      return { ...row };
    }),
    aggregate: jest.fn(async () => ({ _max: { sequence: rows.reduce((max, row) => Math.max(max, row.sequence), 0) } })),
    create: jest.fn(async ({ data }: { data: { sequence: number } }) => {
      const created = { id: `new-${rows.length + 1}`, sequence: data.sequence, deletedAt: null };
      rows.push(created);
      return created;
    }),
  };
  const auditLog = { create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => audits.push(data)) };
  const tx = { product, auditLog };
  // The real transaction is atomic: a throw inside must leave no update applied.
  const $transaction = jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) => {
    const snapshot = rows.map((row) => ({ ...row }));
    const applied = updates.length;
    try {
      return await fn(tx);
    } catch (err) {
      rows.splice(0, rows.length, ...snapshot);
      updates.splice(applied, updates.length - applied);
      throw err;
    }
  });
  const prisma = { ...tx, $transaction };
  const service = new AdminService(prisma as never, {} as never);
  return { service, prisma, product, updates, audits, rows };
}

const liveRows = (): Row[] => [
  { id: 'a', sequence: 1, deletedAt: null },
  { id: 'b', sequence: 2, deletedAt: null },
  { id: 'c', sequence: 3, deletedAt: null },
];

describe('AdminService.listProducts', () => {
  it('asks the database for the canonical order (so the Admin sees the stored order)', async () => {
    const { service, product } = adminWorld(liveRows());
    await service.listProducts();
    expect(product.findMany).toHaveBeenCalledWith({ where: { deletedAt: null }, orderBy: PRODUCT_SEQUENCE_ORDER_BY });
  });
});

describe('AdminService.reorderProducts', () => {
  it('moves only the rows that actually changed, in one transaction', async () => {
    const { service, prisma, updates } = adminWorld(liveRows());
    await service.reorderProducts([
      { id: 'c', sequence: 1 },
      { id: 'a', sequence: 2 },
      { id: 'b', sequence: 3 },
    ]);
    expect(updates).toEqual([
      { id: 'c', sequence: 1 },
      { id: 'a', sequence: 2 },
      { id: 'b', sequence: 3 },
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('an unchanged order writes nothing', async () => {
    const { service, updates } = adminWorld(liveRows());
    await service.reorderProducts([
      { id: 'a', sequence: 1 },
      { id: 'b', sequence: 2 },
      { id: 'c', sequence: 3 },
    ]);
    expect(updates).toEqual([]);
  });

  it('a stale snapshot is refused with 409 and leaves every sequence untouched', async () => {
    const { service, rows, updates, audits } = adminWorld(liveRows());
    await expect(
      service.reorderProducts([
        { id: 'b', sequence: 1 },
        { id: 'a', sequence: 2 },
      ]),
    ).rejects.toThrow(ConflictException);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(updates).toEqual([]);
    expect(audits).toEqual([]); // nothing happened, nothing audited
  });

  it('an invalid payload rolls the whole transaction back (no half-applied order)', async () => {
    const { service, rows } = adminWorld(liveRows());
    await expect(
      service.reorderProducts([
        { id: 'c', sequence: 1 },
        { id: 'a', sequence: 2 },
        { id: 'a', sequence: 3 },
      ]),
    ).rejects.toThrow(BadRequestException);
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3]);
  });

  it('soft-deleted products are neither reordered nor expected in the payload', async () => {
    const rows = [...liveRows(), { id: 'gone', sequence: 4, deletedAt: new Date() }];
    const { service } = adminWorld(rows);
    await service.reorderProducts([
      { id: 'c', sequence: 1 },
      { id: 'b', sequence: 2 },
      { id: 'a', sequence: 3 },
    ]);
    expect(rows.find((row) => row.id === 'gone')!.sequence).toBe(4); // gap kept, never renumbered
  });

  it('writes one audit entry: product.reorder on Product, with before/after sequences and the admin id', async () => {
    const { service, audits } = adminWorld(liveRows());
    await service.reorderProducts([
      { id: 'b', sequence: 1 },
      { id: 'a', sequence: 2 },
      { id: 'c', sequence: 3 },
    ], 'admin-7');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: null,
      action: PRODUCT_REORDER_AUDIT_ACTION,
      entity: PRODUCT_AUDIT_ENTITY,
      entityId: null,
      before: { a: 1, b: 2, c: 3 },
      after: { byAdminId: 'admin-7', movedCount: 2, sequence: { b: 1, a: 2, c: 3 } },
    });
    expect(PRODUCT_REORDER_AUDIT_ACTION).toBe('product.reorder');
  });
});

describe('AdminService.createProduct places a new product last', () => {
  const dto = (slug: string): CreateProductDto =>
    ({ slug, name: slug, description: 'd', price: 1000, imageUrl: '/uploads/x.png', status: 'ACTIVE', stock: 1, categoryId: 'cat', sku: 'SKU-1' }) as CreateProductDto;

  it('sequence = MAX + 1, read inside the same transaction as the insert', async () => {
    const { service, prisma, product } = adminWorld(liveRows());
    const created = (await service.createProduct(dto('new-one'))) as { sequence: number };
    expect(created.sequence).toBe(4);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(product.aggregate).toHaveBeenCalledWith({ _max: { sequence: true } });
  });

  it('counts soft-deleted products in the MAX, so a new product never reuses their position', async () => {
    const rows = [...liveRows(), { id: 'gone', sequence: 9, deletedAt: new Date() }];
    const { service } = adminWorld(rows);
    expect(((await service.createProduct(dto('after-gap'))) as { sequence: number }).sequence).toBe(10);
  });

  it('the first product of an empty catalogue gets sequence 1', async () => {
    const { service } = adminWorld([]);
    expect(((await service.createProduct(dto('first'))) as { sequence: number }).sequence).toBe(FIRST_PRODUCT_SEQUENCE);
  });
});

// ---------------------------------------------------------------- API contract

describe('the reorder DTO', () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(ReorderProductsDto, body))).map((e) => e.property);

  const id = '3f1a2b4c-5d6e-4f7a-8b9c-0d1e2f3a4b5c';

  it('accepts a list of { id, sequence }', async () => {
    expect(await errorsFor({ items: [{ id, sequence: 1 }] })).toEqual([]);
  });

  it.each([
    ['no items', {}],
    ['an empty list', { items: [] }],
    ['a non-list', { items: 'all' }],
  ])('rejects %s', async (_label, body) => {
    expect(await errorsFor(body)).toEqual(['items']);
  });

  it.each([
    ['a non-uuid id', { id: 'not-an-id', sequence: 1 }],
    ['sequence 0 (1-based)', { id, sequence: 0 }],
    ['a negative sequence', { id, sequence: -1 }],
    ['a fractional sequence', { id, sequence: 1.5 }],
  ])('rejects %s', async (_label, item) => {
    expect(await errorsFor({ items: [item] })).toEqual(['items']);
  });
});

describe('sequence is NOT part of product CRUD', () => {
  const base = { slug: 's', name: 'n', description: 'd', price: 1, imageUrl: '/x.png', status: 'ACTIVE', stock: 1, categoryId: 'c' };
  // The application's pipe, as configured in main.ts.
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } });

  it('the application really does refuse unknown fields', () => {
    expect(read('src/main.ts')).toMatch(/whitelist: true,\s*\n\s*forbidNonWhitelisted: true,/);
  });

  it.each([
    ['create', CreateProductDto],
    ['update', UpdateProductDto],
  ])('the %s DTO does not declare it, so the API rejects an attempt to set it', async (_label, metatype) => {
    await expect(pipe.transform({ ...base, sequence: 99 }, { type: 'body', metatype })).rejects.toThrow(BadRequestException);
    // ... while the same body without it is accepted and carries no sequence.
    const accepted = (await pipe.transform({ ...base }, { type: 'body', metatype })) as Record<string, unknown>;
    expect(accepted.sequence).toBeUndefined();
  });

  it('neither DTO file mentions it at all', () => {
    const source = read('src/modules/admin/application/dto/create-product.dto.ts') + read('src/modules/admin/application/dto/update-product.dto.ts');
    expect(source).not.toMatch(/sequence/);
  });
});

describe('the endpoint', () => {
  const CONTROLLER = read('src/modules/admin/presentation/admin-catalog.controller.ts');

  it('is PATCH admin/catalog/products/reorder, declared BEFORE products/:id so the path is not read as an id', () => {
    expect(CONTROLLER).toMatch(/@Patch\('products\/reorder'\)/);
    expect(CONTROLLER.indexOf("@Patch('products/reorder')")).toBeLessThan(CONTROLLER.indexOf("@Patch('products/:id')"));
  });

  it('reuses Product.update (no new permission) and keeps the admin + permission guards', () => {
    const route = CONTROLLER.slice(0, CONTROLLER.indexOf("@Patch('products/reorder')"));
    expect(route.match(/@Permissions\('Product\.update'\)/g)?.length).toBe(1); // the one immediately above it
    expect(CONTROLLER).toMatch(/@UseGuards\(AdminGuard, PermissionGuard\)/);
    expect(CONTROLLER).not.toMatch(/Product\.reorder|ProductSequence\./);
  });

  it('passes the authenticated admin, never a body-supplied identity', () => {
    expect(CONTROLLER).toMatch(/reorderProducts\(@Body\(\) dto: ReorderProductsDto, @CurrentAdmin\(\) admin: AdminUser\)/);
    expect(CONTROLLER).toMatch(/this\.adminService\.reorderProducts\(dto\.items, admin\?\.sub\)/);
  });
});
