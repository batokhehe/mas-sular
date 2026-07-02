'use client'

import { useQuery } from '@tanstack/react-query'
import { authApi } from '@/lib/api/auth.api'
import { qk } from '@/lib/query/keys'
import { hasCustomerSession } from '@/lib/auth/tokens'

export function useMe() {
  const q = useQuery({
    queryKey: qk.me,
    queryFn: authApi.me,
    enabled: hasCustomerSession(),
    retry: false,
    staleTime: 5 * 60_000,
  })
  // ── TEMP RCA instrumentation — remove after verification ───────────────────
  if (typeof window !== 'undefined') {
    console.debug('[RCA useMe]', { status: q.status, fetchStatus: q.fetchStatus, addresses: q.data?.addresses?.length })
  }
  // ───────────────────────────────────────────────────────────────────────────
  return q
}
