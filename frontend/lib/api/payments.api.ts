import { api } from './client'
import type { Payment, UploadPage } from '@/lib/types/models'
import type { PublicPaymentChannel } from '@/lib/payments/channel-view'
import type { PaymentInstructionsResponse } from '@/lib/payments/gateway-types'

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

  /** Channel catalog for the checkout selector — the ONLY source of payment options. */
  channels: () => api.get<{ channels: PublicPaymentChannel[] }>('/payments/channels'),

  /**
   * Rebuild an open gateway attempt (payment page load/refresh, or "Bayar
   * Sekarang" from the order list). Read-only on the backend: it reads the stored
   * attempt and never re-charges the provider, so this is also safe to poll.
   */
  instructions: (paymentId: string) =>
    api.get<PaymentInstructionsResponse>(`/payments/${paymentId}/instructions`, 'customer'),
}
