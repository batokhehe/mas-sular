import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

interface CheckoutAddressState {
  /** The address the customer deliberately picked for this checkout; null = use the default rule. */
  addressId: string | null
  choose: (addressId: string) => void
  clear: () => void
}

/**
 * P2 #7/#18 — keeps the customer's delivery-address choice while they go to the
 * Address Book and back (Checkout's form state does not survive the navigation).
 * Session-scoped (tab), holds only an id, and is cleared once an order is placed.
 */
export const useCheckoutAddressStore = create<CheckoutAddressState>()(
  persist(
    (set) => ({
      addressId: null,
      choose: (addressId) => set({ addressId }),
      clear: () => set({ addressId: null }),
    }),
    { name: 'ms_checkout_address', storage: createJSONStorage(() => sessionStorage) },
  ),
)
