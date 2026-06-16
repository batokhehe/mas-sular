import { create } from 'zustand'
import type { Order } from '@/lib/types/models'

interface LastOrderState {
  order: Order | null
  setOrder: (order: Order) => void
  clear: () => void
}

/** Holds the just-created order so the success page can render it without a
 *  customer single-order GET (which the backend does not expose). */
export const useLastOrderStore = create<LastOrderState>((set) => ({
  order: null,
  setOrder: (order) => set({ order }),
  clear: () => set({ order: null }),
}))
