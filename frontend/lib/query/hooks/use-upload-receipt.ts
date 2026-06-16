'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { uploadApi } from '@/lib/api/upload.api'
import { paymentsApi } from '@/lib/api/payments.api'
import { qk } from '@/lib/query/keys'

type Mode = 'token' | 'auth'

interface UploadVars {
  file: File
  bankName?: string
  accountName?: string
}

/**
 * Two-step receipt submission: upload the image to an app-owned URL, then submit
 * the receipt referencing that URL. `ref` is the token (mode='token') or the
 * paymentId (mode='auth').
 */
export function useUploadReceipt(mode: Mode, ref: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ file, bankName, accountName }: UploadVars) => {
      const { url } =
        mode === 'token'
          ? await uploadApi.tokenReceiptFile(ref, file)
          : await uploadApi.receiptFile(ref, file)
      const body = { receiptUrl: url, bankName, accountName }
      return mode === 'token'
        ? paymentsApi.submitByToken(ref, body)
        : paymentsApi.submitManual(ref, body)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] })
      if (mode === 'token') qc.invalidateQueries({ queryKey: qk.uploadPage(ref) })
    },
  })
}
