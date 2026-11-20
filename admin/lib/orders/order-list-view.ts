/**
 * Admin order list presentation - PURE (no React) so node --test can load it.
 *
 * - Order status and payment status each get their own colored badge, with an
 *   explicit tone for every status the backend defines (OrderStatus / PaymentStatus
 *   in backend/prisma/schema.prisma). A status this build does not know falls back
 *   to the neutral tone and its raw value (status-labels.ts shows unknown values as-is).
 * - The courier column shows what the order actually carries: the booked shipment's
 *   provider, else the courier chosen at checkout. Nothing is guessed: an order with
 *   neither shows a dash.
 */
// Self-contained at runtime (node --test loads this file directly): the existing
// label sources - status-labels.ts and promo-payload's COURIER_LABELS - are passed in
// by the caller instead of imported, so there is still a single source of wording.
type LabelOf = (value: string | null | undefined) => string;

export type StatusTone = 'success' | 'danger' | 'neutral' | 'brand' | 'warning' | 'info';

export const ORDER_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  PENDING: 'warning',
  PROCESSING: 'info',
  PACKING: 'info',
  SHIPPED: 'brand',
  DELIVERING: 'brand',
  DELIVERED: 'success',
  COMPLETED: 'success',
  CANCELLED: 'danger',
};

export const PAYMENT_STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  PENDING: 'warning',
  WAITING_VERIFICATION: 'info',
  PAID: 'success',
  FAILED: 'danger',
  EXPIRED: 'neutral',
  REFUNDED: 'brand',
};

export interface StatusBadgeView {
  label: string;
  tone: StatusTone;
}

const toneFor = (map: Readonly<Record<string, StatusTone>>, value: string | null | undefined): StatusTone =>
  value && Object.hasOwn(map, value) ? map[value] : 'neutral';

export function orderStatusBadge(status: string | null | undefined, labelOf: LabelOf): StatusBadgeView {
  return { label: labelOf(status), tone: toneFor(ORDER_STATUS_TONES, status) };
}

/** No payment row yet (e.g. a legacy order): a neutral badge, never a made-up status. */
export function paymentStatusBadge(status: string | null | undefined, labelOf: LabelOf): StatusBadgeView {
  if (!status) return { label: 'Belum ada pembayaran', tone: 'neutral' };
  return { label: labelOf(status), tone: toneFor(PAYMENT_STATUS_TONES, status) };
}

export interface CourierSource {
  shippingProvider?: string | null;
  shippingService?: string | null;
  shippingServiceName?: string | null;
  shipment?: { provider?: string | null; service?: string | null } | null;
}

export interface CourierView {
  /** "JNE", "Paxel", another provider name as recorded, or "—". */
  courier: string;
  /** Service as quoted at checkout (label first), else the shipment's; null when none. Never another courier's. */
  service: string | null;
}

const present = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/** Display name from the known-courier labels (keyed lower-case); an unlisted provider is shown as recorded. */
export function courierLabel(provider: string | null | undefined, labels: Readonly<Record<string, string>>): string {
  if (!present(provider)) return '—';
  const key = provider.trim().toLowerCase();
  return Object.hasOwn(labels, key) ? labels[key] : provider.trim();
}

export function orderCourier(order: CourierSource, labels: Readonly<Record<string, string>>): CourierView {
  const provider = present(order.shipment?.provider) ? order.shipment!.provider : order.shippingProvider;
  if (!present(provider)) return { courier: '—', service: null };
  // The checkout service belongs to the checkout courier: only use it when the
  // shipment was booked with that same courier.
  const sameCourier = !present(order.shippingProvider) || order.shippingProvider.trim().toLowerCase() === provider.trim().toLowerCase();
  const candidates = sameCourier ? [order.shippingServiceName, order.shippingService, order.shipment?.service] : [order.shipment?.service];
  const service = candidates.find(present) ?? null;
  return { courier: courierLabel(provider, labels), service: service ? service.trim() : null };
}
