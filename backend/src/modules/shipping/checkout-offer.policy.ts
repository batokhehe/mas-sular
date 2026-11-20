/**
 * Customer-facing checkout offer policy: courier services that stay fully
 * integrated - quoted by their provider, bookable, tracked, webhook-handled - but
 * are not offered to customers at checkout.
 *
 * Applied ONLY at the customer boundary (OrdersService shipping options and
 * selection, and the courier-only checkout fallback in ShippingService). The
 * providers and ShippingService.getQuotes are deliberately untouched, so rate
 * retrieval, outlet allocation, admin booking and existing orders on these
 * services behave exactly as before.
 *
 * Identifiers are the domain codes the providers return (ShippingQuote.provider /
 * .service), verified against real orders - never display labels.
 */
export interface WithheldCheckoutService {
  provider: string;
  service: string;
  reason: string;
}

export const CHECKOUT_WITHHELD_SERVICES: readonly WithheldCheckoutService[] = [
  // Paxel Same Day (Paxel service_type SAMEDAY on /rates/city, label "Paxel Same Day").
  { provider: 'paxel', service: 'PAXEL_SAMEDAY', reason: 'Paxel Same Day is not offered to customers (2026-11-20)' },
];

const key = (provider: string, service: string) => `${provider.trim().toLowerCase()}::${service.trim().toUpperCase()}`;
const WITHHELD = new Set(CHECKOUT_WITHHELD_SERVICES.map((s) => key(s.provider, s.service)));

/** Whether a customer may see and select this courier service at checkout. */
export function isOfferedAtCheckout(quote: { provider?: string | null; service?: string | null }): boolean {
  if (typeof quote.provider !== 'string' || typeof quote.service !== 'string') return true;
  return !WITHHELD.has(key(quote.provider, quote.service));
}

/** The quotes a customer is shown and may choose from, in their original order. */
export function checkoutQuotes<T extends { provider?: string | null; service?: string | null }>(quotes: readonly T[]): T[] {
  return quotes.filter(isOfferedAtCheckout);
}
