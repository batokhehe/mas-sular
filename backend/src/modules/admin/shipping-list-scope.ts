import { OrderStatus, Prisma, ShipmentStatus } from '@prisma/client';

/**
 * Admin → Shipping list: only shipments that still need shipping work or are still
 * on their way. Presentation-only scope for that list - nothing is changed, deleted or
 * hidden anywhere else (Orders, dashboards, shipment detail pages and the default
 * GET /admin/shipments answer are untouched).
 *
 * A shipment leaves the list when EITHER side is final:
 *   - its own status is terminal-done: DELIVERED, CANCELLED;
 *   - its order is final: DELIVERED (may only become COMPLETED), COMPLETED, or
 *     CANCELLED. An expired payment cancels the order (OrderCancellationService) but
 *     never touches Shipment.status, so the order status is what keeps a cancelled or
 *     expired order's shipment out of the list.
 *
 * Deliberately KEPT (still needs someone's attention): FAILED (the courier gave up,
 * e.g. RETURN TO SHIPPER - an admin must re-ship or resolve it) and UNKNOWN (never
 * silently treated as done). Exclusion is by `notIn`, so a ShipmentStatus added later
 * shows up here until someone decides otherwise.
 *
 * One shipment per order (Shipment.orderId is @unique), so a terminal historical
 * shipment can never hide another, active one.
 */
export const SHIPPING_LIST_ACTIVE_SCOPE = 'active' as const;

export const SHIPPING_EXCLUDED_SHIPMENT_STATUSES: readonly ShipmentStatus[] = [ShipmentStatus.DELIVERED, ShipmentStatus.CANCELLED];

export const SHIPPING_EXCLUDED_ORDER_STATUSES: readonly OrderStatus[] = [OrderStatus.DELIVERED, OrderStatus.COMPLETED, OrderStatus.CANCELLED];

/** Every shipment status the active Shipping list can contain (derived, never re-typed). */
export const SHIPPING_ACTIVE_SHIPMENT_STATUSES: readonly ShipmentStatus[] = (Object.values(ShipmentStatus) as ShipmentStatus[]).filter(
  (status) => !SHIPPING_EXCLUDED_SHIPMENT_STATUSES.includes(status),
);

/** Prisma filter for the active Shipping list. */
export function activeShippingWhere(): Prisma.ShipmentWhereInput {
  return {
    status: { notIn: [...SHIPPING_EXCLUDED_SHIPMENT_STATUSES] },
    order: { status: { notIn: [...SHIPPING_EXCLUDED_ORDER_STATUSES] } },
  };
}
