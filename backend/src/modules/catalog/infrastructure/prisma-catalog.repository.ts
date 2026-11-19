import { Injectable, NotFoundException } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ListProductsQueryDto } from '../application/dto/catalog.dto';
import { CatalogRepository } from '../domain/catalog.repository';
import { PRODUCT_SEQUENCE_ORDER_BY } from '../product-sequence';
import { loadAvailableStock } from '../../inventory/stock-availability';

@Injectable()
export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(query: ListProductsQueryDto) {
    // Explicit business sorts are unchanged; `popular` is still most-reviewed first.
    // Everything else - the storefront's "Standar", the homepage sections, related
    // products - uses the canonical sequence the admin dragged into place.
    const orderBy =
      query.sort === 'price-low'
        ? { price: 'asc' as const }
        : query.sort === 'price-high'
          ? { price: 'desc' as const }
          : query.sort === 'rating'
            ? { rating: 'desc' as const }
            : query.sort === 'popular'
              ? { reviewCount: 'desc' as const }
              : PRODUCT_SEQUENCE_ORDER_BY;

    const products = await this.prisma.product.findMany({
      where: {
        status: ProductStatus.ACTIVE,
        deletedAt: null,
        category: query.category ? { slug: query.category } : undefined,
        // P2 #10 / #11: same visibility rules as every other listing, plus the flag(s).
        isPromoSpecial: query.promoSpecial,
        isTrialPack: query.trialPack,
        OR: query.search
          ? [
              { name: { contains: query.search } },
              { description: { contains: query.search } },
            ]
          : undefined,
      },
      include: { category: true },
      // P2 #5: SKU is internal (the courier item code) and never shown to customers,
      // so the public catalog does not send it at all. The master `stock` is not
      // sent either: customers see `availableStock` from Stok Produk instead.
      omit: { sku: true, stock: true },
      orderBy,
    });
    return this.withAvailableStock(products);
  }

  /** Adds `availableStock` (Stok Produk, see stock-availability.ts) to each product. */
  private async withAvailableStock<T extends { id: string }>(products: T[]): Promise<Array<T & { availableStock: number }>> {
    const available = await loadAvailableStock(this.prisma, products.map((p) => p.id));
    return products.map((p) => ({ ...p, availableStock: available.get(p.id) ?? 0 }));
  }

  async getProduct(idOrSlug: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        deletedAt: null,
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
      // P2 gallery, ordered, detail ONLY (listProducts never loads images). One
      // batched query alongside the product - no N+1.
      include: { category: true, images: { orderBy: { sortOrder: 'asc' }, select: { id: true, url: true, sortOrder: true } } },
      omit: { sku: true, stock: true }, // P2 #5 + Stok Produk rule - see listProducts
    });
    if (!product) throw new NotFoundException('Product not found');
    const [withStock] = await this.withAvailableStock([product]);
    return withStock;
  }

  listCategories() {
    return this.prisma.category.findMany({ where: { deletedAt: null }, orderBy: { sortOrder: 'asc' } });
  }

  listToppings() {
    return this.prisma.topping.findMany({ where: { deletedAt: null, isActive: true }, orderBy: { name: 'asc' } });
  }

  listPromos() {
    return this.prisma.promo.findMany({ where: { deletedAt: null, isActive: true }, orderBy: { createdAt: 'desc' } })
      .then((promos) => {
        const now = new Date();
        return promos.filter((promo) => {
          if (promo.startDate && promo.startDate > now) return false;
          if (promo.endDate && promo.endDate < now) return false;
          if (promo.maxUsageCount !== null && promo.currentUsageCount >= promo.maxUsageCount) return false;
          return true;
        });
      });
  }
}
