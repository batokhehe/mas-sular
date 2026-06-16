'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ordersApi, type CreateOrderInput } from '@/lib/api/orders.api'
import { useMe } from './use-me'

interface CheckoutVars {
  input: CreateOrderInput
  /** Stable per attempt — keep the SAME key across retries (e.g. in a ref). */
  idempotencyKey: string
}

export function useCheckout() {
  const qc = useQueryClient()
  const { data: me } = useMe()
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: CheckoutVars) =>
      ordersApi.createOrder(input, idempotencyKey),
    onSuccess: () => {
      if (me) qc.invalidateQueries({ queryKey: ['orders', me.id] })
    },
  })
}
