import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminService } from '../../src/modules/admin/admin.service';
import { CreateProductDto } from '../../src/modules/admin/application/dto/create-product.dto';
import { isSkuUniqueViolation, skuCandidates, skuFromSlug } from '../../src/modules/admin/product-sku';
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository';

/**
 * P2 #5 — SKU is hidden from customers and admins, but it stays in the schema and
 * stays load-bearing: it is the Paxel item `code`, and Paxel refuses to book without
 * one. So the Admin form no longer sends it, the backend assigns it from the slug,
 * and the public catalog no longer returns it.
 */

const uniqueViolation = (target: unknown) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta: { target } });

const DTO = { slug: 'baso-urat-jumbo', name: 'Baso Urat Jumbo', description: 'x', price: 30000, imageUrl: '/x.png', categoryId: 'c1' };

function adminWith(create: jest.Mock, update: jest.Mock = jest.fn().mockResolvedValue({})) {
  const prisma = {
    product: {
      create,
      update,
      findUnique: jest.fn().mockResolvedValue({ id: 'p1', deletedAt: null }),
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new AdminService(prisma as any, {} as any);
}

describe('skuFromSlug — the existing SKU convention', () => {
  it.each([
    // Every SKU in the database today follows exactly this shape.
    ['baso-urat-jumbo', 'BASO_URAT_JUMBO'],
    ['baso-keju-mozarella', 'BASO_KEJU_MOZARELLA'],
    ['baso-mercon-super-pedas', 'BASO_MERCON_SUPER_PEDAS'],
    ['es-teh-manis', 'ES_TEH_MANIS'],
  ])('%s -> %s', (slug, sku) => {
    expect(skuFromSlug(slug)).toBe(sku);
  });

  it('collapses any non-alphanumeric run and trims the edges', () => {
    expect(skuFromSlug('  --baso  urat//2--  ')).toBe('BASO_URAT_2');
  });

  it('never returns an empty SKU (Paxel rejects an empty item code)', () => {
    expect(skuFromSlug('---')).toBe('PRODUCT');
    expect(skuFromSlug('')).toBe('PRODUCT');
  });

  it('candidates are the base SKU, then _2, _3 ...', () => {
    expect(skuCandidates('BASO', 3)).toEqual(['BASO', 'BASO_2', 'BASO_3']);
  });

  it('only a unique violation on sku counts as a SKU collision', () => {
    expect(isSkuUniqueViolation(uniqueViolation(['sku']))).toBe(true);
    expect(isSkuUniqueViolation(uniqueViolation('Product_sku_key'))).toBe(true);
    expect(isSkuUniqueViolation(uniqueViolation(['slug']))).toBe(false);
    expect(isSkuUniqueViolation(new Error('boom'))).toBe(false);
  });
});

describe('CreateProductDto — SKU is optional', () => {
  const errorsFor = async (body: Record<string, unknown>) =>
    (await validate(plainToInstance(CreateProductDto, body))).map((e) => e.property);

  it('accepts a product with no SKU at all (the Admin form no longer sends one)', async () => {
    expect(await errorsFor(DTO)).not.toContain('sku');
  });

  it('still accepts an explicit SKU from an API client', async () => {
    expect(await errorsFor({ ...DTO, sku: 'CUSTOM-1' })).not.toContain('sku');
  });

  it('still rejects a SKU that is not a string', async () => {
    expect(await errorsFor({ ...DTO, sku: 123 })).toContain('sku');
  });
});

describe('AdminService.createProduct', () => {
  it('assigns the SKU from the slug when none is sent', async () => {
    const create = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'p1', ...data }));
    const product = await adminWith(create).createProduct({ ...DTO } as CreateProductDto);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].data.sku).toBe('BASO_URAT_JUMBO');
    expect(product.sku).toBe('BASO_URAT_JUMBO');
  });

  it.each(['', '   '])('treats a blank SKU (%p) as absent - never writes it (it would collide on @unique)', async (sku) => {
    const create = jest.fn().mockResolvedValue({});
    await adminWith(create).createProduct({ ...DTO, sku } as CreateProductDto);
    expect(create.mock.calls[0][0].data.sku).toBe('BASO_URAT_JUMBO');
  });

  it('honours an explicit SKU exactly as before', async () => {
    const create = jest.fn().mockResolvedValue({});
    await adminWith(create).createProduct({ ...DTO, sku: 'HAND-SET-1' } as CreateProductDto);
    expect(create).toHaveBeenCalledWith({ data: { ...DTO, sku: 'HAND-SET-1' } });
  });

  it('moves to BASE_2 when the derived SKU is already taken by another product', async () => {
    const create = jest.fn()
      .mockRejectedValueOnce(uniqueViolation(['sku']))
      .mockImplementation(({ data }) => Promise.resolve({ id: 'p2', ...data }));
    const product = await adminWith(create).createProduct({ ...DTO } as CreateProductDto);

    expect(create.mock.calls.map(([arg]) => arg.data.sku)).toEqual(['BASO_URAT_JUMBO', 'BASO_URAT_JUMBO_2']);
    expect(product.sku).toBe('BASO_URAT_JUMBO_2');
  });

  it('does NOT retry a duplicate SLUG - that error surfaces exactly as before', async () => {
    const slugTaken = uniqueViolation(['slug']);
    const create = jest.fn().mockRejectedValue(slugTaken);
    await expect(adminWith(create).createProduct({ ...DTO } as CreateProductDto)).rejects.toBe(slugTaken);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('gives up with a 409 rather than looping forever', async () => {
    const create = jest.fn().mockRejectedValue(uniqueViolation(['sku']));
    await expect(adminWith(create).createProduct({ ...DTO } as CreateProductDto)).rejects.toBeInstanceOf(ConflictException);
    expect(create).toHaveBeenCalledTimes(20);
  });
});

describe('AdminService.updateProduct', () => {
  it('an edit without a SKU leaves the stored SKU untouched (the Admin form never sends one)', async () => {
    const update = jest.fn().mockResolvedValue({});
    await adminWith(jest.fn(), update).updateProduct('p1', { name: 'Renamed' });
    expect(update).toHaveBeenCalledWith({ where: { id: 'p1' }, data: { name: 'Renamed' } });
  });

  it.each(['', '  '])('a blank SKU (%p) is ignored, never written', async (sku) => {
    const update = jest.fn().mockResolvedValue({});
    await adminWith(jest.fn(), update).updateProduct('p1', { name: 'Renamed', sku });
    expect(update.mock.calls[0][0].data).toEqual({ name: 'Renamed' });
  });

  it('a non-blank SKU from an API client is still applied', async () => {
    const update = jest.fn().mockResolvedValue({});
    await adminWith(jest.fn(), update).updateProduct('p1', { sku: 'NEW-SKU' });
    expect(update.mock.calls[0][0].data).toEqual({ sku: 'NEW-SKU' });
  });
});

describe('public catalog never sends SKU to customers', () => {
  function catalogWith(rows: unknown[]) {
    const findMany = jest.fn().mockResolvedValue(rows);
    const findFirst = jest.fn().mockResolvedValue(rows[0] ?? null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { repo: new PrismaCatalogRepository({ product: { findMany, findFirst } } as any), findMany, findFirst };
  }

  it('listProducts omits sku at the query', async () => {
    const { repo, findMany } = catalogWith([]);
    await repo.listProducts({} as never);
    expect(findMany.mock.calls[0][0]).toMatchObject({ include: { category: true }, omit: { sku: true } });
  });

  it('getProduct omits sku at the query', async () => {
    const { repo, findFirst } = catalogWith([{ id: 'p1' }]);
    await repo.getProduct('baso-urat-jumbo');
    expect(findFirst.mock.calls[0][0]).toMatchObject({ include: { category: true }, omit: { sku: true } });
  });
});
