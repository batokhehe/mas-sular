import { api } from './client'
import type {
  Order,
  CheckoutItem,
  ShippingQuote,
  VoucherPreview,
  CheckoutSummary,
} from '@/lib/types/models'
import type { PaymentMethod } from '@/lib/types/enums'

export interface CreateOrderInput {
  address_id: string
  courier: 'paxel' | 'jne'
  payment_method?: PaymentMethod
  voucher_code?: string
  items: CheckoutItem[]
}

export const ordersApi = {
  listForUser: (userId: string, status?: string) =>
    api.get<Order[]>(`/orders/users/${userId}${status ? `?status=${status}` : ''}`, 'customer'),

  // Checkout (order creation) endpoints.
  shippingCost: (body: { address_id: string; courier: string; items: CheckoutItem[] }) =>
    api.post<ShippingQuote>('/checkout/shipping-cost', body, 'customer'),
  validateVoucher: (body: { voucher_code: string; subtotal: number }) =>
    api.post<VoucherPreview>('/checkout/validate-voucher', body, 'customer'),
  summary: (body: Omit<CreateOrderInput, 'payment_method'>) =>
    api.post<CheckoutSummary>('/checkout/summary', body, 'customer'),
  createOrder: (body: CreateOrderInput, idempotencyKey: string) =>
    api.post<Order>('/checkout/order', body, 'customer', { 'Idempotency-Key': idempotencyKey }),
}
