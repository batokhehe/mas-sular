/**
 * Storefront stock limits. Availability is `Product.availableStock` from the catalog
 * API, which the backend derives from the "Stok Produk" inventory (never from the
 * master product stock). The backend re-validates at checkout and when the order is
 * created, so these limits only keep the UI honest; they are never the authority.
 */

export interface StockLine {
  productId: string
  qty: number
}

/** Total quantity of one product across all cart lines (topping variants included). */
export function cartQtyForProduct(lines: readonly StockLine[], productId: string): number {
  return lines.reduce((sum, line) => (line.productId === productId ? sum + line.qty : sum), 0)
}

/** How many more of a product can still be added, given what the cart already holds. */
export function remainingAddable(lines: readonly StockLine[], productId: string, available: number): number {
  return Math.max(0, Math.floor(available) - cartQtyForProduct(lines, productId))
}

/** Clamp a chosen quantity to [1, max]; 0 when nothing can be added. */
export function clampQty(qty: number, max: number): number {
  if (max <= 0) return 0
  return Math.min(Math.max(1, Math.floor(qty)), max)
}

/** Whether a cart line's "+" may add one more of its product. */
export function canIncrease(lines: readonly StockLine[], productId: string, available: number | undefined): boolean {
  if (available === undefined) return true // availability not loaded yet: the backend still decides
  return cartQtyForProduct(lines, productId) < available
}

export interface StockIssue {
  productId: string
  inCart: number
  available: number
}

/**
 * Products whose cart quantity exceeds current availability (stale cart: stock
 * changed since the items were added). Unknown availability is not an issue.
 */
export function stockIssues(lines: readonly StockLine[], availability: ReadonlyMap<string, number>): StockIssue[] {
  const issues: StockIssue[] = []
  for (const productId of new Set(lines.map((l) => l.productId))) {
    const available = availability.get(productId)
    if (available === undefined) continue
    const inCart = cartQtyForProduct(lines, productId)
    if (inCart > available) issues.push({ productId, inCart, available })
  }
  return issues
}
