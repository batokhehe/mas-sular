import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { ListProductsQueryDto } from '../../src/modules/catalog/application/dto/catalog.dto';
import { PrismaCatalogRepository } from '../../src/modules/catalog/infrastructure/prisma-catalog.repository';
import { PRODUCT_SEQUENCE_ORDER_BY } from '../../src/modules/catalog/product-sequence';

/**
 * GET /catalog/products?sort=best-selling - the cart page's "Rekomendasi Menu Lain".
 * Ranking comes from real sales only: OrderItem quantities of non-deleted,
 * non-cancelled orders whose payment is PAID. The response is the product list in
 * that order; the unit counts themselves are never returned.
 */

const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, transformOptions: { enableImplicitConversion: true } });
const asQuery: ArgumentMetadata = { type: 'query', metatype: ListProductsQueryDto };

const product = (id: string) => ({ id, name: id, slug: id });

function build(products: Array<{ id: string }>, sold: Array<{ productId: string; units: number | null }>) {
  const findMany = jest.fn().mockResolvedValue(products);
  const groupBy = jest.fn().mockResolvedValue(sold.map((s) => ({ productId: s.productId, _sum: { quantity: s.units } })));
  const repo = new PrismaCatalogRepository({
    product: { findMany },
    orderItem: { groupBy },
    productInventory: { findMany: jest.fn().mockResolvedValue([]) },
  } as never);
  return { repo, findMany, groupBy };
}

describe('sort=best-selling', () => {
  it('is accepted by the query DTO; unknown sorts are still rejected', async () => {
    expect((await pipe.transform({ sort: 'best-selling' }, asQuery)).sort).toBe('best-selling');
    await expect(pipe.transform({ sort: 'most-sold' }, asQuery)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('orders by units sold on PAID, non-cancelled, non-deleted orders only', async () => {
    const { repo, groupBy } = build([product('a'), product('b'), product('c')], [{ productId: 'b', units: 9 }, { productId: 'c', units: 3 }]);
    const result = await repo.listProducts({ sort: 'best-selling' } as never);
    expect(result.map((p) => p.id)).toEqual(['b', 'c', 'a']);
    expect(groupBy).toHaveBeenCalledWith({
      by: ['productId'],
      where: {
        productId: { in: ['a', 'b', 'c'] },
        order: { deletedAt: null, status: { not: 'CANCELLED' }, payment: { is: { status: 'PAID', deletedAt: null } } },
      },
      _sum: { quantity: true },
    });
  });

  it('fetches in the canonical sequence, so ties and never-sold products keep it', async () => {
    const { repo, findMany } = build([product('s1'), product('s2'), product('s3'), product('s4')], [{ productId: 's3', units: 2 }, { productId: 's4', units: 2 }]);
    const result = await repo.listProducts({ sort: 'best-selling' } as never);
    expect(findMany.mock.calls[0][0].orderBy).toBe(PRODUCT_SEQUENCE_ORDER_BY);
    expect(result.map((p) => p.id)).toEqual(['s3', 's4', 's1', 's2']);
  });

  it('never exposes sales numbers and keeps the usual public shape (availableStock, no sku/stock)', async () => {
    const { repo, findMany } = build([product('a')], [{ productId: 'a', units: 5 }]);
    const [only] = await repo.listProducts({ sort: 'best-selling' } as never);
    expect(Object.keys(only).sort()).toEqual(['availableStock', 'id', 'name', 'slug']);
    expect(findMany.mock.calls[0][0].omit).toEqual({ sku: true, stock: true });
  });

  it('a null sum (no paid units) counts as zero; an empty list makes no sales query', async () => {
    const { repo } = build([product('a'), product('b')], [{ productId: 'a', units: null }, { productId: 'b', units: 1 }]);
    expect((await repo.listProducts({ sort: 'best-selling' } as never)).map((p) => p.id)).toEqual(['b', 'a']);
    const empty = build([], []);
    await empty.repo.listProducts({ sort: 'best-selling' } as never);
    expect(empty.groupBy).not.toHaveBeenCalled();
  });

  it('other sorts make no sales query', async () => {
    for (const sort of [undefined, 'popular', 'price-low', 'price-high', 'rating']) {
      const { repo, groupBy } = build([product('a')], []);
      await repo.listProducts({ sort } as never);
      expect(groupBy).not.toHaveBeenCalled();
    }
  });
});
