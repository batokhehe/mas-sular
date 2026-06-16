'use client'

import { useQuery } from '@tanstack/react-query'
import { ordersApi } from '@/lib/api/orders.api'
import { qk } from '@/lib/query/keys'
import { useMe } from './use-me'

export function useOrders(status?: string) {
  const { data: me } = useMe()
  return useQuery({
    queryKey: qk.orders(me?.id ?? '', status),
    queryFn: () => ordersApi.listForUser(me!.id, status),
    enabled: !!me,
  })
}
