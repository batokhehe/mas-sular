import type { OrderStatus, ShipmentStatus, PaymentStatus } from '@/lib/types/enums'

type Variant = 'default' | 'secondary' | 'destructive' | 'outline'

export function orderStatusVariant(status: OrderStatus): Variant {
  if (status === 'DELIVERED' || status === 'COMPLETED') return 'default'
  if (status === 'CANCELLED') return 'destructive'
  if (status === 'PENDING') return 'outline'
  return 'secondary' // PROCESSING / PACKING / SHIPPED / DELIVERING
}

export function shipmentStatusVariant(status: ShipmentStatus): Variant {
  if (status === 'DELIVERED') return 'default'
  if (status === 'FAILED') return 'destructive'
  if (status === 'PENDING' || status === 'RATE_SELECTED') return 'outline'
  return 'secondary' // PICKED_UP / IN_TRANSIT
}

export function paymentStatusVariant(status: PaymentStatus): Variant {
  if (status === 'PAID') return 'default'
  if (status === 'FAILED' || status === 'EXPIRED') return 'destructive'
  return 'secondary'
}

// Admin fulfillment progression over the (now-extended) OrderStatus enum.
export const NEXT_ORDER_STATUS: Partial<Record<OrderStatus, OrderStatus[]>> = {
  PROCESSING: ['PACKING'],
  PACKING: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
}

export const CANCELLABLE_ORDER_STATUS = new Set<OrderStatus>([
  'PENDING',
  'PROCESSING',
  'PACKING',
  'SHIPPED',
  'DELIVERING',
])

export const SHIPMENT_STATUSES: ShipmentStatus[] = [
  'PENDING',
  'RATE_SELECTED',
  'PICKED_UP',
  'IN_TRANSIT',
  'DELIVERED',
  'FAILED',
]
