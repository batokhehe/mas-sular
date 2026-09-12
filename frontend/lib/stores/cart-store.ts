import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Product } from '@/lib/types/models'

export interface CartLine {
  productId: string
  slug: string
  name: string
  price: number
  imageUrl: string
  qty: number
  /**
   * P2 #6: whether this line goes to checkout. Kept ON the line (not as a separate
   * id list), so removing a line removes its selection and no stale id can exist.
   */
  selected: boolean
}

interface CartState {
  lines: CartLine[]
  add: (product: Product, qty?: number) => void
  remove: (productId: string) => void
  setQty: (productId: string, qty: number) => void
  setSelected: (productId: string, selected: boolean) => void
  setAllSelected: (selected: boolean) => void
  /** Drops exactly these lines - used after an order for the items it contained. */
  removeLines: (productIds: readonly string[]) => void
  clear: () => void
}

/**
 * Hydration guard for what is stored under `ms_cart`. Lines saved before P2 #6 have
 * no `selected` flag; they count as selected, which is exactly what checkout did
 * with them before (the whole cart). Only an explicit `false` stays unselected.
 * Malformed entries and duplicate product ids are dropped.
 */
export function normalizeCartLines(raw: unknown): CartLine[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const lines: CartLine[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const line = entry as Partial<CartLine>
    if (typeof line.productId !== 'string' || seen.has(line.productId)) continue
    if (typeof line.qty !== 'number' || !Number.isInteger(line.qty) || line.qty < 1) continue
    seen.add(line.productId)
    lines.push({ ...(line as CartLine), selected: line.selected !== false })
  }
  return lines
}

export const useCartStore = create<CartState>()(
  persist(
    (set) => ({
      lines: [],
      // Adding (or adding more of) a product selects it - the customer just said
      // they want it.
      add: (product, qty = 1) =>
        set((state) => {
          const existing = state.lines.find((l) => l.productId === product.id)
          if (existing) {
            return {
              lines: state.lines.map((l) =>
                l.productId === product.id ? { ...l, qty: l.qty + qty, selected: true } : l,
              ),
            }
          }
          return {
            lines: [
              ...state.lines,
              {
                productId: product.id,
                slug: product.slug,
                name: product.name,
                price: product.price,
                imageUrl: product.imageUrl,
                qty,
                selected: true,
              },
            ],
          }
        }),
      remove: (productId) =>
        set((state) => ({ lines: state.lines.filter((l) => l.productId !== productId) })),
      setQty: (productId, qty) =>
        set((state) => ({
          lines:
            qty <= 0
              ? state.lines.filter((l) => l.productId !== productId)
              : state.lines.map((l) => (l.productId === productId ? { ...l, qty } : l)),
        })),
      setSelected: (productId, selected) =>
        set((state) => ({
          lines: state.lines.map((l) => (l.productId === productId ? { ...l, selected } : l)),
        })),
      setAllSelected: (selected) =>
        set((state) => ({ lines: state.lines.map((l) => ({ ...l, selected })) })),
      removeLines: (productIds) =>
        set((state) => ({ lines: state.lines.filter((l) => !productIds.includes(l.productId)) })),
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

export const cartSubtotal = (lines: CartLine[]): number =>
  lines.reduce((sum, l) => sum + l.price * l.qty, 0)

export const cartCount = (lines: CartLine[]): number =>
  lines.reduce((sum, l) => sum + l.qty, 0)

/** The lines the customer ticked for checkout. */
export const selectedLines = (lines: CartLine[]): CartLine[] => lines.filter((l) => l.selected)

/** Display-only estimate for the ticked lines; the server prices the order itself. */
export const selectedSubtotal = (lines: CartLine[]): number => cartSubtotal(selectedLines(lines))

/**
 * The explicit checkout subset: product id + quantity of the ticked lines only.
 * No price, no subtotal - the backend reprices and revalidates every item.
 */
export const toCheckoutItems = (lines: CartLine[]): { product_id: string; qty: number }[] =>
  selectedLines(lines).map((l) => ({ product_id: l.productId, qty: l.qty }))
