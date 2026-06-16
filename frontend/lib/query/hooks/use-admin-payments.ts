'use client'

import { useQuery } from '@tanstack/react-query'
import { adminApi } from '@/lib/api/admin.api'
import { qk } from '@/lib/query/keys'
import { hasAdminSession } from '@/lib/auth/tokens'
import type { PaymentStatus } from '@/lib/types/enums'

export function useAdminPayments(status?: PaymentStatus) {
  return useQuery({
    queryKey: qk.admin.payments(status),
    queryFn: () => (status ? adminApi.payments(status) : adminApi.pendingPayments()),
    enabled: hasAdminSession(),
  })
}
