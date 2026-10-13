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
  PENDING: { label: 'Menunggu', variant: 'outline' },
  RATE_SELECTED: { label: 'Menunggu pengiriman', variant: 'outline' },
  CREATED: { label: 'Pengiriman dibuat', variant: 'secondary' },
  WAITING_PICKUP: { label: 'Menunggu dijemput kurir', variant: 'secondary' },
  PICKED_UP: { label: 'Dijemput kurir', variant: 'secondary' },
  IN_TRANSIT: { label: 'Dalam perjalanan', variant: 'secondary' },
  OUT_FOR_DELIVERY: { label: 'Sedang diantar', variant: 'secondary' },
  DELIVERED: { label: 'Terkirim', variant: 'default' },
  FAILED: { label: 'Gagal dikirim', variant: 'destructive' },
  CANCELLED: { label: 'Dibatalkan', variant: 'destructive' },
  UNKNOWN: { label: 'Tidak diketahui', variant: 'outline' },
}

export function shipmentStatusLabel(status: string): { label: string; variant: BadgeVariant } {
  return Object.hasOwn(SHIPMENT_LABEL, status)
    ? SHIPMENT_LABEL[status as ShipmentStatus]
    : { label: status, variant: 'outline' }
}
