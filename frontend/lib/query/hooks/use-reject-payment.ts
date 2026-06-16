'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { adminApi } from '@/lib/api/admin.api'
import { qk } from '@/lib/query/keys'

export function useRejectPayment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, note }: { id: string; note?: string }) => adminApi.rejectPayment(id, note),
    onSuccess: (_data, { id }) => {
      toast.success('Payment rejected')
      qc.invalidateQueries({ queryKey: ['admin', 'payments'] })
      qc.invalidateQueries({ queryKey: qk.admin.order(id) })
    },
  })
}
