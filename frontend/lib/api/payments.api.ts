import { api } from './client'
import type { Payment, UploadPage } from '@/lib/types/models'

export interface ReceiptBody {
  receiptUrl: string
  bankName?: string
  accountName?: string
}

export const paymentsApi = {
  // Tokenized (anonymous link) flow
  uploadPage: (token: string) => api.get<UploadPage>(`/payments/upload/${token}`),
  submitByToken: (token: string, body: ReceiptBody) =>
    api.post<Payment>(`/payments/upload/${token}`, body),

  // Authenticated (logged-in) flow
  submitManual: (paymentId: string, body: ReceiptBody) =>
    api.post<Payment>(`/payments/${paymentId}/manual-receipt`, body, 'customer'),
}
