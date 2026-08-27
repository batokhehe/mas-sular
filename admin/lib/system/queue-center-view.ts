import type { QueueHealth, QueueRelated } from '@/lib/admin';

/** Pure view helpers for the Queue Center (backend values rendered verbatim). */

export const QUEUE_TABS = ['Outbox', 'Notifications', 'RabbitMQ', 'Workers', 'Failed'] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export const HEALTH_BADGE: Record<QueueHealth, string> = {
  green: 'bg-emerald-100 text-emerald-700',
  yellow: 'bg-amber-100 text-amber-700',
  red: 'bg-red-100 text-red-700',
};
export const HEALTH_LABEL: Record<QueueHealth, string> = {
  green: 'Healthy',
  yellow: 'Degraded',
  red: 'Critical',
};

/** Status badge tone for outbox/notification rows. */
export function statusBadge(status: string): string {
  if (status === 'PUBLISHED' || status === 'SENT') return 'bg-emerald-100 text-emerald-700';
  if (status === 'FAILED') return 'bg-red-100 text-red-700';
  return 'bg-amber-100 text-amber-700'; // PENDING (incl. retrying/processing)
}

/** Human age from milliseconds: 42s / 12m / 3h / 5d. */
export function formatAge(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Clickable related links for a row's drawer (label + admin route). */
export function relatedLinks(related: QueueRelated): Array<{ label: string; href: string; id: string }> {
  const links: Array<{ label: string; href: string; id: string }> = [];
  if (related.requestId) links.push({ label: 'Request', href: `/system/requests/${encodeURIComponent(related.requestId)}`, id: related.requestId });
  if (related.orderId) links.push({ label: 'Order', href: `/orders/${related.orderId}`, id: related.orderNumber ?? related.orderId });
  if (related.paymentId) links.push({ label: 'Payment', href: '/payments', id: related.paymentId });
  if (related.shipmentId) links.push({ label: 'Shipment', href: `/shipping/${related.shipmentId}`, id: related.shipmentId });
  if (related.customerId) links.push({ label: 'Customer', href: `/users/${related.customerId}`, id: related.customerId });
  return links;
}

/** Copy/download payload for a row — pretty JSON of the full row. */
export function rowJson(row: unknown): string {
  return JSON.stringify(row, null, 2);
}
