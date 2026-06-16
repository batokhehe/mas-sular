import { api, buildQuery } from './client'
import type { Order, Payment, Shipment } from '@/lib/types/models'
import type { OrderStatus, PaymentStatus, ShipmentStatus } from '@/lib/types/enums'

export const adminApi = {
  dashboard: () => api.get<unknown>('/admin/dashboard', 'admin'),

  orders: (q: { status?: OrderStatus; paymentStatus?: PaymentStatus } = {}) =>
    api.get<Order[]>(`/admin/orders${buildQuery(q)}`, 'admin'),
  order: (id: string) => api.get<Order>(`/admin/orders/${id}`, 'admin'),
  updateOrderStatus: (id: string, body: { status: OrderStatus; note?: string }) =>
    api.patch<Order>(`/admin/orders/${id}/status`, body, 'admin'),

  payments: (status?: PaymentStatus) =>
    api.get<Payment[]>(`/admin/payments${status ? `?status=${status}` : ''}`, 'admin'),
  pendingPayments: () => api.get<Payment[]>('/admin/payments/pending-verification', 'admin'),
  verifyPayment: (id: string, note?: string) =>
    api.patch<Payment>(`/admin/payments/${id}/verify`, { note }, 'admin'),
  rejectPayment: (id: string, note?: string) =>
    api.patch<Payment>(`/admin/payments/${id}/reject`, { note }, 'admin'),

  shipments: (status?: ShipmentStatus) =>
    api.get<Shipment[]>(`/admin/shipments${status ? `?status=${status}` : ''}`, 'admin'),
  shipment: (id: string) => api.get<Shipment>(`/admin/shipments/${id}`, 'admin'),
  createShipment: (body: Record<string, unknown>) => api.post<Shipment>('/admin/shipments', body, 'admin'),
  updateShipment: (id: string, body: Record<string, unknown>) =>
    api.patch<Shipment>(`/admin/shipments/${id}`, body, 'admin'),
  deleteShipment: (id: string) => api.del<void>(`/admin/shipments/${id}`, 'admin'),
}
