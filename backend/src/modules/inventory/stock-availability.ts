import { Prisma } from '@prisma/client';

/**
 * Customer-facing stock availability, derived ONLY from the "Stok Produk"
 * inventory (ProductInventory: per-outlet stock and reserved holds). The master
 * Product.stock is never read for availability.
 *
 * A checkout is fulfilled by ONE outlet (InventoryAllocationService), so what a
 * single order can get of a product is the best single active outlet's
 * `stock - reserved`, never a sum across outlets. A product with no Stok Produk
 * row at any active outlet is unavailable (0). Never negative: a row whose holds
 * exceed its stock (e.g. stock edited below the reserved quantity) reads 0.
 *
 * Non-locking: for display and early validation. The authoritative check is the
 * FOR UPDATE read in InventoryReservationService.reserveForOrder.
 */
export type InventoryReader = {
  productInventory: {
    findMany(args: {
      where: Prisma.ProductInventoryWhereInput;
      select: { productId: true; stock: true; reserved: true };
    }): Promise<Array<{ productId: string; stock: number; reserved: number }>>;
  };
};

export async function loadAvailableStock(
  db: InventoryReader,
  productIds: readonly string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(productIds)];
  const available = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return available;
  const rows = await db.productInventory.findMany({
    where: { productId: { in: ids }, outlet: { isActive: true } },
    select: { productId: true, stock: true, reserved: true },
  });
  for (const row of rows) {
    const atOutlet = Math.max(0, row.stock - row.reserved);
    available.set(row.productId, Math.max(available.get(row.productId) ?? 0, atOutlet));
  }
  return available;
}
