'use client'

import { useQuery } from '@tanstack/react-query'
import { ordersApi } from '@/lib/api/orders.api'
import type { CheckoutItem } from '@/lib/types/models'

interface CheckoutSummaryParams {
  addressId?: string
  provider?: string
  service?: string
  voucherCode?: string
  items: CheckoutItem[]
  enabled: boolean
}

/**
 * Server-authoritative checkout summary. The backend `/checkout/summary` endpoint
 * computes subtotal, shipping, voucher discount, and grand total — the frontend
 * only renders them. Read-only (no reservation / order side effects).
 */
export function useCheckoutSummary(params: CheckoutSummaryParams) {
  const { addressId, provider, service, voucherCode, items, enabled } = params
  return useQuery({
    queryKey: ['checkout-summary', addressId, provider, service, voucherCode ?? '', items],
    queryFn: () =>
      ordersApi.summary({
        address_id: addressId as string,
        // provider+service drive the quote; courier is kept for backward compat.
        courier: (provider as 'paxel' | 'jne') ?? 'jne',
        shipping_provider: provider,
        shipping_service: service,
        voucher_code: voucherCode || undefined,
        items,
      }),
    enabled: enabled && !!addressId && !!provider && !!service && items.length > 0,
    staleTime: 15_000,
    retry: false,
  })
}
