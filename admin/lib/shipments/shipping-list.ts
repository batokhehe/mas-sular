import { shipmentServiceSearchTerms, type ShipmentServiceSource } from './service-display';

/**
 * Admin → Shipping list: only shipments that still need shipping work or are still
 * on their way. The SERVER applies the rule (GET /admin/shipments?scope=active, see
 * backend/src/modules/admin/shipping-list-scope.ts), so paging and totals stay
 * correct; this module is the admin side of the same rule (the status dropdown) and
 * the list's search predicate. Nothing else in the admin uses it.
 */
export const SHIPPING_LIST_SCOPE = 'active' as const;

/** The backend ShipmentStatus enum, in its declared order (pinned against schema.prisma by the tests). */
export const SHIPMENT_STATUSES = [
  'PENDING',
  'RATE_SELECTED',
  'CREATED',
  'WAITING_PICKUP',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
] as const;
export type ShipmentStatusValue = (typeof SHIPMENT_STATUSES)[number];

/** Finished shipments: never in the Shipping list (the server also drops final orders). */
export const EXCLUDED_SHIPPING_STATUSES: readonly ShipmentStatusValue[] = ['DELIVERED', 'CANCELLED'];

/** Shipment statuses the Shipping list can contain - FAILED and UNKNOWN included on purpose. */
export const ACTIVE_SHIPPING_STATUSES: readonly ShipmentStatusValue[] = SHIPMENT_STATUSES.filter(
  (status) => !EXCLUDED_SHIPPING_STATUSES.includes(status),
);

/** Status dropdown of the Shipping list: "all active", then each active status. */
export const SHIPPING_STATUS_FILTER_OPTIONS = ['ALL', ...ACTIVE_SHIPPING_STATUSES] as const;
export type ShippingStatusFilter = (typeof SHIPPING_STATUS_FILTER_OPTIONS)[number];

type SearchableShipment = ShipmentServiceSource & {
  provider: string;
  trackingNumber?: string | null;
  order: { orderNumber: string } & NonNullable<ShipmentServiceSource['order']>;
};

/**
 * The list's free-text search (client-side over the page the server returned):
 * order number, provider, every service representation, AWB. Case-insensitive.
 */
export function matchesShipmentSearch(shipment: SearchableShipment, search: string): boolean {
  const needle = search.toLowerCase();
  return [
    shipment.order.orderNumber,
    shipment.provider,
    // Search every representation: legacy rows hold a label, the order
    // holds the paid code. Read-time compatibility, never a migration.
    ...shipmentServiceSearchTerms(shipment),
    shipment.trackingNumber ?? '',
  ].some((field) => field.toLowerCase().includes(needle));
}
