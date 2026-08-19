'use client'

import { useQuery } from '@tanstack/react-query'
import { ordersApi } from '@/lib/api/orders.api'
import type { CheckoutItem } from '@/lib/types/models'

/**
 * Fetches the available shipping services for the cart + selected address. Enabled
 * only when the address is deliverable (coverage = DELIVERY / unconfigured). The
 * backend applies the coverage gate, so DISABLED/PICKUP_ONLY areas error here.
 */
export function useShippingOptions(
  addressId: string | undefined,
  items: CheckoutItem[],
  enabled: boolean,
) {
  const itemsKey = items.map((i) => `${i.product_id}x${i.qty}`).join(',')
  return useQuery({
    queryKey: ['checkout', 'shipping-options', addressId, itemsKey],
    queryFn: () => ordersApi.shippingOptions({ address_id: addressId as string, items }),
    enabled: !!addressId && items.length > 0 && enabled,
    staleTime: 1000 * 60,
    retry: false,
  })
}
