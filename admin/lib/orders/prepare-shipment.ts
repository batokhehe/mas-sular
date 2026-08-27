/**
 * Display helpers for the Admin "Prepare Shipment" panel.
 *
 * The panel schedules a courier PICKUP. It deliberately does not choose the
 * shipping service: the customer already chose and paid for one at checkout
 * (`Order.shippingService`), and that is what `createForOrder()` books
 * (`order.shippingService ?? shipment.service`).
 *
 * An operator-facing service selector used to exist. It was withdrawn in
 * PAXELBOX-18: it wrote `Shipment.service` but never reached Paxel, so it
 * silently disagreed with the booking, and honouring it instead would have
 * changed the service a customer paid for with no mechanism anywhere in this
 * codebase to settle the price difference. The service is therefore shown,
 * per order, read-only.
 *
 * Self-contained on purpose: `node --test` strips types but does not resolve the
 * `@/` alias, so every tested helper in this repo imports nothing.
 */

/**
 * Human label for a service code, for DISPLAY only.
 *
 * A known Paxel code gets its catalogue label; anything else — a JNE 'REG', or a
 * code this build does not know — is shown verbatim. Nothing is ever translated
 * into a Paxel service the customer did not buy.
 */
export function serviceLabel(
  service: string | null | undefined,
  options: ReadonlyArray<{ value: string; label: string }>,
): string {
  if (!service) return 'Not set';
  return options.find((option) => option.value === service)?.label ?? service;
}

/**
 * The distinct services across a selection, in first-seen order.
 *
 * A batch may legitimately mix services. Each order keeps its own — this exists
 * so the panel can say so plainly rather than implying one shared value.
 */
export function distinctServices(
  orders: ReadonlyArray<{ shippingService?: string | null }>,
): string[] {
  const seen: string[] = [];
  for (const order of orders) {
    const service = order.shippingService ?? '';
    if (!seen.includes(service)) seen.push(service);
  }
  return seen;
}
