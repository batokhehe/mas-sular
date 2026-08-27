/**
 * Which service to SHOW for a shipment row.
 *
 * `Shipment.service` is a snapshot, not the authority. Checkout writes the
 * display label into it ("Paxel Same Day"), while the service the customer
 * actually chose and paid for lives on the order — as a human label in
 * `Order.shippingServiceName` and as a machine code in `Order.shippingService`.
 *
 * The precedence below is the same one the backend already uses for the
 * order.shipped notification, reused rather than reinvented. The final fallback
 * to the shipment's own value is what keeps HISTORICAL rows readable without
 * migrating them: an old shipment whose order predates these fields still
 * renders exactly what it always did.
 *
 * Self-contained on purpose: `node --test` strips types but does not resolve the
 * `@/` alias, so every tested helper in this repo imports nothing.
 */

export interface ShipmentServiceSource {
  service?: string | null;
  order?: { shippingServiceName?: string | null; shippingService?: string | null } | null;
}

export function shipmentServiceDisplay(shipment: ShipmentServiceSource): string {
  return (
    shipment.order?.shippingServiceName ||
    shipment.order?.shippingService ||
    shipment.service ||
    '-'
  );
}

/**
 * Every representation a row can legitimately be searched by.
 *
 * Legacy rows hold a label, newer ones a code, and the order carries both — so
 * matching is done across all of them at READ time. That is deliberately a
 * compatibility strategy, not a migration: no stored row is rewritten.
 */
export function shipmentServiceSearchTerms(shipment: ShipmentServiceSource): string[] {
  return [
    shipment.order?.shippingServiceName ?? '',
    shipment.order?.shippingService ?? '',
    shipment.service ?? '',
  ].filter((term) => term.length > 0);
}
