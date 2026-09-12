import { Prisma } from '@prisma/client';

/**
 * Internal product SKU (P2 #5).
 *
 * SKU is no longer shown to customers or admins, but it is still load-bearing: it
 * is the Paxel item `code` (shipment.service -> PaxelShipmentProvider.buildItem),
 * and Paxel refuses to book an item without one. So a product created without an
 * explicit SKU gets one assigned here, from its UNIQUE slug, in the convention every
 * existing SKU already follows: `baso-urat-jumbo` -> `BASO_URAT_JUMBO`.
 *
 * Deterministic and derived only from the product's own slug - nothing random,
 * nothing borrowed from another record.
 */
export function skuFromSlug(slug: string): string {
  const derived = slug
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return derived || 'PRODUCT';
}

/**
 * The SKUs to try, in order: the derived SKU, then `_2`, `_3`, ... A collision is
 * only possible with a SKU someone set by hand on a DIFFERENT product (slugs are
 * unique, so two derived SKUs cannot collide with each other).
 */
export function skuCandidates(base: string, max = 20): string[] {
  return Array.from({ length: max }, (_, i) => (i === 0 ? base : `${base}_${i + 1}`));
}

/** True when `err` is a unique-constraint violation on Product.sku (not slug or any other field). */
export function isSkuUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  return JSON.stringify(err.meta?.target ?? '').toLowerCase().includes('sku');
}
