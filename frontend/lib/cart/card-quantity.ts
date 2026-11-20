/**
 * Product-card cart control - PURE (no React) so node --test can load it.
 *
 * The card shows "Tambahkan" until the product is in the cart, then `− qty +`. It
 * reads and writes the ONE shared cart store (lib/stores/cart-store.ts); nothing
 * here keeps its own quantity:
 *   - the counter is the product's PLAIN line - no add-ons - whose lineId is the
 *     productId (cartLineId with no toppings). That is the line the card's own
 *     "Tambahkan" creates, and `add` merges into it, so no duplicate line appears;
 *   - lines with add-ons ("Tambahan") are chosen and edited on the product page and
 *     in the cart; the card never changes them, it only reports how many there are;
 *   - stock is per PRODUCT across all of its lines (stock-limits.ts), so + stops at
 *     availableStock whatever mix of plain and add-on lines the cart holds. The
 *     backend re-validates at checkout; this only keeps the UI honest.
 */
import { cartQtyForProduct, remainingAddable } from './stock-limits.ts'

export interface CardCartLine {
  lineId: string
  productId: string
  qty: number
}

export type CardCartMode = 'add' | 'counter' | 'soldout' | 'full'

export interface CardCartState {
  /** add: "Tambahkan"; counter: `− qty +`; soldout: "Stok Habis"; full: "Stok di keranjang penuh". */
  mode: CardCartMode
  /** Quantity of the plain line (what the counter shows). 0 when there is none. */
  qty: number
  /** Units of this product in add-on lines (not controlled by the card). */
  addOnQty: number
  /** Whether + / "Tambahkan" may add one more unit within availableStock. */
  canIncrement: boolean
}

/** The product's plain line: cartLineId(productId, []) === productId. */
export const plainLineId = (productId: string): string => productId

export function cardCartState(
  lines: readonly CardCartLine[],
  productId: string,
  availableStock: number,
): CardCartState {
  const qty = lines.find((l) => l.lineId === plainLineId(productId))?.qty ?? 0
  const addOnQty = cartQtyForProduct(lines, productId) - qty
  const canIncrement = Number.isFinite(availableStock) && remainingAddable(lines, productId, availableStock) > 0

  // Already in the cart: always the counter, even if stock has since dropped (+ is
  // then disabled, − still works), so a customer can always reduce or remove.
  if (qty > 0) return { mode: 'counter', qty, addOnQty, canIncrement }
  if (!(availableStock > 0)) return { mode: 'soldout', qty: 0, addOnQty, canIncrement: false }
  if (!canIncrement) return { mode: 'full', qty: 0, addOnQty, canIncrement: false }
  return { mode: 'add', qty: 0, addOnQty, canIncrement: true }
}
