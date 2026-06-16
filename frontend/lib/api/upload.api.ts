import { api } from './client'
import type { UploadResult } from '@/lib/types/models'

function fileForm(file: File): FormData {
  const form = new FormData()
  form.append('file', file)
  return form
}

export const uploadApi = {
  // Anonymous, token-gated receipt image upload → returns an app-owned URL.
  tokenReceiptFile: (token: string, file: File) =>
    api.upload<UploadResult>(`/payments/upload/${token}/file`, fileForm(file)),

  // Authenticated, owner-scoped receipt image upload → returns an app-owned URL.
  receiptFile: (paymentId: string, file: File) =>
    api.upload<UploadResult>(`/payments/${paymentId}/manual-receipt/file`, fileForm(file), 'customer'),
}
