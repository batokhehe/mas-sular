import { api } from './client'
import type {
  Order,
  CheckoutItem,
  ShippingQuote,
  ShippingOption,
  VoucherPreview,
  CheckoutSummary,
} from '@/lib/types/models'
import type { PaymentMethod } from '@/lib/types/enums'

export interface CreateOrderInput {
  address_id: string
  courier: 'paxel' | 'jne'
  shipping_provider?: string
  shipping_service?: string
  payment_method?: PaymentMethod
  /**
   * Gateway channel code from `GET /payments/channels` (QRIS, GOPAY, BCA_VA, …).
   * Only meaningful when `payment_method` is GATEWAY; the backend ignores it
   * otherwise. Declared here because checkout already sends it and the backend DTO
   * already accepts it — the type was simply missing (found in Phase 5I).
   */
  payment_channel?: string
  voucher_code?: string
  items: CheckoutItem[]
}

export const ordersApi = {
  listForUser: (userId: string, status?: string) =>
    api.get<Order[]>(`/orders/users/${userId}${status ? `?status=${status}` : ''}`, 'customer'),

  // Checkout (order creation) endpoints.
  shippingCost: (body: { address_id: string; courier: string; items: CheckoutItem[] }) =>
    api.post<ShippingQuote>('/checkout/shipping-cost', body, 'customer'),
  shippingOptions: (body: { address_id: string; items: CheckoutItem[] }) =>
    api.post<ShippingOption[]>('/checkout/shipping-options', body, 'customer'),
  validateVoucher: (body: { voucher_code: string; subtotal: number }) =>
    api.post<VoucherPreview>('/checkout/validate-voucher', body, 'customer'),
  summary: (body: CreateOrderInput) =>
    api.post<CheckoutSummary>('/checkout/summary', body, 'customer'),
  createOrder: (body: CreateOrderInput, idempotencyKey: string) =>
    api.post<Order>('/checkout/order', body, 'customer', { 'Idempotency-Key': idempotencyKey }),
}
