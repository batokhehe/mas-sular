import { api } from './client'

/** P2 #14: the customer-safe invoice the backend returns for a tokenized link. */
export interface CustomerInvoice {
  store: { name: string }
  orderNumber: string
  orderDate: string
  orderStatus: string
  items: Array<{
    name: string
    quantity: number
    unitPrice: number
    toppings: Array<{ name: string; price: number }>
    spicyLevel: number | null
    notes: string | null
    lineTotal: number
  }>
  subtotal: number
  discount: number
  voucherCode: string | null
  shippingCost: number
  /** Customer-charged "Biaya Layanan" (Rp0 when the merchant absorbs it). */
  paymentServiceFee: number
  /** Gateway orders show the "Biaya Layanan" row even at Rp0. */
  paymentServiceFeeApplies?: boolean
  total: number
  payment: { method: string; status: string | null; amountDue: number; uniqueCode: number | null }
  shipping: { courier: string | null; service: string | null; status: string | null; trackingNumber: string | null }
  delivery: { recipientName: string; phone: string; address: string }
}

export const invoicesApi = {
  // Public: no login - the token in the path is the only credential.
  get: (token: string) => api.get<CustomerInvoice>(`/invoices/${encodeURIComponent(token)}`, 'public'),
}
