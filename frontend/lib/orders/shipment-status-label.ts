import type { ShipmentStatus } from '@/lib/types/enums'

/**
 * Customer-facing shipment badge on /orders. PURE (no React) so node --test can load it.
 *
 * Every backend ShipmentStatus has a label here - the Record type makes a missing one
 * a compile error. `shipmentStatusLabel` still answers for a value this build has
 * never seen (a status added to the API later): it shows that value as-is instead of
 * throwing, which is what took the whole /orders page down for a CREATED shipment.
 */

export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline'

export const SHIPMENT_LABEL: Record<ShipmentStatus, { label: string; variant: BadgeVariant }> = {
  PENDING: { label: 'Pending', variant: 'outline' },
  RATE_SELECTED: { label: 'Rate selected', variant: 'outline' },
  CREATED: { label: 'Booked', variant: 'secondary' },
  WAITING_PICKUP: { label: 'Awaiting pickup', variant: 'secondary' },
  PICKED_UP: { label: 'Picked up', variant: 'secondary' },
  IN_TRANSIT: { label: 'In transit', variant: 'secondary' },
  OUT_FOR_DELIVERY: { label: 'Out for delivery', variant: 'secondary' },
  DELIVERED: { label: 'Delivered', variant: 'default' },
  FAILED: { label: 'Failed', variant: 'destructive' },
  CANCELLED: { label: 'Cancelled', variant: 'destructive' },
  UNKNOWN: { label: 'Status unavailable', variant: 'outline' },
}

export function shipmentStatusLabel(status: string): { label: string; variant: BadgeVariant } {
  return Object.hasOwn(SHIPMENT_LABEL, status)
    ? SHIPMENT_LABEL[status as ShipmentStatus]
    : { label: status, variant: 'outline' }
}
