import { Prisma } from '@prisma/client';
import { InventoryReader, loadAvailableStock } from './stock-availability';

/**
 * Admin stock-level metrics (dashboard "Stok Menipis" / "Stok Habis" / restock list),
 * derived from the SAME availability the storefront and checkout use:
 * loadAvailableStock (Stok Produk - best single active outlet's stock - reserved).
 * The legacy master Product.stock is never read here.
 */
export const LOW_STOCK_THRESHOLD = 10;
export const RESTOCK_LIST_LIMIT = 10;

export type ProductNameReader = {
  product: {
    findMany(args: {
      where: Prisma.ProductWhereInput;
      select: { id: true; name: true };
    }): Promise<Array<{ id: string; name: string }>>;
  };
};

export interface ProductStockLevel {
  id: string;
  name: string;
  /** Available units per Stok Produk (never negative). */
  available: number;
}

export interface StockLevels {
  /** 0 < available <= threshold. */
  lowStock: number;
  /** available <= 0 (no Stok Produk row at an active outlet counts as 0). */
  outOfStock: number;
  /** Every product with available <= threshold, lowest first (ties by name). */
  atOrBelowThreshold: ProductStockLevel[];
}

export async function loadStockLevels(
  db: InventoryReader & ProductNameReader,
  where: Prisma.ProductWhereInput,
  threshold = LOW_STOCK_THRESHOLD,
): Promise<StockLevels> {
  const products = await db.product.findMany({ where, select: { id: true, name: true } });
  const available = await loadAvailableStock(db, products.map((p) => p.id));
  const rows = products.map((p) => ({ id: p.id, name: p.name, available: available.get(p.id) ?? 0 }));
  return {
    lowStock: rows.filter((r) => r.available > 0 && r.available <= threshold).length,
    outOfStock: rows.filter((r) => r.available <= 0).length,
    atOrBelowThreshold: rows
      .filter((r) => r.available <= threshold)
      .sort((a, b) => a.available - b.available || a.name.localeCompare(b.name)),
  };
}
