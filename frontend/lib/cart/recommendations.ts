/**
 * "Rekomendasi Menu Lain" on the cart page - PURE (no React) so node --test can load it.
 *
 * The input is the catalog list fetched with `sort=best-selling`: the backend orders
 * products by units actually sold on paid, non-cancelled orders (catalog repository
 * `byUnitsSold`), and products without paid sales follow in the canonical sequence.
 * Nothing here ranks, scores or invents sales; it only keeps that server order and
 * drops what cannot be recommended.
 */

export const RECOMMENDATION_LIMIT = 4

export interface RecommendableProduct {
  id: string
  availableStock: number
}

export function pickRecommendations<P extends RecommendableProduct>(
  rankedProducts: readonly P[],
  cartProductIds: Iterable<string>,
  limit: number = RECOMMENDATION_LIMIT,
): P[] {
  const inCart = new Set(cartProductIds)
  const picked: P[] = []
  for (const product of rankedProducts) {
    if (picked.length >= limit) break
    // Already in the cart, or nothing left to sell: not a useful suggestion.
    if (inCart.has(product.id) || !(product.availableStock > 0)) continue
    picked.push(product)
  }
  return picked
}
