import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Canonical product ordering. `Product.sequence` is set by dragging rows in
 * Admin -> Produk and is the DEFAULT order of every product list, in the Admin and
 * in the storefront alike. A consumer that asks for an explicit business sort
 * (price-low, price-high, rating, popular) keeps that sort - the sequence only
 * replaces the previous implicit defaults.
 *
 * The sequence is written ONLY by the reorder endpoint
 * (PATCH /admin/catalog/products/reorder). Product CRUD never touches it: creating a
 * product appends it (MAX + 1) and soft-deleting one leaves its value alone, so gaps
 * are normal and nothing is renumbered behind the admin's back.
 */

/**
 * The order itself. The createdAt/id tiebreak makes it a TOTAL order: two rows can
 * share a sequence (a row created straight through the API keeps the column default,
 * and two concurrent creates can land on the same MAX + 1), and a list must still have
 * one stable, reproducible order for paging and for the admin's drag list.
 */
export const PRODUCT_SEQUENCE_ORDER_BY: Prisma.ProductOrderByWithRelationInput[] = [
  { sequence: 'asc' },
  { createdAt: 'desc' },
  { id: 'asc' },
];

/** AuditLog coordinates of a reorder (project convention: entityCamel.verb + the model name). */
export const PRODUCT_REORDER_AUDIT_ACTION = 'product.reorder';
export const PRODUCT_AUDIT_ENTITY = 'Product';

/** The first sequence value. A reorder always writes a contiguous 1..N. */
export const FIRST_PRODUCT_SEQUENCE = 1;

export type ProductReorderItem = { id: string; sequence: number };

/**
 * Validates a reorder against the live set of products, server-side. The payload must
 * be the COMPLETE set of non-deleted products, each exactly once, carrying a
 * permutation of 1..N - so the server, not the browser, owns the numbering.
 *
 * An incomplete or stale snapshot (another admin created or deleted a product while
 * this one was dragging) is a 409, never a partial write: the admin reloads instead of
 * silently clobbering the other change. Anything malformed - an unknown id, a
 * soft-deleted id, a duplicate, a sequence outside 1..N - is a 400.
 *
 * Returns the items in their new order; the caller writes them in one transaction.
 */
export function validateProductReorder(items: readonly ProductReorderItem[], liveIds: readonly string[]): ProductReorderItem[] {
  const ids = items.map((item) => item.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new BadRequestException('Duplicate product in the reorder payload');

  const live = new Set(liveIds);
  const unknown = ids.filter((id) => !live.has(id));
  if (unknown.length > 0) throw new BadRequestException('Unknown or deleted product in the reorder payload');

  // Same size + every id live + no duplicates => exactly the live set.
  if (ids.length !== live.size) {
    throw new ConflictException('The product list changed; reload the page and reorder again');
  }

  const sequences = [...items].map((item) => item.sequence).sort((a, b) => a - b);
  const permutation = sequences.every((value, index) => value === FIRST_PRODUCT_SEQUENCE + index);
  if (!permutation) throw new BadRequestException(`Sequences must be a permutation of 1..${items.length}`);

  return [...items].sort((a, b) => a.sequence - b.sequence);
}
