import { Injectable, NotFoundException } from '@nestjs/common';
import { ProductStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ListProductsQueryDto } from '../application/dto/catalog.dto';
import { CatalogRepository } from '../domain/catalog.repository';

@Injectable()
export class PrismaCatalogRepository implements CatalogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listProducts(query: ListProductsQueryDto) {
    const orderBy =
      query.sort === 'price-low'
        ? { price: 'asc' as const }
        : query.sort === 'price-high'
          ? { price: 'desc' as const }
          : query.sort === 'rating'
            ? { rating: 'desc' as const }
            : { reviewCount: 'desc' as const };

    return this.prisma.product.findMany({
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
      // so the public catalog does not send it at all.
      omit: { sku: true },
      orderBy,
    });
  }

  async getProduct(idOrSlug: string) {
    const product = await this.prisma.product.findFirst({
      where: {
        deletedAt: null,
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
      include: { category: true },
      omit: { sku: true }, // P2 #5: internal only - see listProducts
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
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
