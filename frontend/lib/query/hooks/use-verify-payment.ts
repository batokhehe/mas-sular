'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { adminApi } from '@/lib/api/admin.api'
import { qk } from '@/lib/query/keys'

// Feedback (success/error) is presented by the calling admin page via SweetAlert,
// so this hook only performs the mutation + cache invalidation and opts out of the
// global error toast.
export function useVerifyPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => adminApi.verifyPayment(id, note),
    meta: { suppressGlobalError: true },
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['admin', 'payments'] })
      qc.invalidateQueries({ queryKey: qk.admin.order(id) })
    },
  })
}
