'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { addressesApi, type AddressInput, type AddressUpdate } from '@/lib/api/addresses.api'
import { qk } from '@/lib/query/keys'
import { hasCustomerSession } from '@/lib/auth/tokens'

export function useAddresses() {
  const q = useQuery({
    queryKey: qk.addresses,
    queryFn: addressesApi.list,
    enabled: hasCustomerSession(),
  })
  // ── TEMP RCA instrumentation — remove after verification ───────────────────
  if (typeof window !== 'undefined') {
    console.debug('[RCA useAddresses]', { enabled: hasCustomerSession(), status: q.status, fetchStatus: q.fetchStatus, length: q.data?.length })
  }
  // ───────────────────────────────────────────────────────────────────────────
  return q
}

function useAddressInvalidate() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: qk.addresses })
    qc.invalidateQueries({ queryKey: qk.me }) // checkout reads me.addresses
  }
}

export function useCreateAddress() {
  const invalidate = useAddressInvalidate()
  return useMutation({
    mutationFn: (body: AddressInput) => addressesApi.create(body),
    onSuccess: () => {
      toast.success('Address added')
      invalidate()
    },
  })
}

export function useUpdateAddress() {
  const invalidate = useAddressInvalidate()
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: AddressUpdate }) => addressesApi.update(id, body),
    onSuccess: () => {
      toast.success('Address updated')
      invalidate()
    },
  })
}

export function useDeleteAddress() {
  const invalidate = useAddressInvalidate()
  return useMutation({
    mutationFn: (id: string) => addressesApi.remove(id),
    onSuccess: () => {
      toast.success('Address removed')
      invalidate()
    },
  })
}
