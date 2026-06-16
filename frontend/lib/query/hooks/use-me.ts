'use client'

import { useQuery } from '@tanstack/react-query'
import { authApi } from '@/lib/api/auth.api'
import { qk } from '@/lib/query/keys'
import { hasCustomerSession } from '@/lib/auth/tokens'

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: authApi.me,
    enabled: hasCustomerSession(),
    retry: false,
    staleTime: 5 * 60_000,
  })
}
