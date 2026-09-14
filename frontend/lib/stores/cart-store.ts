import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { CheckoutItem, Product, Topping } from '@/lib/types/models'

/** A topping as the cart keeps it: enough to show and re-send it, nothing more. */
export interface CartTopping {
  id: string
  name: string
  price: number
}

export interface CartLine {
  /**
   * Identity of the line: the product plus its exact topping set. A product without
   * toppings keeps `lineId === productId` (the shape carts had before toppings), so
   * "Baso" and "Baso + Keju" are two lines while re-adding the same combo merges.
   */
  lineId: string
  productId: string
  slug: string
  name: string
  /** Base product price. The per-unit price with toppings is `lineUnitPrice(line)`. */
  price: number
  imageUrl: string
  qty: number
  /** Chosen toppings - deduped and sorted by id. Empty when none were chosen. */
  toppings: CartTopping[]
  /**
   * P2 #6: whether this line goes to checkout. Kept ON the line (not as a separate
   * id list), so removing a line removes its selection and no stale id can exist.
   */
  selected: boolean
}

interface CartState {
  lines: CartLine[]
  add: (product: Product, qty?: number, toppings?: readonly CartTopping[]) => void
  remove: (lineId: string) => void
  setQty: (lineId: string, qty: number) => void
  setSelected: (lineId: string, selected: boolean) => void
  setAllSelected: (selected: boolean) => void
  /** Drops exactly these lines - used after an order for the items it contained. */
  removeLines: (lineIds: readonly string[]) => void
  clear: () => void
}

/** Dedupe by id and sort by id, so the same combination always yields the same line. */
export function normalizeToppings(toppings: readonly (CartTopping | Topping)[]): CartTopping[] {
  const byId = new Map<string, CartTopping>()
  for (const t of toppings) if (!byId.has(t.id)) byId.set(t.id, { id: t.id, name: t.name, price: t.price })
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** `productId` alone when there are no toppings; otherwise productId + sorted topping ids. */
export const cartLineId = (productId: string, toppings: readonly CartTopping[]): string =>
  toppings.length === 0 ? productId : `${productId}+${normalizeToppings(toppings).map((t) => t.id).join(',')}`

const isCartTopping = (t: unknown): t is CartTopping =>
  !!t &&
  typeof t === 'object' &&
  typeof (t as CartTopping).id === 'string' &&
  typeof (t as CartTopping).name === 'string' &&
  typeof (t as CartTopping).price === 'number' &&
  Number.isFinite((t as CartTopping).price) &&
  (t as CartTopping).price >= 0

/**
 * Hydration guard for what is stored under `ms_cart`. Lines saved before P2 #6 have
 * no `selected` flag; they count as selected, which is exactly what checkout did
 * with them before (the whole cart). Only an explicit `false` stays unselected.
 * Lines saved before toppings have no `toppings`/`lineId`; they hydrate as plain
 * lines (`lineId === productId`). The line id is always re-derived, never trusted.
 * Malformed entries (including malformed toppings - dropping just the topping would
 * silently change the order) and duplicate lines are dropped.
 */
export function normalizeCartLines(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const lines: CartLine[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const line = entry as Partial<CartLine>
    if (typeof line.productId !== 'string') continue
    if (typeof line.qty !== 'number' || !Number.isInteger(line.qty) || line.qty < 1) continue
    const rawToppings: unknown = line.toppings ?? []
    if (!Array.isArray(rawToppings) || !rawToppings.every(isCartTopping)) continue
    const toppings = normalizeToppings(rawToppings)
    const lineId = cartLineId(line.productId, toppings)
    if (seen.has(lineId)) continue
    seen.add(lineId)
    lines.push({ ...(line as CartLine), lineId, toppings, selected: line.selected !== false })
  }
  return lines
}

export const useCartStore = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      // Adding (or adding more of) a product selects it - the customer just said
      // they want it. The same product with the same toppings merges into one line;
      // a different topping set is its own line.
      add: (product, qty = 1, chosen = []) =>
        set((state) => {
          const toppings = normalizeToppings(chosen)
          const lineId = cartLineId(product.id, toppings)
          const existing = state.lines.find((l) => l.lineId === lineId)
          if (existing) {
            return {
              lines: state.lines.map((l) =>
                l.lineId === lineId ? { ...l, qty: l.qty + qty, selected: true } : l,
              ),
            }
          }
          return {
            lines: [
              ...state.lines,
              {
                lineId,
                productId: product.id,
                slug: product.slug,
                name: product.name,
                price: product.price,
                imageUrl: product.imageUrl,
                qty,
                toppings,
                selected: true,
              },
            ],
          }
        }),
      remove: (lineId) =>
        set((state) => ({ lines: state.lines.filter((l) => l.lineId !== lineId) })),
      setQty: (lineId, qty) =>
        set((state) => ({
          lines:
            qty <= 0
              ? state.lines.filter((l) => l.lineId !== lineId)
              : state.lines.map((l) => (l.lineId === lineId ? { ...l, qty } : l)),
        })),
      setSelected: (lineId, selected) =>
        set((state) => ({
          lines: state.lines.map((l) => (l.lineId === lineId ? { ...l, selected } : l)),
        })),
      setAllSelected: (selected) =>
        set((state) => ({ lines: state.lines.map((l) => ({ ...l, selected })) })),
      removeLines: (lineIds) =>
        set((state) => ({ lines: state.lines.filter((l) => !lineIds.includes(l.lineId)) })),
      clear: () => set({ lines: [] }),
    }),
    {
      name: 'ms_cart',
      merge: (persisted, current) => ({
        ...current,
        lines: normalizeCartLines((persisted as { lines?: unknown } | undefined)?.lines),
      }),
    },
  ),
)

/**
 * Display price of one unit: product + its toppings - the same formula the backend
 * uses ((product.price + sum of topping prices) x qty). The server still reprices.
 */
export const lineUnitPrice = (line: CartLine): number => line.price + toppingsTotal(line.toppings)

/** Sum of topping prices for one unit (product page preview and cart lines alike). */
export const toppingsTotal = (toppings: readonly Pick<CartTopping, 'price'>[]): number =>
  toppings.reduce((sum, t) => sum + t.price, 0)

export const lineTotal = (line: CartLine): number => lineUnitPrice(line) * line.qty

export const cartSubtotal = (lines: CartLine[]): number =>
  lines.reduce((sum, l) => sum + lineTotal(l), 0)

export const cartCount = (lines: CartLine[]): number =>
  lines.reduce((sum, l) => sum + l.qty, 0)

/** The lines the customer ticked for checkout. */
export const selectedLines = (lines: CartLine[]): CartLine[] => lines.filter((l) => l.selected)

/** Display-only estimate for the ticked lines; the server prices the order itself. */
export const selectedSubtotal = (lines: CartLine[]): number => cartSubtotal(selectedLines(lines))

/**
 * The explicit checkout subset: product id + quantity (+ topping ids, when chosen) of
 * the ticked lines only. No price, no subtotal - the backend reprices and revalidates
 * every item and rejects toppings that are no longer available.
 */
export const toCheckoutItems = (lines: CartLine[]): CheckoutItem[] =>
  selectedLines(lines).map((l) =>
    l.toppings.length > 0
      ? { product_id: l.productId, qty: l.qty, topping_ids: l.toppings.map((t) => t.id) }
      : { product_id: l.productId, qty: l.qty },
  )
